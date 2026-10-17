import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { closeSync, constants as fsConstants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { resolveSafePath } from '../util.mjs';
import { preserveInterruptedBrowserSession } from './browser-session-backup.mjs';
import { clamp, commandExists, jsonResult, optionalString, requireEnum, spawnDetached, unavailable } from './common.mjs';



export const DEFAULT_ENDPOINT = 'http://127.0.0.1:9222';
export const MAX_DISCOVERY_BYTES = 8 * 1024 * 1024;
export const MAX_CDP_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_EVALUATION_BYTES = 256 * 1024;
export const BROWSER_PROTOCOLS = new Set(['http:', 'https:']);
export const BLOCKED_BROWSER_SCHEME = /(?:^|[\s"'`(=])(?:file|chrome|devtools|view-source|filesystem|blob|wss?):/i;
export const BLOCKED_BROWSER_NETWORK_API = /\b(?:fetch|WebSocket|EventSource|XMLHttpRequest|sendBeacon)\b/;
export const PRODUCTION_SESSION_IDLE_MS = 10 * 60 * 1000;
export const productionBrowserSessions = new Map();

export let browserLaunchPromise = null;

export function browserExecutable() {
  const configured = optionalString(process.env.REMCP_BROWSER_BINARY);
  const candidates = configured ? [configured] : process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]
    : process.platform === 'win32'
      ? [
          path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ]
      : ['/opt/google/chrome/chrome','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','chromium','chromium-browser','microsoft-edge','microsoft-edge-stable'];
  return candidates.find(candidate => path.isAbsolute(candidate) ? existsSync(candidate) : commandExists(candidate)) || null;
}

export function browserAutoLaunchAvailable() {
  return Boolean(browserExecutable());
}

export function browserRemoteEnabled() {
  const configured = String(process.env.REMCP_BROWSER_REMOTE_ENABLED || '').trim().toLowerCase();
  if (configured) return ['1', 'true', 'yes', 'on'].includes(configured);
  return ['development', 'test'].includes(String(process.env.NODE_ENV || '').trim().toLowerCase());
}

export function assertBrowserRemoteEnabled() {
  if (!browserRemoteEnabled()) throw new Error('Browser control is disabled for remote runtime; set REMCP_BROWSER_REMOTE_ENABLED=1 only on a trusted local runtime');
}

export function browserDataDir() {
  const configured = optionalString(process.env.REMCP_BROWSER_DATA_DIR);
  if (configured) return configured;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'ReMCP', 'browser-cdp');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'ReMCP', 'browser-cdp');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'remcp', 'browser-cdp');
}

// Browser sessions belong to the local user, not to the lifetime of the ReMCP
// agent. The agent can be restarted by an npm update while Chrome is open.
// If Chrome was interrupted and already persisted tabs, ask Chromium itself to
// restore the session. Never parse, persist, or relay the sensitive tab URLs.
// A clean user-initiated quit must not resurrect a deliberately closed session.
export function shouldRestoreBrowserSession(profile) {
  let prefsFd;
  let sessionFd;
  try {
    const defaultProfile = path.join(profile, 'Default');
    // Open first, then validate the file descriptor: checking the path with
    // lstat before reading it creates a symlink-swap TOCTOU vulnerability.
    prefsFd = openSync(path.join(defaultProfile, 'Preferences'),
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const prefsStat = fstatSync(prefsFd);
    if (!prefsStat.isFile() || prefsStat.size > 4 * 1024 * 1024) return false;
    const prefs = JSON.parse(readFileSync(prefsFd, 'utf8'));
    if (prefs?.profile?.exit_type !== 'Crashed') return false;

    const sessionDir = path.join(defaultProfile, 'Sessions');
    let readableDir = sessionDir;
    if (process.platform !== 'win32') {
      // Use the opened directory even if another process renames the path.
      // O_NOFOLLOW refuses a linked Sessions directory on Unix platforms.
      sessionFd = openSync(sessionDir,
        fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | (fsConstants.O_NOFOLLOW || 0));
      if (!fstatSync(sessionFd).isDirectory()) return false;
      readableDir = `${process.platform === 'darwin' ? '/dev/fd' : '/proc/self/fd'}/${sessionFd}`;
    }
    return readdirSync(readableDir).some(name => {
      if (!/^Tabs_\d+$/.test(name)) return false;
      let tabFd;
      try {
        tabFd = openSync(path.join(readableDir, name),
          fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
        const stat = fstatSync(tabFd);
        return stat.isFile() && stat.size > 0;
      } catch { return false; }
      finally { if (tabFd !== undefined) closeSync(tabFd); }
    });
  } catch {
    // A new, malformed or inaccessible profile must start fresh, not fail CDP.
    return false;
  } finally {
    if (sessionFd !== undefined) closeSync(sessionFd);
    if (prefsFd !== undefined) closeSync(prefsFd);
  }
}

export function browserAutoLaunchArgs(profile, {
  platform = process.platform,
  display = process.env.DISPLAY,
  waylandDisplay = process.env.WAYLAND_DISPLAY,
} = {}) {
  const restore = shouldRestoreBrowserSession(profile);
  const args = [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9222',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    // --restore-last-session only for an interrupted, persisted local profile.
    // An explicit about:blank startup URL would suppress the normal restore.
    ...(restore ? ['--restore-last-session'] : ['about:blank']),
  ];
  if (platform === 'linux' && !display && !waylandDisplay) args.unshift('--headless=new');
  return args;
}

export async function waitForBrowserEndpoint(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await browserCapabilityAvailable(undefined, 250)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return false;
}

export async function ensureBrowserEndpoint(endpoint) {
  assertBrowserRemoteEnabled();
  if (endpoint || process.env.REMCP_CDP_URL) return;
  if (await browserCapabilityAvailable(undefined, 250)) return;
  if (!browserLaunchPromise) {
    browserLaunchPromise = (async () => {
      const executable = browserExecutable();
      if (!executable) throw new Error('Browser control is unavailable: no supported Chrome, Edge, or Chromium executable was found');
      const profile = browserDataDir();
      mkdirSync(profile, { recursive:true, mode:0o700 });
      // Chrome rotates its Sessions/ files on startup. Protect existing local
      // evidence before a restart, including profiles with only Tabs_* left.
      preserveInterruptedBrowserSession(profile);
      spawnDetached(executable, browserAutoLaunchArgs(profile));
      if (!await waitForBrowserEndpoint(5000)) throw new Error('ReMCP launched a browser but its local CDP endpoint did not become ready');
    })().finally(() => { browserLaunchPromise = null; });
  }
  await browserLaunchPromise;
}

export async function browserControlAvailable(endpoint, timeoutMs = 500) {
  if (!browserRemoteEnabled()) return false;
  if (process.env.NODE_ENV === 'production' && !productionBrowserPolicyReady()) return false;
  if (await browserCapabilityAvailable(endpoint, timeoutMs)) return true;
  if (endpoint || process.env.REMCP_CDP_URL) return false;
  return browserAutoLaunchAvailable();
}

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
  let url;
  try { url = new URL(optionalString(value) || process.env.REMCP_CDP_URL || DEFAULT_ENDPOINT); }
  catch { throw new Error('endpoint must be a valid local http(s) URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('endpoint must use http or https');
  if (!isLoopbackHost(url.hostname)) throw new Error('Browser CDP endpoint must be loopback-only');
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

export async function requestJson(pathname, endpoint, options = {}) {
  const base = endpointUrl(endpoint);
  const url = new URL(pathname, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), clamp(options.timeout_ms, 5000, 100, 30_000));
  try {
    const response = await fetch(url, { method: options.method || 'GET', signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_DISCOVERY_BYTES) throw new Error(`CDP discovery response is too large (${declared} bytes)`);
    const reader = response.body?.getReader();
    if (!reader) return JSON.parse(await response.text());
    const chunks = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DISCOVERY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`CDP discovery response exceeded ${MAX_DISCOVERY_BYTES} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch (error) {
    throw new Error(`Could not reach Chrome DevTools Protocol at ${base.origin}: ${error instanceof Error ? error.message : String(error)}. Start Chrome/Edge with --remote-debugging-port=9222.`);
  } finally {
    clearTimeout(timer);
  }
}

export async function browserCapabilityAvailable(endpoint, timeoutMs = 500) {
  try {
    const version = await requestJson('/json/version', endpoint, { timeout_ms: timeoutMs });
    return Boolean(version && typeof version === 'object' && (version.Browser || version.webSocketDebuggerUrl));
  } catch {
    return false;
  }
}

// Validating every tab sequentially can require hundreds of serial DNS lookups,
// making browser_tabs exceed the relay's deadline on machines with many tabs.
// Keep DNS and security validation, but bound both the work and its concurrency.
export async function filterBrowserTargets(list, { validate = assertResolvedPageUrl, targetId = null } = {}) {
  if (!Array.isArray(list)) return [];
  const candidates = [];
  for (const item of list) {
    if (!item || item.type !== 'page' || !item.webSocketDebuggerUrl) continue;
    if (targetId && item.id !== targetId) continue;
    candidates.push(item);
    if (candidates.length >= 1000) break;
  }
  const safe = new Array(candidates.length).fill(false);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const index = cursor++;
      try {
        await validate(candidates[index].url);
        safe[index] = true;
      } catch {
        // Exclude unsafe/unresolvable pages without exposing them to the caller.
      }
    }
  }));
  const targets = [];
  for (let i = 0; i < candidates.length && targets.length < 500; i++) {
    if (safe[i]) targets.push(candidates[i]);
  }
  return targets;
}

export async function listBrowserTargets(endpoint, { targetId = null } = {}) {
  assertBrowserRemoteEnabled();
  // Reading tabs and page semantics must not launch a separate Chromium/profile.
  // Only an explicit browser_navigate(action=new_tab) can bootstrap an isolated browser.
  const base = endpointUrl(endpoint); // keeps the CDP address loopback-only
  let list;
  try {
    list = await requestJson('/json/list', endpoint, { timeout_ms: 1500 });
  } catch (error) {
    const message = String(error?.message || '');
    // Keep HTTP/policy/oversize/malformed-response errors distinct from an unavailable CDP.
    if (!/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|abort|timed out|network error/i.test(message)) throw error;
    const configured = Boolean(endpoint || process.env.REMCP_CDP_URL);
    const label = configured ? 'The configured CDP endpoint' : 'Browser CDP endpoint';
    throw new Error(`${label} is unavailable at ${base.origin}. Read-only browser_tabs and browser_snapshot do not launch a browser. Use ui_snapshot and ui_find for the existing browser window; do not retry this CDP endpoint unchanged. Only browser_navigate(action=new_tab), when explicitly requested, may start a local isolated browser.`);
  }
  // Retain the current bounded concurrent DNS/security checks for up to 1000 tabs.
  return filterBrowserTargets(list, { targetId });
}

export function validatedTargetWebSocketUrl(target, endpoint) {
  let socketUrl;
  try { socketUrl = new URL(String(target?.webSocketDebuggerUrl)); }
  catch { throw new Error('Browser returned an invalid CDP WebSocket URL'); }
  if (!['ws:', 'wss:'].includes(socketUrl.protocol) || !isLoopbackHost(socketUrl.hostname)) {
    throw new Error('Browser CDP WebSocket target must be loopback-only');
  }
  if (endpointAuthority(socketUrl) !== endpointAuthority(endpoint)
    || socketUrl.pathname !== `/devtools/page/${encodeURIComponent(String(target.id))}`) {
    throw new Error('Browser CDP WebSocket target must match the configured loopback page endpoint');
  }
  return socketUrl.href;
}

export async function chooseTarget(args = {}) {
  const id = optionalString(args.target_id || args.targetId);
  // Explicit target IDs are returned by browser_tabs. Never DNS-resolve every
  // unrelated tab merely to act on one target: validate only its actual URL.
  const targets = await listBrowserTargets(args.endpoint, { targetId:id });
  const title = optionalString(args.title);
  const urlContains = optionalString(args.url_contains || args.urlContains);
  const matched = targets.find(item =>
    (!id || item.id === id) &&
    (!title || String(item.title || '').toLowerCase().includes(title.toLowerCase())) &&
    (!urlContains || String(item.url || '').toLowerCase().includes(urlContains.toLowerCase()))
  );
  const hasSelector = Boolean(id || title || urlContains);
  const target = matched || (hasSelector ? null : targets[0]);
  if (!target) {
    if (hasSelector) throw new Error('No browser page target matched the requested selector');
    unavailable('Browser control', 'no debuggable page target is available');
  }
  const endpoint = endpointUrl(args.endpoint);
  return { ...target, webSocketDebuggerUrl: validatedTargetWebSocketUrl(target, endpoint) };
}
