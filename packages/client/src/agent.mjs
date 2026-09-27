import os from 'node:os';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { VERSION } from './version.mjs';
import {
  globalCliEntry,
  globalInstalledVersion,
  isNewer,
  localRuntimeEntry,
  restartToApplyUpdate,
  supervisorRestart,
  updateDecision,
  updateInvocationArgs,
} from './agent-update.mjs';

export { localRuntimeEntry, supervisorRestart, updateDecision } from './agent-update.mjs';

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 5000;
// A deployment can briefly leave one HA replica advertising the previous release. Recheck a few
// times after a stable connection instead of making that unlucky first answer stick for six hours.
const POST_CONNECT_UPDATE_RECHECK_DELAYS_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000]);
const POST_CONNECT_UPDATE_RECHECK_JITTER_MS = 30_000;
// A version that failed to install is retried after this cooldown instead of on every reconnect.
const UPDATE_RETRY_COOLDOWN_MS = 30 * 60 * 1000;
const METRICS_INTERVAL_MS = 5 * 60_000;
const TELEMETRY_QUEUE_LIMIT = 500;
const TELEMETRY_BATCH_LIMIT = 100;
const TELEMETRY_SEND_INTERVAL_MS = 5_000;
const RECONNECT_BASE_MS = 2_000;
// The first retry after an unexpected drop: fast enough that a blip is invisible, slow enough not to
// hammer a server that is genuinely down.
const RECONNECT_FIRST_MS = 500;
// Must stay above the runtime's own output ceiling (8 MiB), otherwise a large but legal tool result
// closes the stdio connection and restarts the runtime mid-call.
const RUNTIME_STDIO_BUFFER_BYTES = 24 * 1024 * 1024;
const RECONNECT_MAX_MS = 60_000;
const RUNTIME_RESTART_BASE_MS = 1_000;
const RUNTIME_RESTART_MAX_MS = 30_000;
const RUNTIME_TOOLS_RETRY_BASE_MS = 1_000;
const RUNTIME_TOOLS_RETRY_MAX_MS = 30_000;
// Below the relay's RPC timeout so the model gets a real error instead of a client-side
// timeout while the device keeps working invisibly.
const CALL_TIMEOUT_MARGIN_MS = 10_000;

function normalizedServerUrl(value, { allowInsecure = false } = {}) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('serverUrl must use http or https');
  if (url.username || url.password) throw new Error('serverUrl must not embed credentials');
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol === 'http:' && !loopback && !allowInsecure) throw new Error('Remote serverUrl must use https');
  url.hash = '';
  url.search = '';
  return url.href.replace(/\/$/, '');
}

function sendRelayMessage(socket, message) {
  if (socket?.readyState !== 1) return false;
  // The authenticated relay is ReMCP's explicit data boundary: model-requested tool results are
  // intentionally returned to the paired workspace and never to an arbitrary third-party URL.
  // codeql[js/file-access-to-http]
  socket.send(JSON.stringify(message));
  return true;
}

function jitter(ms) {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

function boundedReconnectDelay(value, fallbackMs = 150) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallbackMs;
  return Math.max(100, Math.min(60_000, Math.floor(parsed)));
}

// Device health is sampled locally and is the only thing ReMCP stores about the machine
// beyond its name, platform and last-seen time. No process list, no file names.
function deviceMetrics(extra = {}) {
  const load = os.loadavg?.()[0] ?? 0;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    uptimeSeconds: Math.round(os.uptime()),
    agentUptimeSeconds: Math.round(process.uptime()),
    rssBytes: process.memoryUsage().rss,
    load1: Number.isFinite(load) ? Number(load.toFixed(2)) : 0,
    cpuCount: os.cpus?.().length ?? 0,
    freeMemoryRatio: totalMem > 0 ? Number((freeMem / totalMem).toFixed(3)) : 0,
    agentVersion: VERSION,
    ...extra,
  };
}

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
  const postConnectUpdateRecheckDelaysMs = (Array.isArray(options.updateRecheckDelaysMs)
    ? options.updateRecheckDelaysMs
    : POST_CONNECT_UPDATE_RECHECK_DELAYS_MS)
    .map(Number)
    .filter(delay => Number.isFinite(delay) && delay >= 0 && delay < UPDATE_CHECK_INTERVAL_MS)
    .slice(0, 3);
  const postConnectUpdateRecheckJitterMs = Number.isFinite(Number(options.updateRecheckJitterMs))
    ? Math.max(0, Math.min(60_000, Number(options.updateRecheckJitterMs)))
    : POST_CONNECT_UPDATE_RECHECK_JITTER_MS;
  let stopping = false;
  let revoked = false;
  const inFlight = new Map();
  let activeSocket;
  let reconnects = 0;
  let reconnectTimer = null;
  let postConnectUpdateTimers = [];
  // Set when a replica asks this agent to move before it is replaced; the close handler reads it.
  let askedToReconnect = false;
  let requestedReconnectDelayMs = 0;
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
  let runtimeToolsRetryDelay = RUNTIME_TOOLS_RETRY_BASE_MS;
  let runtimeToolsRetryTimer = null;
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

  function toolNames(listed) {
    const tools = Array.isArray(listed?.tools) ? listed.tools : [];
    return [...new Set(tools.map(tool => String(tool?.name || '').trim().slice(0, 128)).filter(Boolean))].slice(0, 256);
  }

  function scheduleRuntimeToolsRetry(client) {
    if (stopping || runtimeDown || mcp !== client || runtimeToolsRetryTimer) return;
    const delay = jitter(runtimeToolsRetryDelay);
    runtimeToolsRetryDelay = Math.min(RUNTIME_TOOLS_RETRY_MAX_MS, runtimeToolsRetryDelay * 2);
    runtimeToolsRetryTimer = setTimeout(() => {
      runtimeToolsRetryTimer = null;
      void refreshRuntimeTools(client);
    }, delay);
    runtimeToolsRetryTimer.unref?.();
  }

  function applyRuntimeTools(next, { announce = true } = {}) {
    if (next.length === runtimeTools.length && next.every((name, index) => name === runtimeTools[index])) return runtimeTools;
    runtimeTools = next;
    if (announce) send({ type: 'capabilities', runtimeTools });
    return runtimeTools;
  }

  async function refreshRuntimeTools(client = mcp, { announce = true } = {}) {
    if (!client || runtimeDown) return runtimeTools;
    try {
      const listed = await client.listTools(undefined, { timeout: 3000 });
      if (runtimeToolsRetryTimer) clearTimeout(runtimeToolsRetryTimer);
      runtimeToolsRetryTimer = null;
      runtimeToolsRetryDelay = RUNTIME_TOOLS_RETRY_BASE_MS;
      applyRuntimeTools(toolNames(listed), { announce });
    } catch (error) {
      console.error(`ReMCP could not refresh runtime capabilities: ${error instanceof Error ? error.message : String(error)}`);
      scheduleRuntimeToolsRetry(client);
    }
    return runtimeTools;
  }

  async function startRuntime() {
    if (stopping) return;
    clearTimeout(runtimeRestartTimer);
    runtimeRestartTimer = null;
    if (runtimeToolsRetryTimer) clearTimeout(runtimeToolsRetryTimer);
    runtimeToolsRetryTimer = null;
    runtimeToolsRetryDelay = RUNTIME_TOOLS_RETRY_BASE_MS;
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
                scheduleRuntimeToolsRetry(client);
                return;
              }
              applyRuntimeTools(toolNames({ tools }));
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
    if (runtimeToolsRetryTimer) clearTimeout(runtimeToolsRetryTimer);
    runtimeToolsRetryTimer = null;
    runtimeToolsRetryDelay = RUNTIME_TOOLS_RETRY_BASE_MS;
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

  function scheduleReconnect(delay) {
    if (stopping || revoked || reconnectTimer) return;
    // Keep the upper-bound guard in control flow immediately before the timer sink. CodeQL's
    // resource-exhaustion model treats this as a barrier, and future callers cannot retain the
    // agent with an attacker-controlled timer lifetime.
    const numericDelay = Number(delay);
    if (!Number.isFinite(numericDelay)) {
      scheduleReconnect(RECONNECT_BASE_MS);
      return;
    }
    if (numericDelay > RECONNECT_MAX_MS) {
      scheduleReconnect(RECONNECT_MAX_MS);
      return;
    }
    const safeDelay = Math.max(100, Math.floor(numericDelay));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, safeDelay);
    reconnectTimer.unref?.();
  }

  function scheduleBackoffReconnect() {
    if (stopping || revoked || reconnectTimer) return;
    reconnects += 1;
    // The first retry after an unexpected drop is quick on purpose: a deploy blip, a proxy restart or
    // a dropped packet should cost a fraction of a second, not the two seconds the backoff starts at.
    const delay = reconnects === 1
      ? jitter(RECONNECT_FIRST_MS)
      : jitter(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(reconnects, 5)));
    scheduleReconnect(delay);
  }

  async function respond(ws, message) {
    pendingRequests += 1;
    // The relay forwards a cancel when the MCP client goes away. Without it a cancelled tool call
    // kept running on the machine (a delete still deleted), because nothing told the runtime.
    const controller = new AbortController();
    inFlight.set(message.id, controller);
    try {
      let result;
      if (message.method === 'ping') {
        result = { ok: true, hostname: os.hostname(), platform: process.platform, arch: process.arch, uptimeSeconds: Math.floor(os.uptime()), agentVersion: VERSION, runtimeVersion, runtimeRestarts };
      } else if (!runtimeDown && mcp) {
        const options = { timeout: callTimeoutMs, signal: controller.signal };
        if (message.method === 'tools/list') result = await mcp.listTools(undefined, options);
        else if (message.method === 'tools/call') result = await mcp.callTool(message.params, undefined, options);
        else throw new Error(`Unsupported relay method: ${message.method}`);
      } else {
        throw new Error('The ReMCP local runtime is restarting. Retry in a few seconds.');
      }
      sendRelayMessage(ws, { type: 'response', id: message.id, result });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      sendRelayMessage(ws, { type: 'response', id: message.id, error: { message: cancelled ? 'Cancelled: the client stopped waiting for this call.' : error instanceof Error ? error.message : String(error) } });
    } finally {
      inFlight.delete(message.id);
      pendingRequests = Math.max(0, pendingRequests - 1);
    }
  }

  function connect() {
    if (stopping) return;
    // The device token is intentionally sent only to the configured ReMCP relay during the
    // authenticated WebSocket handshake.
    // codeql[js/file-access-to-http]
    const ws = new WebSocket(agentUrl, { headers: { Authorization: `Bearer ${deviceToken}` } });
    // The ws client leaves cleanup/retry to the caller when an unexpected-response listener exists.
    // A temporary workspace pause therefore needs an explicit retry; otherwise the first 423 leaves
    // this WebSocket stuck in CONNECTING forever and turning the device back on cannot recover it.
    ws.on('unexpected-response', (request, response) => {
      const handshakeRevoked = String(response.headers['x-remcp-revoked'] || '') === '1';
      const handshakeDisabled = String(response.headers['x-remcp-disabled'] || '') === '1';
      if (handshakeRevoked) revoked = true;
      console.error(`ReMCP relay refused the connection (HTTP ${response.statusCode})${handshakeRevoked ? ': this device was revoked' : handshakeDisabled ? ': this device is temporarily disabled' : ''}.`);
      response.resume();
      request.destroy();
      if (handshakeDisabled && !revoked) {
        reconnects += 1;
        // Service access is a user-controlled pause, not an outage. Poll slowly enough not to hammer
        // the relay, but cap recovery so an enable action becomes effective within seconds.
        scheduleReconnect(jitter(RECONNECT_BASE_MS));
        return;
      }
      const status = Number(response.statusCode || 0);
      const transientHandshakeFailure = status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
      if (transientHandshakeFailure && !revoked) {
        // A reverse proxy or relay deploy can refuse the HTTP upgrade before a WebSocket exists.
        // With an unexpected-response listener the client does not reliably emit close afterwards,
        // so this branch must schedule its own retry or a still-running agent can stay offline forever.
        scheduleBackoffReconnect();
      }
    });
    activeSocket = ws;
    ws.on('open', () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnects = 0;
      sendRelayMessage(ws, {
        type: 'hello',
        deviceId,
        deviceName,
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        agentVersion: VERSION,
        runtimeVersion,
        runtimeState: runtimeDown ? 'down' : 'ready',
        runtimeError,
        runtimeTools,
        telemetryEnabled,
        reconnects,
      });
      console.log(`Connected to ${serverUrl} as ${deviceName}`);
      sendMetricsSample();
      reportInstallOnce();
      flushTelemetry();
      void checkForUpdate();
      schedulePostConnectUpdateChecks();
    });
    ws.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message?.type === 'reconnect') {
        askedToReconnect = true;
        requestedReconnectDelayMs = boundedReconnectDelay(message.delayMs, 150);
        return;
      }
      if (message?.type === 'request') void respond(ws, message);
      if (message?.type === 'cancel' && message.id) {
        const controller = inFlight.get(message.id);
        if (controller) controller.abort();
      }
    });
    ws.on('close', code => {
      clearPostConnectUpdateChecks();
      for (const controller of inFlight.values()) controller.abort();
      if (stopping) return;
      // 1013 ('reconnect') is what a replica sends before it is replaced by a deployment. The machine
      // is not down, it is moving: reconnect at once and forget the backoff, so the person and the
      // model see nothing at all.
      if (code === 1013 || askedToReconnect) {
        const delayMs = requestedReconnectDelayMs || 150;
        askedToReconnect = false;
        requestedReconnectDelayMs = 0;
        reconnects = 0;
        console.log(`ReMCP relay is being redeployed; reconnecting in ${delayMs}ms.`);
        scheduleReconnect(delayMs);
        return;
      }
      if (code === 1008 || revoked) {
        // The relay closes with 1008 when the device was revoked. Retrying forever would
        // hide that from the person at the computer.
        console.error('ReMCP access for this device was revoked. Pair the machine again from the ReMCP workspace: remcp connect --server <url> --code <code> --install');
        return;
      }
      if (code === 1012) {
        // 1012 ('service restart') is what the relay sends when another agent process took over this
        // device. Staying alive would keep a second runtime and a reconnect loop, so this process
        // stops and leaves the device to the agent that owns the connection.
        console.error('Another ReMCP agent connected for this device; this process will stop. Run one agent per machine (a service manager or the remcp start command).');
        stopping = true;
        void stop().finally(() => setTimeout(() => process.exit(0), 100));
        return;
      }
      scheduleBackoffReconnect();
    });
    ws.on('error', error => console.error(`ReMCP relay: ${error.message}`));
  }

  // Auto-update: the server publishes the versions an agent should be running. A newer
  // release is installed in the background and the service restart picks it up; a failed
  // or skipped update leaves the current version running, so an old agent keeps working.
  //
  // The update must be idempotent across reconnects: a flapping relay used to start one
  // `npm install -g` per reconnect, so a machine could run several installers (and service
  // restarts) at once. One attempt per advertised version, and never two at the same time.
  let updateInFlight = false;
  let lastAttemptedVersion = '';
  let lastAttemptAt = 0;
  let lastUpdateCheckError = '';
  let lastUpdateCheckErrorAt = 0;

  function clearPostConnectUpdateChecks() {
    for (const timer of postConnectUpdateTimers) clearTimeout(timer);
    postConnectUpdateTimers = [];
  }

  function schedulePostConnectUpdateChecks() {
    clearPostConnectUpdateChecks();
    if (options.autoUpdate === false) return;
    for (const delay of postConnectUpdateRecheckDelaysMs) {
      const jitter = postConnectUpdateRecheckJitterMs > 0
        ? Math.floor(Math.random() * (postConnectUpdateRecheckJitterMs + 1))
        : 0;
      const timer = setTimeout(() => {
        postConnectUpdateTimers = postConnectUpdateTimers.filter(candidate => candidate !== timer);
        void checkForUpdate();
      }, delay + jitter);
      timer.unref?.();
      postConnectUpdateTimers.push(timer);
    }
  }

  async function checkForUpdate() {
    if (options.autoUpdate === false) return;
    if (updateInFlight) return;
    try {
      // This request contains no local file payload; the config-derived URL is the explicitly paired relay.
      // codeql[js/file-access-to-http]
      const response = await fetch(`${serverUrl}/api/agent/version`, { redirect: 'error', signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS) });
      if (!response.ok) return;
      const advertised = await response.json();
      const minimum = advertised.minimum;
      if (minimum && isNewer(minimum, VERSION)) {
        console.error(`ReMCP ${VERSION} is older than the minimum supported agent ${minimum}; update with: remcp update`);
      }
      const decision = updateDecision({ advertised, cliVersion: VERSION, runtimeVersion, runtimePackageName: options.runtime?.packageName, runtimeDown });
      if (!decision.needed) return;
      const target = decision.target;
      queueEvent({ event: 'agent_update', at: Date.now(), reason: `${decision.reason}:${target}`.slice(0, 32), success: true });
      const cli = globalCliEntry();
      if (!cli || !existsSync(cli)) {
        console.error(`ReMCP ${target} is available; run: remcp update`);
        return;
      }
      // A version that already failed to install is retried only after a cooldown, so a broken
      // release cannot turn into an install loop.
      const attemptKey = `${target}|${decision.runtime}`;
      if (attemptKey === lastAttemptedVersion && Date.now() - lastAttemptAt < UPDATE_RETRY_COOLDOWN_MS) return;
      lastAttemptedVersion = attemptKey;
      lastAttemptAt = Date.now();
      updateInFlight = true;
      console.log(`Updating ReMCP to ${target}${decision.runtime ? ` with ${decision.runtime}` : ''} (${decision.reason})…`);
      // Keep the updater pinned to the exact release pair this trusted server advertised. That
      // prevents a newer public npm tag from getting ahead of production during a public-first rollout.
      const updateArgs = updateInvocationArgs(decision, options.trustRuntime === true);
      const child = spawn(process.execPath, [cli, ...updateArgs], {
        detached: true,
        // The updater's own output is the only record of why an install failed, so it is piped back
        // into this agent's log instead of being discarded.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      const forward = chunk => {
        const line = String(chunk).trim();
        if (line) console.error(`remcp update: ${line}`);
      };
      child.stdout?.on('data', forward);
      child.stderr?.on('data', forward);
      child.on('exit', code => {
        updateInFlight = false;
        // The updater installs the packages and then restarts the service this agent runs in, so it is
        // routinely killed by that restart and exits with a signal (`code` is null). That is success,
        // not failure: the installed version is the proof. Without this check the agent kept
        // reinstalling every few seconds — each cycle taking the device offline and making every tool
        // call in that window fail in 1-3 ms ("Device is offline").
        const targetVersion = String(target).split('@').pop();
        const installedNow = globalInstalledVersion();
        const installedTarget = installedNow && targetVersion && !isNewer(targetVersion, installedNow);
        if (code !== 0 && !installedTarget) {
          console.error(`remcp update exited with ${code}; keeping ${VERSION} and retrying after the cooldown.`);
          return;
        }
        if (code !== 0) {
          console.error(`remcp update was terminated (${code}) after installing ${installedNow}; applying it.`);
        }
        void restartToApplyUpdate(cli, stop, () => { stopping = true; }, async () => {
          // The packages are installed now: clear the failure, reset the backoff and start again.
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
        }, () => stopping);
      });
      child.on('error', error => {
        updateInFlight = false;
        console.error(`remcp update could not start: ${error.message}`);
      });
      child.unref();
    } catch (error) {
      // Update discovery must never take the agent offline, but swallowing the exception made FNM/
      // launchd failures impossible to diagnose. Log only when the reason changes or every 30 min.
      const message = error instanceof Error ? error.message : String(error);
      const now = Date.now();
      if (message !== lastUpdateCheckError || now - lastUpdateCheckErrorAt >= UPDATE_RETRY_COOLDOWN_MS) {
        console.error(`ReMCP auto-update check failed: ${message}`);
        lastUpdateCheckError = message;
        lastUpdateCheckErrorAt = now;
      }
      queueEvent({ event:'agent_update', at:now, reason:'check-failed', success:false, errorClass:error?.name || 'Error' });
    }
  }

  scheduleMetricsSample();
  const telemetryFlushTimer = setInterval(flushTelemetry, TELEMETRY_SEND_INTERVAL_MS);
  telemetryFlushTimer.unref?.();
  const updateTimer = setInterval(() => void checkForUpdate(), UPDATE_CHECK_INTERVAL_MS);
  updateTimer.unref?.();

  async function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearTimeout(runtimeRestartTimer);
    clearTimeout(runtimeToolsRetryTimer);
    runtimeToolsRetryTimer = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
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
