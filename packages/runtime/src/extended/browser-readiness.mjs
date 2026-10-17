// Optional bounded local CDP readiness probe. This reports availability only;
// it never exposes tab titles/URLs, starts Chrome, changes CDP flags or grants
// permission to access targets. Actual actions always re-check browser policy.
import { browserRemoteEnabled, endpointUrl, requestJson, validatedTargetWebSocketUrl } from './browser-endpoint.mjs';

const records = new Map();
const CACHE_MS = 3000;
const MAX_ENTRIES = 8;
const transportError = message =>
  /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|abort|timed out|network error/i.test(message);

export function classifyBrowserReadiness(version, targets, endpoint) {
  if (!version || typeof version !== 'object' || !(version.Browser || version.webSocketDebuggerUrl)
    || !Array.isArray(targets)) return { status:'invalid_response', ready:false, candidate_pages:0 };
  let pages = 0;
  for (const target of targets.slice(0, 1000)) {
    if (target?.type !== 'page' || !target?.id || !target?.webSocketDebuggerUrl) continue;
    try {
      validatedTargetWebSocketUrl(target, endpointUrl(endpoint));
      pages += 1;
    } catch {
      // The CDP server's untrusted page/socket metadata is not permission.
    }
  }
  return { status:pages ? 'ready' : 'no_tabs', ready:pages > 0, candidate_pages:pages };
}

export async function probeBrowserReadiness({
  endpoint,
  timeoutMs = 350,
  request = requestJson,
  enabled = browserRemoteEnabled(),
  now = Date.now(),
  cache = request === requestJson,
} = {}) {
  if (!enabled) return {
    status:'disabled', ready:false, candidate_pages:0, next_step:'use_native_accessibility',
  };
  let key;
  try { key = endpointUrl(endpoint).origin; }
  catch { return { status:'blocked_endpoint', ready:false, candidate_pages:0, next_step:'check_local_cdp_config' }; }
  if (cache) {
    const previous = records.get(key);
    if (previous && previous.expires > now) return { ...previous.value, cache_hit:true };
  }
  const timeout = Math.max(100, Math.min(800, Number(timeoutMs) || 350));
  let result;
  try {
    const version = await request('/json/version', endpoint, { timeout_ms:timeout });
    // CDP version alone is not evidence a useful debuggable tab exists.
    if (!version || typeof version !== 'object' || !(version.Browser || version.webSocketDebuggerUrl)) {
      result = { status:'invalid_response', ready:false, candidate_pages:0 };
    } else {
      const targets = await request('/json/list', endpoint, { timeout_ms:timeout });
      result = classifyBrowserReadiness(version, targets, endpoint);
    }
  } catch (error) {
    result = { status:transportError(String(error?.message || '')) ? 'unavailable' : 'invalid_response',
      ready:false, candidate_pages:0 };
  }
  const next_step = result.ready ? 'use_browser_tabs' : 'use_native_accessibility';
  const output = { ...result, next_step };
  if (cache) {
    records.set(key, { expires:now + CACHE_MS, value:output });
    while (records.size > MAX_ENTRIES) records.delete(records.keys().next().value);
  }
  return output;
}
