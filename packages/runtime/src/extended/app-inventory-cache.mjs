// Short-lived, per-runtime inventory cache. Concurrent callers share one OS scan.
// The loader must return a compact, non-sensitive inventory; errors are never cached.
export function createAppInventoryCache({ ttlMs = 30_000, now = () => performance.now() } = {}) {
  let cached = null;
  let expiresAt = 0;
  let pending = null;
  return async (load, { refresh = false } = {}) => {
    if (!refresh && cached !== null && now() < expiresAt) return cached;
    if (pending) return pending;
    const task = Promise.resolve().then(load).then(value => {
      cached = value;
      expiresAt = now() + ttlMs;
      return value;
    });
    pending = task;
    try {
      return await task;
    } finally {
      if (pending === task) pending = null;
    }
  };
}
