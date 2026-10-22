// Browser navigation, CDP-origin and evaluation policies. No CDP transport or session state.
import process from 'node:process';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { optionalString } from './common.mjs';

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:9222';
export const MAX_EVALUATION_BYTES = 256 * 1024;
export const BROWSER_PROTOCOLS = new Set(['http:', 'https:']);
export const BLOCKED_BROWSER_SCHEME = /(?:^|[\s"'`(=])(?:file|chrome|devtools|view-source|filesystem|blob|wss?):/i;
export const BLOCKED_BROWSER_NETWORK_API = /\b(?:fetch|WebSocket|EventSource|XMLHttpRequest|sendBeacon)\b/;

export function boundedText(value, max = 1000) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function normalizedHost(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

export function isLoopbackHost(hostname) {
  const host = normalizedHost(hostname);
  return ['localhost', '127.0.0.1', '::1'].includes(host);
}

export function localBrowserNavigationAllowed() {
  if (process.env.NODE_ENV === 'production') return false;
  return ['REMCP_BROWSER_ALLOW_LOCAL_NAVIGATION', 'REMCP_BROWSER_ALLOW_LOCAL', 'REMCP_ALLOW_LOCAL_BROWSER_NAVIGATION']
    .some(name => ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase()));
}

export function isPrivateIpv4(host) {
  if (isIP(host) !== 4) return false;
  const parts = host.split('.').map(Number);
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

export function isPrivateIpv6(host) {
  if (isIP(host) !== 6) return false;
  if (host === '::' || host === '::1') return true;
  if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('ff')) return true;
  const mapped = host.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return isPrivateIpv4([high >> 8, high & 255, low >> 8, low & 255].join('.'));
  }
  return false;
}

export function isPrivateBrowserHost(hostname) {
  const host = normalizedHost(hostname);
  if (!host) return true;
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) return true;
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.home.arpa')
    || host.endsWith('.lan')
    || host === 'localhost.localdomain'
    || host === 'ip6-localhost'
    || host === 'ip6-loopback';
}

export function endpointUrl(value) {
  if (value != null && typeof value !== 'string' && !(value instanceof URL)) {
    throw new Error('endpoint must be a valid local http(s) URL');
  }
  let url;
  try {
    const provided = value instanceof URL ? value.href : optionalString(value);
    url = new URL(provided || process.env.REMCP_CDP_URL || DEFAULT_ENDPOINT);
  } catch { throw new Error('endpoint must be a valid local http(s) URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('endpoint must use http or https');
  if (!isLoopbackHost(url.hostname)) throw new Error('Browser CDP endpoint must be loopback-only');
  if (url.username || url.password) throw new Error('Browser CDP endpoint must not contain credentials');
  return url;
}

export function endpointAuthority(url) {
  const port = url.port || ((url.protocol === 'https:' || url.protocol === 'wss:') ? '443' : '80');
  return `${normalizedHost(url.hostname)}:${port}`;
}

export function safeBrowserUrl(value, field = 'url') {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new Error(`${field} must be a valid absolute URL`); }
  if (!BROWSER_PROTOCOLS.has(url.protocol)) throw new Error(`${field} must use http or https`);
  if (url.username || url.password) throw new Error(`${field} must not embed credentials`);
  if (!localBrowserNavigationAllowed() && isPrivateBrowserHost(url.hostname)) {
    throw new Error(`${field} must not target loopback, private, or link-local addresses`);
  }
  return url.href;
}

export function safePageUrl(value, field = 'browser page URL') {
  if (String(value || '') === 'about:blank') return value;
  return safeBrowserUrl(value, field);
}

export function configuredBrowserHosts() {
  return String(process.env.REMCP_BROWSER_ALLOWED_HOSTS || '')
    .split(/[,\s]+/)
    .map(normalizedHost)
    .filter(Boolean);
}

export function browserHostAllowlisted(host) {
  return configuredBrowserHosts().some(pattern => pattern === host
    || (pattern.startsWith('*.') && host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1));
}

export function browserDnsRebindingExplicitlyAllowed() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.REMCP_BROWSER_ALLOW_DNS_REBIND || '').trim().toLowerCase());
}

export function productionBrowserPolicyReady() {
  const hosts = configuredBrowserHosts();
  return (hosts.length > 0 && hosts.some(isIP))
    || (browserDnsRebindingExplicitlyAllowed() && hosts.length > 0);
}

export async function assertResolvedBrowserUrl(value, field = 'browser URL') {
  const safe = safeBrowserUrl(value, field);
  if (localBrowserNavigationAllowed() && process.env.NODE_ENV !== 'production') return safe;
  const host = normalizedHost(new URL(safe).hostname);
  if (process.env.NODE_ENV === 'production' && !browserHostAllowlisted(host)) {
    throw new Error(`${field} host is not in REMCP_BROWSER_ALLOWED_HOSTS`);
  }
  if (isIP(host) || (host.endsWith('.test') && process.env.NODE_ENV !== 'production')) return safe;
  if (process.env.NODE_ENV === 'production' && !isIP(host) && !browserDnsRebindingExplicitlyAllowed()) {
    throw new Error(`${field} requires an IP-literal allowlist in production; set REMCP_BROWSER_ALLOW_DNS_REBIND=1 only with a DNS/egress boundary`);
  }
  let addresses;
  try { addresses = await lookup(host, { all:true, verbatim:true }); }
  catch (error) { throw new Error(`${field} host could not be resolved safely: ${error instanceof Error ? error.message : String(error)}`); }
  if (addresses.some(address => isPrivateBrowserHost(address.address))) {
    throw new Error(`${field} must not resolve to loopback, private, or link-local addresses`);
  }
  return safe;
}

export async function assertResolvedPageUrl(value, field = 'browser page URL') {
  if (String(value || '') === 'about:blank') return value;
  return assertResolvedBrowserUrl(value, field);
}

export function expressionHasPrivateDestination(expression) {
  const urls = expression.match(/(?:https?|wss?):\/\/[^\s"'`<>]+/gi) || [];
  return urls.some(value => {
    try { return isPrivateBrowserHost(new URL(value).hostname); }
    catch { return false; }
  });
}

export function safeEvaluationExpression(value) {
  const expression = String(value || '');
  if (!expression.trim()) throw new Error('expression is required');
  if (expression.includes('\0') || Buffer.byteLength(expression, 'utf8') > MAX_EVALUATION_BYTES) {
    throw new Error(`expression must be at most ${MAX_EVALUATION_BYTES} bytes`);
  }
  if (BLOCKED_BROWSER_SCHEME.test(expression)) throw new Error('expression contains a blocked local browser scheme');
  if (!localBrowserNavigationAllowed() && (expressionHasPrivateDestination(expression) || BLOCKED_BROWSER_NETWORK_API.test(expression))) {
    throw new Error('expression contains a blocked private browser destination or network API');
  }
  return expression;
}

export async function assertSafeEvaluationExpression(value) {
  const expression = safeEvaluationExpression(value);
  const urls = expression.match(/(?:https?|wss?):\/\/[^\s"'`<>]+/gi) || [];
  await Promise.all(urls.map(url => assertResolvedBrowserUrl(url, 'expression destination')));
  return expression;
}
