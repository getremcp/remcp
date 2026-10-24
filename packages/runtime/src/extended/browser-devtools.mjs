// Native Chrome DevTools Protocol diagnostics. No screenshots, request bodies,
// authentication headers, cookies, or response bodies are collected.
import { jsonResult, clamp, requireEnum } from './common.mjs';
import { withTarget } from './browser-session.mjs';
import { inspectNativeBrowserAudit } from './browser-native-audit.mjs';
import { inspectDomGeometry } from './browser-geometry.mjs';

const METRIC_NAMES = new Set([
  'Timestamp','Documents','Frames','JSEventListeners','Nodes','LayoutCount',
  'RecalcStyleCount','LayoutDuration','RecalcStyleDuration','ScriptDuration',
  'TaskDuration','JSHeapUsedSize','JSHeapTotalSize','DomContentLoaded','NavigationStart',
]);
const HIDDEN = '[redacted]';
export function safeDevtoolsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return '[non-http resource]';
    // No fragments, credentials or query parameters reach the relay.
    return (url.origin + url.pathname).slice(0, 300);
  } catch { return '[unavailable]'; }
}
export function safeDevtoolsMessage(value) {
  let text = String(value ?? '').slice(0, 700);
  text = text.replace(/\b(Bearer|Basic)\s+[a-z\d+/_=.-]+/gi, '$1 ' + HIDDEN)
    .replace(/\b(?:eyJ[a-zA-Z0-9_-]{12,}\.){2}[a-zA-Z0-9_-]+\b/g, HIDDEN)
    .replace(/([?&](?:token|key|secret|password|session|code|authorization)=)[^\s&#]+/gi, '$1' + HIDDEN)
    .replace(/\b(?:password|access_token|refresh_token|api_key|client_secret)\s*[:=]\s*[^\s,;&]+/gi, HIDDEN);
  return text.slice(0, 500);
}
export function normalizeDevtoolsMetrics(entries) {
  return Object.fromEntries((Array.isArray(entries) ? entries : [])
    .filter(item => METRIC_NAMES.has(item?.name) && Number.isFinite(item?.value))
    .map(item => [item.name, item.value]));
}
export async function sampleBrowserDevtools(session, action, durationMs, maxEvents) {
  const events = [];
  const counts = {};
  const requests = new Map();
  function add(event) {
    const key = event.level || event.kind || 'other';
    counts[key] = (counts[key] || 0) + 1;
    if (events.length < maxEvents) events.push(event);
  }
  if (action === 'layout' || action === 'accessibility') return inspectNativeBrowserAudit(session, action);
  if (action === 'geometry') return inspectDomGeometry(session);
  if (action === 'performance') {
    await session.send('Performance.enable');
    try {
      const data = await session.send('Performance.getMetrics');
      return { action, metrics:normalizeDevtoolsMetrics(data.metrics) };
    } finally { await session.send('Performance.disable').catch(() => {}); }
  }
  const unsubscribe = [];
  if (action === 'console') {
    unsubscribe.push(session.observe('Runtime.consoleAPICalled', params => {
      const level = String(params.type || 'log').slice(0, 24);
      const previews = (params.args || []).slice(0, 3).map(arg =>
        arg?.type === 'string' ? arg.value : arg?.description || (arg?.value == null ? arg?.type : String(arg.value)));
      add({ kind:'console', level, message:safeDevtoolsMessage(previews.join(' ')) });
    }));
    unsubscribe.push(session.observe('Runtime.exceptionThrown', params => {
      add({ kind:'exception', level:'error', message:safeDevtoolsMessage(params.exceptionDetails?.text || 'Uncaught exception') });
    }));
    unsubscribe.push(session.observe('Log.entryAdded', params => {
      add({ kind:'log', level:String(params.entry?.level || 'info').slice(0, 24),
        message:safeDevtoolsMessage(params.entry?.text || '') });
    }));
  } else {
    unsubscribe.push(session.observe('Network.requestWillBeSent', params => {
      const id = String(params.requestId || '');
      if (requests.size > 1000) requests.clear();
      const record = { kind:'request', method:String(params.request?.method || 'GET').slice(0, 12),
        resource_type:String(params.type || 'Other').slice(0, 35), url:safeDevtoolsUrl(params.request?.url) };
      requests.set(id,record);
      add(record);
    }));
    unsubscribe.push(session.observe('Network.responseReceived', params => {
      const original = requests.get(String(params.requestId || ''));
      if (!original) return;
      const status = Number(params.response?.status);
      original.status = Number.isFinite(status) ? status : null;
      original.resource_type = String(params.type || original.resource_type).slice(0,35);
    }));
    unsubscribe.push(session.observe('Network.loadingFailed', params => {
      const original = requests.get(String(params.requestId || ''));
      if (original) original.failed = true;
    }));
  }
  try {
    if (action === 'console') {
      await session.send('Runtime.enable');
      await session.send('Log.enable');
    } else await session.send('Network.enable', { maxTotalBufferSize: 1_000_000 });
    await new Promise(resolve => setTimeout(resolve, durationMs));
  } finally {
    for (const stop of unsubscribe) stop();
    if (action === 'console') {
      await Promise.allSettled([session.send('Log.disable'), session.send('Runtime.disable')]);
    } else await session.send('Network.disable').catch(() => {});
  }
  return { action, sampled_ms:durationMs, counts, events, truncated:Object.values(counts).reduce((a,b) => a+b,0) > maxEvents,
    note:'Live events only; DevTools does not backfill events recorded before sampling. Request/response contents and headers are excluded.' };
}
export async function browserDevtools(args = {}) {
  const action = requireEnum(args.action, 'action', ['console','network','performance','layout','accessibility','geometry']);
  const durationMs = clamp(args.sample_ms, 1500, 250, 5000);
  const maxEvents = clamp(args.max_events, 50, 1, 100);
  return withTarget(args, async (session,target) =>
    jsonResult({ target_id:target.id, url:safeDevtoolsUrl(target.url),
      ...(await sampleBrowserDevtools(session,action,durationMs,maxEvents)) }));
}
