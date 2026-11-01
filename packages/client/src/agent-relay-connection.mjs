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
// Higher-level agent owns runtime supervision/telemetry; this controller owns only relay transport.
export function createAgentRelayConnection({
  agentUrl, serverUrl, deviceToken, deviceId, deviceName,
  isStopping, markStopping, getReconnects, setReconnects,
  setSocket, getHelloState, respond, inFlight,
  sendMetricsSample, reportInstallOnce, flushTelemetry,
  checkForUpdate, schedulePostConnectUpdateChecks, clearPostConnectUpdateChecks, stop,
}) {
  let revoked = false;
  let reconnectTimer = null;
  let askedToReconnect = false;
  let requestedReconnectDelayMs = 0;
  let requestedReconnectReason = '';
  let connectedAt = 0;
  let rapidDeployDisconnects = 0;
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
      connect();
    }, safeDelay);
    reconnectTimer.unref?.();
  }

  function scheduleBackoffReconnect() {
    if (isStopping() || revoked || reconnectTimer) return;
    setReconnects(getReconnects() + 1);
    // The first retry after an unexpected drop is quick on purpose: a deploy blip, a proxy restart or
    // a dropped packet should cost a fraction of a second, not the two seconds the backoff starts at.
    const delay = getReconnects() === 1
      ? jitter(RECONNECT_FIRST_MS)
      : jitter(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(getReconnects(), 5)));
    scheduleReconnect(delay);
  }

  function connect() {
    if (isStopping()) return;
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
        setReconnects(getReconnects() + 1);
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
    setSocket(ws);
    ws.on('open', () => {
      connectedAt = Date.now();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      setReconnects(0);
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
      void checkForUpdate();
      schedulePostConnectUpdateChecks();
    });
    ws.on('message', raw => {
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
      clearPostConnectUpdateChecks();
      for (const controller of inFlight.values()) controller.abort();
      if (isStopping()) return;
      // A replacement owner or revoked device takes precedence over a reconnect hint.
      if (code === 1008 || revoked) {
        console.error('ReMCP access for this device was revoked. Pair the machine again from the ReMCP workspace: remcp connect --server <url> --code <code> --install');
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
    clearReconnect() { if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = null; },
  };
}
