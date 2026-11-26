// Agent relay WebSocket lifecycle, bounded reconnect scheduling and handshake security.
import os from 'node:os';
import process from 'node:process';
import WebSocket from 'ws';
import { VERSION } from './version.mjs';
import { boundedReconnectDelay, jitter, sendRelayMessage } from './agent-utilities.mjs';
import { nextDeployReconnect } from './agent-deploy-reconnect.mjs';

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_FIRST_MS = 500;
const RECONNECT_MAX_MS = 60_000;
// A temporary owner pause must recover automatically without constant dials.
export function pausedReconnectDelay(attempt, randomize = jitter) {
  const n = Math.max(1, Math.min(6, Number.isFinite(attempt) ? Math.floor(attempt) : 1));
  return Math.min(RECONNECT_MAX_MS, randomize(RECONNECT_BASE_MS * 2 ** (n - 1)));
}
// The relay uses delta-seconds on 429/503; retain the local reconnect bound.
export function relayRetryAfterDelay(status, header) {
  if ((status !== 429 && status !== 503) || typeof header !== 'string' ||
    !/^[0-9]{1,6}$/.test(header)) return 0;
  return Math.min(RECONNECT_MAX_MS, Number(header) * 1000);
}
const HEARTBEAT_INTERVAL_MS = 15_000;
// Retry one unanswered ping before declaring the socket stale. A single lost
// pong must not create a new device session during transient NIC packet loss.
const HEARTBEAT_MAX_MISSED_TICKS = 2;
const HANDSHAKE_TIMEOUT_MS = 12_000;
// Only a loaded device endpoint with an OS-vault identity admits strict E2EE.
// Environment variables cannot manufacture encryption availability.
export function assertAgentE2eeAdmission(environment = process.env, configRequired = false, secureTransportReady = false) {
  // The owner-controlled config survives service restarts and auto-updates.
  // Env requirements remain stronger: "0" cannot override a persisted "true".
  if (configRequired !== true && configRequired !== false && configRequired !== undefined)
    throw new Error('Invalid persisted E2EE requirement: expected boolean');
  const requirement = environment?.REMCP_REQUIRE_E2EE;
  if (requirement !== undefined && requirement !== '0' && requirement !== '1')
    throw new Error('Invalid REMCP_REQUIRE_E2EE: expected 0 or 1');
  if ((requirement === '1' || configRequired === true) && secureTransportReady !== true)
    throw new Error('E2EE required but unavailable in this release; refusing TLS-only relay connection');
}

// Higher-level agent owns runtime supervision/telemetry; this controller owns only relay transport.
export function createAgentRelayConnection({
  agentUrl, serverUrl, deviceToken, deviceId, deviceName,
  isStopping, markStopping, getReconnects, setReconnects,
  setSocket, getHelloState, respond, inFlight,
  sendMetricsSample, reportInstallOnce, flushTelemetry,
  checkForUpdate, schedulePostConnectUpdateChecks, clearPostConnectUpdateChecks, stop,
  onRevoked, checkUpdatesOnConnect = false, requireE2ee = false,
  readCurrentE2eeRequirement = null, secureTransportReady = false,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS, handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
}) {
  const assertCurrentPolicy=()=>{
    assertAgentE2eeAdmission(process.env,requireE2ee,secureTransportReady);
    if(typeof readCurrentE2eeRequirement==='function')
      assertAgentE2eeAdmission(process.env,readCurrentE2eeRequirement(),secureTransportReady);
  };
  assertCurrentPolicy();
  let revoked = false;
  let pausedAttempts = 0;
  let reconnectTimer = null;
  let askedToReconnect = false;
  let requestedReconnectDelayMs = 0;
  let requestedReconnectReason = '';
  let connectedAt = 0;
  let rapidDeployDisconnects = 0;
  // Timing overrides are used only by isolated transport regression tests.
  const heartbeatInterval = Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs >= 20
    ? Math.min(60_000, Math.floor(heartbeatIntervalMs)) : HEARTBEAT_INTERVAL_MS;
  const handshakeTimeout = Number.isFinite(handshakeTimeoutMs) && handshakeTimeoutMs >= 100
    ? Math.min(120_000, Math.floor(handshakeTimeoutMs)) : HANDSHAKE_TIMEOUT_MS;
  let clearActiveHeartbeat = () => {};
  let activeSocket = null;
  function enforceActivePolicy(ws) {
    try{assertCurrentPolicy();return true;}
    catch{
      // A persisted strict policy must revoke a TLS-only socket even if a
      // managed service restart failed. Never acknowledge E2EE protection.
      console.error('ReMCP E2EE requirement changed: stopping TLS-only agent.');
      ws.terminate();
      markStopping?.();
      void Promise.resolve().then(()=>stop?.()).catch(()=>{});
      return false;
    }
  }
  function scheduleReconnect(delay) {
    if (isStopping() || revoked || reconnectTimer) return;
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
      try{connect();}
      catch{
        // A stricter local policy can take effect while the socket is offline.
        // Stop rather than letting an uncaught timer exception re-dial TLS.
        console.error('ReMCP strict E2EE policy refused a TLS-only reconnect.');
        markStopping?.();
        void Promise.resolve().then(()=>stop?.()).catch(()=>{});
      }
    }, safeDelay);
    // A failed handshake may leave no other referenced handles. Keep the reconnect
    // timer referenced, or Node exits 0 and a supervisor can restart it forever.
    // clearReconnect() releases the timer on intentional shutdown.
  }

  function stopForRevocation() {
    if (revoked) return;
    revoked = true;
    markStopping?.();
    void Promise.resolve().then(() => stop?.()).then(() => onRevoked?.()).catch(() => {
      console.error('ReMCP revoked agent cleanup failed.');
    });
    console.error('ReMCP access for this device was revoked. Generate a new pairing command in your workspace and add --re-pair.');
  }

  function scheduleBackoffReconnect(minimumDelayMs = 0) {
    if (isStopping() || revoked || reconnectTimer) return;
    setReconnects(getReconnects() + 1);
    // The first retry after an unexpected drop is quick on purpose: a deploy blip, a proxy restart or
    // a dropped packet should cost a fraction of a second, not the two seconds the backoff starts at.
    const delay = getReconnects() === 1
      ? jitter(RECONNECT_FIRST_MS)
      : jitter(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(getReconnects(), 5)));
    scheduleReconnect(Math.max(delay, minimumDelayMs));
  }

  function connect() {
    if (isStopping() || revoked) return;
    // Policy can become stricter after controller creation. Re-admit before
    // every first dial or reconnect, not only when creating the controller.
    assertCurrentPolicy();
    if (activeSocket && (activeSocket.readyState === WebSocket.OPEN ||
      activeSocket.readyState === WebSocket.CONNECTING)) return;
    // The device token is intentionally sent only to the configured ReMCP relay during the
    // authenticated WebSocket handshake.
    // codeql[js/file-access-to-http]
    const ws = new WebSocket(agentUrl, {
      headers: { Authorization: `Bearer ${deviceToken}` },
      handshakeTimeout,
    });
    activeSocket = ws;
    let heartbeatTimer = null;
    let awaitingPong = false;
    let missedPongTicks = 0;
    function clearHeartbeat() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    clearActiveHeartbeat = clearHeartbeat;
    // The ws client leaves cleanup/retry to the caller when an unexpected-response listener exists.
    // A temporary workspace pause therefore needs an explicit retry; otherwise the first 423 leaves
    // this WebSocket stuck in CONNECTING forever and turning the device back on cannot recover it.
    ws.on('unexpected-response', (request, response) => {
      if (activeSocket !== ws) {
        response.resume();
        request.destroy();
        return;
      }
      activeSocket = null;
      setSocket(null);
      const handshakeRevoked = String(response.headers['x-remcp-revoked'] || '') === '1';
      const handshakeDisabled = response.statusCode === 423 || String(response.headers['x-remcp-disabled'] || '') === '1';
      if (handshakeRevoked) stopForRevocation();
      console.error(`ReMCP relay refused the connection (HTTP ${response.statusCode})${handshakeRevoked ? ': this device was revoked' : handshakeDisabled ? ': this device is temporarily disabled' : ''}.`);
      response.resume();
      request.destroy();
      if (handshakeDisabled && !revoked) {
        setReconnects(getReconnects() + 1);
        // Preserve a fast first recovery; prolonged pauses exponentially reduce load.
        // Reset only on a successful handshake, including across transient proxy failures.
        pausedAttempts = Math.min(6, pausedAttempts + 1);
        scheduleReconnect(pausedReconnectDelay(pausedAttempts));
        return;
      }
      if (!revoked) {
        // Even a captive-portal redirect or unexpected proxy rejection may be temporary.
        // ws does not reliably emit close with an unexpected-response listener, so retry
        // all non-revocation failures with bounded backoff rather than staying offline forever.
        // The explicit revocation signal above remains final and cannot be bypassed.
        scheduleBackoffReconnect(relayRetryAfterDelay(response.statusCode, response.headers['retry-after']));
      }
    });
    setSocket(ws);
    ws.on('open', () => {
      if(!enforceActivePolicy(ws))return;
      if (activeSocket !== ws || isStopping()) {
        ws.terminate();
        return;
      }
      pausedAttempts = 0;
      connectedAt = Date.now();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      setReconnects(0);
      // A network switch can strand a TCP/WebSocket session without close or error.
      // Probe relay liveness client-side and terminate a stale socket to reconnect.
      heartbeatTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if(!enforceActivePolicy(ws))return;
        if (awaitingPong && ++missedPongTicks >= HEARTBEAT_MAX_MISSED_TICKS) {
          console.error('ReMCP relay heartbeat timeout; terminating stale connection.');
          ws.terminate();
          return;
        }
        awaitingPong = true;
        // Retry a missing pong once; the next missed tick still forces a
        // bounded reconnect instead of retaining an indefinitely stale socket.
        try { ws.ping(); } catch {
          console.error('ReMCP relay ping failed; terminating stale connection.');
          ws.terminate();
        }
      }, heartbeatInterval);
      heartbeatTimer.unref?.();
      sendRelayMessage(ws, {
        type: 'hello',
        deviceId,
        deviceName,
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        agentVersion: VERSION,
        ...getHelloState(),
        reconnects: getReconnects(),
      });
      console.log(`Connected to ${serverUrl} as ${deviceName}`);
      sendMetricsSample();
      reportInstallOnce();
      flushTelemetry();
      // Normal fleet clients poll on a stable per-device phase, not all on
      // every relay handshake. Explicit short QA rechecks retain hot-path coverage.
      if (checkUpdatesOnConnect) void checkForUpdate();
      schedulePostConnectUpdateChecks();
    });
    ws.on('pong', () => {
      if (activeSocket !== ws) return;
      awaitingPong = false;
      missedPongTicks = 0;
    });
    ws.on('message', raw => {
      if (activeSocket !== ws || !enforceActivePolicy(ws)) return;
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message?.type === 'reconnect') {
        askedToReconnect = true;
        requestedReconnectDelayMs = boundedReconnectDelay(message.delayMs, 150);
        requestedReconnectReason = ['deploy', 'credentials', 'capacity'].includes(message.reason)
          ? message.reason : 'transient';
        return;
      }
      if (message?.type === 'request') void respond(ws, message);
      if (message?.type === 'cancel' && message.id) {
        const controller = inFlight.get(message.id);
        if (controller) controller.abort();
      }
    });
    ws.on('close', code => {
      clearHeartbeat();
      if (activeSocket !== ws) return;
      activeSocket = null;
      setSocket(null);
      clearPostConnectUpdateChecks();
      for (const controller of inFlight.values()) controller.abort();
      if (isStopping()) return;
      // A replacement owner or revoked device takes precedence over a reconnect hint.
      if (code === 1008 || revoked) {
        stopForRevocation();
        return;
      }
      if (code === 1012) {
        console.error('Another ReMCP agent connected for this device; this process will stop. Run one agent per machine (a service manager or the remcp start command).');
        markStopping();
        void stop().finally(() => setTimeout(() => process.exit(0), 100));
        return;
      }
      if (code === 1013 || askedToReconnect) {
        // 1013 covers transient overload and relay-store failures, not just deployment.
        // Preserve a fast first handover while bounding repeated short-lived sessions.
        const reconnect = nextDeployReconnect({
          requestedDelayMs: requestedReconnectDelayMs || 150,
          rapidDisconnects: rapidDeployDisconnects,
          connectionUptimeMs: connectedAt ? Date.now() - connectedAt : 0,
        });
        rapidDeployDisconnects = reconnect.rapidDisconnects;
        const reason = requestedReconnectReason || 'transient';
        askedToReconnect = false;
        requestedReconnectReason = '';
        requestedReconnectDelayMs = 0;
        setReconnects(0);
        console.log(`ReMCP relay reconnect (${reason}); retrying in ${reconnect.delayMs}ms.`);
        scheduleReconnect(reconnect.delayMs);
        return;
      }
      scheduleBackoffReconnect();
    });
    ws.on('error', error => console.error(`ReMCP relay: ${error.message}`));
  }

  return {
    connect,
    clearReconnect() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      clearActiveHeartbeat();
    },
  };
}
