/**
 * Bound repeated relay-deployment reconnects while preserving fast recovery from
 * a single short interruption. State is per agent connection, never global.
 *
 * The gateway's requested minimum is honored; a burst of sub-10s sessions
 * progressively backs off so dozens of agents cannot spin on a deploy loop.
 */
export function nextDeployReconnect({
  requestedDelayMs = 150,
  rapidDisconnects = 0,
  connectionUptimeMs = 0,
} = {}) {
  const input = Number(requestedDelayMs);
  const requested = Number.isFinite(input)
    ? Math.max(100, Math.min(60_000, Math.floor(input)))
    : 150;
  const stable = Number(connectionUptimeMs) >= 10_000;
  const prior = Number.isSafeInteger(rapidDisconnects) && rapidDisconnects >= 0
    ? rapidDisconnects : 0;
  const count = stable ? 0 : Math.min(8, prior + 1);
  const adaptive = count <= 1 ? 0 : Math.min(8_000, 250 * 2 ** Math.min(6, count - 2));
  return {
    delayMs: Math.max(requested, adaptive),
    rapidDisconnects: count,
  };
}