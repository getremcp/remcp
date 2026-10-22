import os from 'node:os';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { VERSION } from './version.mjs';
import { localRuntimeEntry } from './agent-update.mjs';

export { localRuntimeEntry, supervisorRestart, updateDecision } from './agent-update.mjs';
import { normalizedServerUrl, sendRelayMessage, jitter, deviceMetrics } from './agent-utilities.mjs';
import { createAgentUpdateMonitor, UPDATE_CHECK_INTERVAL_MS } from './agent-update-monitor.mjs';
import { createAgentResponder } from './agent-responder.mjs';
import { createAgentRelayConnection } from './agent-relay-connection.mjs';
import { createRuntimeCapabilities, normalizeRuntimeToolNames } from './agent-runtime-capabilities.mjs';

const METRICS_INTERVAL_MS = 5 * 60_000;
const TELEMETRY_QUEUE_LIMIT = 500;
const TELEMETRY_BATCH_LIMIT = 100;
const TELEMETRY_SEND_INTERVAL_MS = 5_000;
// Must stay above the runtime's own output ceiling (8 MiB), otherwise a large but legal tool result
// closes the stdio connection and restarts the runtime mid-call.
const RUNTIME_STDIO_BUFFER_BYTES = 24 * 1024 * 1024;
const RUNTIME_RESTART_BASE_MS = 1_000;
const RUNTIME_RESTART_MAX_MS = 30_000;
// Below the relay's RPC timeout so the model gets a real error instead of a client-side
// timeout while the device keeps working invisibly.
const CALL_TIMEOUT_MARGIN_MS = 10_000;

export async function runAgent(options) {
  const serverUrl = normalizedServerUrl(options.serverUrl, { allowInsecure: options.allowInsecureTransport === true || process.env.REMCP_ALLOW_INSECURE_TRANSPORT === 'true' });
  const deviceToken = String(options.deviceToken || '');
  const deviceId = String(options.deviceId || '');
  const deviceName = String(options.deviceName || os.hostname());
  if (!serverUrl || !deviceToken || !deviceId) throw new Error('serverUrl, deviceToken and deviceId are required');
  const agentUrl = serverUrl.replace(/^http/, 'ws') + '/agent';
  const callTimeoutMs = Math.max(5_000, Number(options.rpcTimeoutMs || 120000) - CALL_TIMEOUT_MARGIN_MS);
  const telemetryEnabled = options.telemetryEnabled !== false;
  const metricsIntervalMs = Math.max(60_000, Number(options.metricsIntervalMs || process.env.REMCP_AGENT_METRICS_INTERVAL_MS) || METRICS_INTERVAL_MS);
  const persistState = typeof options.persistState === 'function' ? options.persistState : () => {};
  let stopping = false;
  const inFlight = new Map();
  let activeSocket;
  let reconnects = 0;
  let pendingRequests = 0;
  let runtimeVersion = 'unknown';
  let runtimeRestarts = 0;
  let runtimeDown = false;
  let runtimeTools = [];
  // The reason the runtime is not running, sent to the server so the workspace can show something
  // actionable instead of a machine that merely looks connected.
  let runtimeError = '';
  const telemetryQueue = [];
  let telemetryTimer = null;
  let lastMetricsSentAt = 0;
  // A device whose runtime is missing or unreadable must still run the agent: the agent is what
  // installs and repairs the runtime, so failing here would remove the only path back.
  let runtimeEntry = '';
  try {
    runtimeEntry = localRuntimeEntry(options.runtime);
  } catch (error) {
    runtimeDown = true;
    runtimeError = error instanceof Error ? error.message : String(error);
    console.error(`${runtimeError} The agent keeps running and retries; remcp update reinstalls the runtime.`);
  }

  // --- local runtime supervision ------------------------------------------------------
  // If the runtime dies (a bad shell, a broken pipe, an OOM) the agent used to stay
  // "online" forever and every later call failed with an opaque "Not connected". Now the
  // transport is watched and the runtime is restarted with backoff.
  let mcp = null;
  let transport = null;
  let runtimeRestartDelay = RUNTIME_RESTART_BASE_MS;
  let runtimeRestartTimer = null;
  let stopPromise = null;

  function runtimeEnv() {
    // The SDK's stdio transport does not inherit the environment by default; spreading
    // process.env here is what gives the runtime its REMCP_RUNTIME_* configuration, PATH,
    // HOME and the telemetry opt-out.
    const env = { ...process.env };
    // The paired agent is the trusted local launcher. Keep standalone runtimes fail-closed,
    // while explicitly enabling browser control for runtimes spawned by an authenticated device.
    if (!Object.hasOwn(env, 'REMCP_BROWSER_REMOTE_ENABLED')) env.REMCP_BROWSER_REMOTE_ENABLED = '1';
    if (!telemetryEnabled) env.REMCP_RUNTIME_DISABLE_TELEMETRY = '1';
    return env;
  }

  const runtimeCapabilities = createRuntimeCapabilities({
    getTools: () => runtimeTools,
    setTools: next => { runtimeTools = next; },
    isActive: client => !stopping && !runtimeDown && mcp === client,
    announce: next => send({ type: 'capabilities', runtimeTools: next }),
    jitter,
  });
  const refreshRuntimeTools = (client = mcp, options) => runtimeCapabilities.refresh(client, options);

  async function startRuntime() {
    if (stopping) return;
    clearTimeout(runtimeRestartTimer);
    runtimeRestartTimer = null;
    runtimeCapabilities.clearRetry();
    runtimeDown = true;
    const previous = mcp;
    mcp = null;
    if (previous) await previous.close().catch(error => console.error('Runtime cleanup failed:', error.message));
    if (stopping) return;
    try { runtimeEntry = localRuntimeEntry(options.runtime); }
    catch (error) {
      runtimeError = error.message;
      handleRuntimeExit('missing');
      return;
    }
    let client;
    client = new Client(
      { name: 'remcp-agent', version: VERSION },
      {
        versionNegotiation:{ mode:'auto' },
        // MCP 2026-07-28 list changes are subscription-based. Without this, a runtime can gain
        // tools (for example when browser CDP appears) while the paired agent keeps publishing its
        // old capability snapshot. Legacy runtimes are still covered by fallbackNotificationHandler.
        listChanged:{
          tools:{
            autoRefresh:true,
            debounceMs:0,
            onChanged(error, tools) {
              if (error) {
                console.error(`ReMCP runtime tool subscription failed: ${error instanceof Error ? error.message : String(error)}`);
                runtimeCapabilities.scheduleRetry(client);
                return;
              }
              if (mcp !== client || runtimeDown || stopping) return;
              runtimeCapabilities.apply(normalizeRuntimeToolNames({ tools }));
            },
          },
        },
      },
    );
    const stdio = new StdioClientTransport({ command: process.execPath, args: [runtimeEntry], env: runtimeEnv(), maxBufferSize: RUNTIME_STDIO_BUFFER_BYTES });
    mcp = client;
    transport = stdio;
    client.fallbackNotificationHandler = async notification => {
      if (notification?.method === 'notifications/tools/list_changed') {
        await refreshRuntimeTools(client);
        return;
      }
      if (!telemetryEnabled) return;
      if (notification?.method !== 'notifications/remcp/telemetry') return;
      const events = Array.isArray(notification.params?.events) ? notification.params.events : [];
      if (!events.length) return;
      if (notification.params?.runtimeVersion) runtimeVersion = String(notification.params.runtimeVersion);
      for (const event of events) {
        if (telemetryQueue.length >= TELEMETRY_QUEUE_LIMIT) telemetryQueue.shift();
        telemetryQueue.push(event);
      }
    };
    client.onclose = () => { if (mcp === client) handleRuntimeExit('closed'); };
    stdio.onerror = error => console.error(`ReMCP local runtime error: ${error instanceof Error ? error.message : String(error)}`);
    try {
      await client.connect(stdio);
      if (stopping || mcp !== client) { await client.close(); return; }
      runtimeVersion = client.getServerVersion()?.version || runtimeVersion;
      runtimeRestarts += 1;
      runtimeRestartDelay = RUNTIME_RESTART_BASE_MS;
      runtimeDown = false;
      runtimeError = '';
      await refreshRuntimeTools(client);
      console.log(`ReMCP local runtime ready (${runtimeVersion})`);
      send({ type: 'metrics', runtimeState: 'ready', runtimeError: '', metrics: deviceMetrics({ reconnects, pendingRequests, runtimeVersion, runtimeRestarts, runtimeDown: false }) });
      if (runtimeRestarts > 1) queueEvent({ event: 'runtime_restart', at: Date.now(), count: runtimeRestarts, success: true });
    } catch (error) {
      runtimeDown = true;
      runtimeError = error instanceof Error ? error.message : String(error);
      console.error(`ReMCP local runtime failed to start: ${runtimeError}`);
      handleRuntimeExit('failed');
    }
  }

  function handleRuntimeExit(reason) {
    if (stopping || runtimeRestartTimer) return;
    runtimeCapabilities.clearRetry();
    runtimeDown = true;
    runtimeTools = [];
    send({ type: 'capabilities', runtimeTools });
    const delay = jitter(runtimeRestartDelay);
    runtimeRestartDelay = Math.min(RUNTIME_RESTART_MAX_MS, runtimeRestartDelay * 2);
    console.error(`ReMCP local runtime ${reason}; restarting in ${delay}ms`);
    queueEvent({ event: 'runtime_down', at: Date.now(), reason: reason.slice(0, 24) });
    send({ type: 'metrics', runtimeState: 'down', runtimeError, metrics: deviceMetrics({ reconnects, pendingRequests, runtimeVersion, runtimeRestarts, runtimeDown: true }) });
    runtimeRestartTimer = setTimeout(() => { void startRuntime(); }, delay);
    runtimeRestartTimer.unref?.();
  }

  // --- relay connection ---------------------------------------------------------------
  function send(message) {
    return sendRelayMessage(activeSocket, message);
  }

  function flushTelemetry() {
    if (!telemetryEnabled || !telemetryQueue.length) return;
    const batch = telemetryQueue.splice(0, TELEMETRY_BATCH_LIMIT);
    if (!send({ type: 'telemetry', runtimeVersion, agentVersion: VERSION, events: batch })) telemetryQueue.unshift(...batch);
  }

  function sendMetricsSample({ force = false } = {}) {
    if (activeSocket?.readyState !== 1) return false;
    const at = Date.now();
    // Reconnects during a deploy reuse the same agent process. Do not turn every socket move into
    // another PostgreSQL metrics write; the regular jittered sample is enough.
    if (!force && lastMetricsSentAt && at - lastMetricsSentAt < Math.floor(metricsIntervalMs / 2)) return false;
    const sent = send({ type: 'metrics', runtimeState: runtimeDown ? 'down' : 'ready', runtimeError, metrics: deviceMetrics({ reconnects, pendingRequests, runtimeVersion, runtimeRestarts, runtimeDown, queueDepth: telemetryQueue.length }) });
    if (sent) lastMetricsSentAt = at;
    return sent;
  }

  function scheduleMetricsSample() {
    if (stopping) return;
    telemetryTimer = setTimeout(() => {
      telemetryTimer = null;
      sendMetricsSample();
      flushTelemetry();
      scheduleMetricsSample();
    }, jitter(metricsIntervalMs));
    telemetryTimer.unref?.();
  }

  function queueEvent(event) {
    if (!telemetryEnabled) return;
    if (telemetryQueue.length >= TELEMETRY_QUEUE_LIMIT) telemetryQueue.shift();
    telemetryQueue.push(event);
  }

  function reportInstallOnce() {
    if (!telemetryEnabled || options.installReported === true) return;
    if (send({
      type: 'install',
      agentVersion: VERSION,
      runtimeVersion,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      installSpec: String(options.installSpec || ''),
      runtimeState: runtimeDown ? 'down' : 'ready',
    })) {
      persistState({ installReported: true });
      console.log('ReMCP reported this installation to your own workspace (disable with `remcp telemetry off`).');
    }
  }

  const respond = createAgentResponder({
    inFlight,
    onPendingChange: delta => { pendingRequests = Math.max(0, pendingRequests + delta); },
    getRuntimeState: () => ({ mcp, runtimeDown, runtimeVersion, runtimeRestarts, callTimeoutMs }),
  });
  const { checkForUpdate, clearPostConnectUpdateChecks, schedulePostConnectUpdateChecks } = createAgentUpdateMonitor({
    options, serverUrl, queueEvent,
    getRuntimeState: () => ({ runtimeVersion, runtimeDown }),
    onStopRequested: () => { stopping = true; },
    isStopping: () => stopping,
    stop,
    restartRuntime: async () => {
      // Rebuild the supervised runtime against the freshly installed exact release.
      runtimeRestartDelay = RUNTIME_RESTART_BASE_MS;
      runtimeDown = false;
      runtimeError = '';
      try {
        runtimeEntry = localRuntimeEntry(options.runtime);
      } catch (error) {
        runtimeDown = true;
        runtimeError = error instanceof Error ? error.message : String(error);
      }
      if (!runtimeDown && !stopping) await startRuntime();
    },
  });

  const { connect, clearReconnect } = createAgentRelayConnection({
    agentUrl, serverUrl, deviceToken, deviceId, deviceName,
    isStopping: () => stopping,
    markStopping: () => { stopping = true; },
    getReconnects: () => reconnects,
    setReconnects: count => { reconnects = count; },
    setSocket: socket => { activeSocket = socket; },
    getHelloState: () => ({
      runtimeVersion,
      runtimeState: runtimeDown ? 'down' : 'ready',
      runtimeError,
      runtimeTools,
      telemetryEnabled,
    }),
    respond, inFlight, sendMetricsSample, reportInstallOnce, flushTelemetry,
    checkForUpdate, schedulePostConnectUpdateChecks, clearPostConnectUpdateChecks, stop,
  });

  scheduleMetricsSample();
  const telemetryFlushTimer = setInterval(flushTelemetry, TELEMETRY_SEND_INTERVAL_MS);
  telemetryFlushTimer.unref?.();
  const updateTimer = setInterval(() => void checkForUpdate(), UPDATE_CHECK_INTERVAL_MS);
  updateTimer.unref?.();

  async function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearTimeout(runtimeRestartTimer);
    runtimeCapabilities.clearRetry();
    clearReconnect();
    clearPostConnectUpdateChecks();
    if (telemetryTimer) clearTimeout(telemetryTimer);
    clearInterval(telemetryFlushTimer);
    clearInterval(updateTimer);
    for (const controller of inFlight.values()) controller.abort();
    activeSocket?.terminate();
    stopPromise = Promise.allSettled([mcp?.close(), transport?.close()]).then(results => {
      for (const result of results) if (result.status === 'rejected') console.error('Agent cleanup failed:', result.reason?.message || 'unknown error');
    });
    return stopPromise;
  }

  process.once('SIGINT', () => void stop().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void stop().finally(() => process.exit(0)));
  await startRuntime();
  connect();
  return { stop, runtimeVersion: () => runtimeVersion, runtimeRestarts: () => runtimeRestarts, isRuntimeDown: () => runtimeDown };
}
