import { createHash } from 'node:crypto';

// A 24-hour fleet rollout makes 100,000 downloads roughly 1.16/sec instead
// of initiating all installers when a new version first becomes visible.
export const ROLLOUT_WINDOW_MS = 24 * 60 * 60 * 1000;
const ROLLOUT_MAX_WINDOW_MS = 7 * ROLLOUT_WINDOW_MS;
const ROLLOUT_STATE_TTL_SECONDS = 120 * 24 * 60 * 60;

export function updateRolloutEligibility({ deviceId, target, rollout, urgent = false }, now = Date.now()) {
  if (urgent || !rollout) return { ready:true, readyAt:now };
  const startAtMs = Number(rollout.startAtMs);
  const windowMs = Number(rollout.windowMs);
  // A malformed policy must not accidentally release the whole fleet at once.
  if (!String(deviceId || '').trim() || !String(target || '').trim()
    || !Number.isSafeInteger(startAtMs) || startAtMs < 1_600_000_000_000
    || !Number.isSafeInteger(windowMs) || windowMs < 60_000 || windowMs > ROLLOUT_MAX_WINDOW_MS) {
    return { ready:false, readyAt:null };
  }
  // A stable local device identifier is hashed, not transmitted to the public
  // update endpoint. A distinct release has a distinct deterministic slot.
  const hash = createHash('sha256').update('remcp-agent-rollout-v1\0')
    .update(String(deviceId)).update('\0').update(String(target)).digest();
  const offsetMs = Math.floor(hash.readUInt32BE(0) / 0x100000000 * windowMs);
  const readyAt = startAtMs + offsetMs;
  // The response's server timestamp prevents incorrect client wall clocks
  // from synchronously skipping all fleet slots.
  const serverNowMs = Number(rollout.serverNowMs);
  const effectiveNow = Number.isSafeInteger(serverNowMs) && serverNowMs >= 1_600_000_000_000
    ? serverNowMs : now;
  return { ready:effectiveNow >= readyAt, readyAt };
}

// Fleet update checks are phased on the wall clock as well. A 100k-device
// reconnect wave must not turn into 100k immediate manifest GETs or a synchronized
// 5-minute polling loop. The phase survives agent restarts with no disk state.
export function nextFleetManifestDelayMs(deviceId, now = Date.now(), intervalMs = 5 * 60 * 1000) {
  if (!String(deviceId || '').trim() || !Number.isSafeInteger(intervalMs) || intervalMs < 1000) {
    throw new Error('Fleet manifest scheduling requires a paired device and a valid interval');
  }
  const hash = createHash('sha256').update('remcp-update-check-phase-v1\0').update(String(deviceId)).digest();
  const phase = Math.floor(hash.readUInt32BE(0) / 0x100000000 * intervalMs);
  const elapsed = ((now % intervalMs) + intervalMs) % intervalMs;
  return (phase - elapsed + intervalMs) % intervalMs || intervalMs;
}

// Legacy clients (before scheduler v1) cannot defer installs themselves.
// Admit a bounded number of old automatic update checks per minute across the
// entire HA cluster; the rest retry their next normal check. Manual status,
// bootstrap and manually requested updates use their own unthrottled paths.
export async function claimLegacyManifestSlot(command, version, {
  now = Date.now, limitPerMinute = 120, isClosed = () => false,
} = {}) {
  if (isClosed() || !command?.isReady) throw new Error('Shared legacy update admission unavailable');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version))) {
    throw new Error('Invalid version for legacy update admission');
  }
  if (!Number.isSafeInteger(limitPerMinute) || limitPerMinute < 1 || limitPerMinute > 6000) {
    throw new Error('Invalid legacy update admission quota');
  }
  const minute = Math.floor(now() / 60_000);
  const key = 'remcp:deploy:legacy-update-admit:v1:' + version + ':' + minute;
  const script = "local n=redis.call('INCR',KEYS[1]); if n == 1 then redis.call('EXPIRE',KEYS[1],90) end; return n <= tonumber(ARGV[1]) and 1 or 0";
  return Number(await command.eval(script, { keys:[key], arguments:[String(limitPerMinute)] })) === 1;
}

// Use only immutable HTTP traits that identify the old agent's no-header
// automatic fetch. The trusted user-requested manual update uses Accept JSON.
export function isLegacyAutomaticUpdateRequest(req) {
  const header = name => String(req?.get?.(name) || req?.headers?.[name.toLowerCase()] || '').toLowerCase();
  return /^(?:node|undici)(?:\/[0-9.]+)?$/.test(header('user-agent'))
    && header('accept').trim() === '*/*'
    && header('x-remcp-update-scheduler') !== 'v1'
    && !req?.query?.fresh;
}

// The shared Redis epoch is created exactly once for each released version.
// A rolling HA deploy or process restart must not reset the fleet schedule.
// Use the same Redis coordination store as the existing release pause gate.
export async function getOrCreateRolloutStart(command, version, now = Date.now, isClosed = () => false) {
  if (isClosed() || !command?.isReady) throw new Error('Shared rollout control plane unavailable');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version))) {
    throw new Error('Invalid release version for update rollout');
  }
  const key = 'remcp:deploy:agent-rollout-start:v1:' + version;
  const proposed = String(now());
  await command.set(key, proposed, { NX:true, EX:ROLLOUT_STATE_TTL_SECONDS });
  const persisted = Number(await command.get(key));
  if (!Number.isSafeInteger(persisted) || persisted < 1_600_000_000_000) {
    throw new Error('Shared rollout start is unavailable');
  }
  return persisted;
}
