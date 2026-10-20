// CDP Emulation settings belong to a protocol session. Cache only bounded,
// non-sensitive viewport parameters so a newly opened session can reapply them.
const MAX_TARGETS = 64;
const IDLE_MS = 10 * 60_000;
const overrides = new Map();

export function rememberBrowserViewport(key, metrics, at = Date.now()) {
  if (!key) return;
  overrides.delete(key);
  overrides.set(key, { metrics: { ...metrics }, expiresAt: at + IDLE_MS });
  for (const [target, entry] of overrides) {
    if (entry.expiresAt <= at) overrides.delete(target);
  }
  while (overrides.size > MAX_TARGETS) overrides.delete(overrides.keys().next().value);
}

export function getBrowserViewport(key, at = Date.now()) {
  const entry = overrides.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= at) { overrides.delete(key); return null; }
  return { ...entry.metrics };
}
