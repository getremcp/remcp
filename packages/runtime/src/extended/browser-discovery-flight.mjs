// Coalesce *only overlapping* read-only CDP /json/list transport requests.
// Raw tab metadata is held only until request completion; each caller must
// re-validate all target URLs/DNS independently before returning any tabs.
const active = new Map();
const MAX_ENDPOINTS = 8;

export async function shareBrowserDiscovery(origin, load) {
  const pending = active.get(origin);
  if (pending) return pending;
  if (active.size >= MAX_ENDPOINTS) return load();
  const work = Promise.resolve().then(load);
  active.set(origin, work);
  try { return await work; }
  finally {
    if (active.get(origin) === work) active.delete(origin);
  }
}
