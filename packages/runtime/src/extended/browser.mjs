import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { resolveSafePath } from '../util.mjs';
import { clamp, commandExists, jsonResult, optionalString, requireEnum, spawnDetached, unavailable } from './common.mjs';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:9222';
const MAX_DISCOVERY_BYTES = 8 * 1024 * 1024;
const MAX_CDP_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_EVALUATION_BYTES = 256 * 1024;
const BROWSER_PROTOCOLS = new Set(['http:', 'https:']);
const BLOCKED_BROWSER_SCHEME = /(?:^|[\s"'`(=])(?:file|chrome|devtools|view-source|filesystem|blob|wss?):/i;
const BLOCKED_BROWSER_NETWORK_API = /\b(?:fetch|WebSocket|EventSource|XMLHttpRequest|sendBeacon)\b/;
const PRODUCTION_SESSION_IDLE_MS = 10 * 60 * 1000;
const productionBrowserSessions = new Map();

let browserLaunchPromise = null;

function browserExecutable() {
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

function assertBrowserRemoteEnabled() {
  if (!browserRemoteEnabled()) throw new Error('Browser control is disabled for remote runtime; set REMCP_BROWSER_REMOTE_ENABLED=1 only on a trusted local runtime');
}

function browserDataDir() {
  const configured = optionalString(process.env.REMCP_BROWSER_DATA_DIR);
  if (configured) return configured;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'ReMCP', 'browser-cdp');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'ReMCP', 'browser-cdp');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'remcp', 'browser-cdp');
}

async function waitForBrowserEndpoint(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await browserCapabilityAvailable(undefined, 250)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return false;
}

async function ensureBrowserEndpoint(endpoint) {
  assertBrowserRemoteEnabled();
  if (endpoint || process.env.REMCP_CDP_URL) return;
  if (await browserCapabilityAvailable(undefined, 250)) return;
  if (!browserLaunchPromise) {
    browserLaunchPromise = (async () => {
      const executable = browserExecutable();
      if (!executable) throw new Error('Browser control is unavailable: no supported Chrome, Edge, or Chromium executable was found');
      const profile = browserDataDir();
      mkdirSync(profile, { recursive:true, mode:0o700 });
      const args = [
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=9222',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank',
      ];
      if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) args.unshift('--headless=new');
      spawnDetached(executable, args);
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

function boundedText(value, max = 1000) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function normalizedHost(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function isLoopbackHost(hostname) {
  const host = normalizedHost(hostname);
  return ['localhost', '127.0.0.1', '::1'].includes(host);
}

function localBrowserNavigationAllowed() {
  if (process.env.NODE_ENV === 'production') return false;
  return ['REMCP_BROWSER_ALLOW_LOCAL_NAVIGATION', 'REMCP_BROWSER_ALLOW_LOCAL', 'REMCP_ALLOW_LOCAL_BROWSER_NAVIGATION']
    .some(name => ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase()));
}

function isPrivateIpv4(host) {
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

function isPrivateIpv6(host) {
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

function isPrivateBrowserHost(hostname) {
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

function endpointUrl(value) {
  let url;
  try { url = new URL(optionalString(value) || process.env.REMCP_CDP_URL || DEFAULT_ENDPOINT); }
  catch { throw new Error('endpoint must be a valid local http(s) URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('endpoint must use http or https');
  if (!isLoopbackHost(url.hostname)) throw new Error('Browser CDP endpoint must be loopback-only');
  return url;
}

function endpointAuthority(url) {
  const port = url.port || ((url.protocol === 'https:' || url.protocol === 'wss:') ? '443' : '80');
  return `${normalizedHost(url.hostname)}:${port}`;
}

function safeBrowserUrl(value, field = 'url') {
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

function safePageUrl(value, field = 'browser page URL') {
  if (String(value || '') === 'about:blank') return value;
  return safeBrowserUrl(value, field);
}

function configuredBrowserHosts() {
  return String(process.env.REMCP_BROWSER_ALLOWED_HOSTS || '')
    .split(/[,\s]+/)
    .map(normalizedHost)
    .filter(Boolean);
}

function browserHostAllowlisted(host) {
  return configuredBrowserHosts().some(pattern => pattern === host
    || (pattern.startsWith('*.') && host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1));
}

function browserDnsRebindingExplicitlyAllowed() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.REMCP_BROWSER_ALLOW_DNS_REBIND || '').trim().toLowerCase());
}

function productionBrowserPolicyReady() {
  const hosts = configuredBrowserHosts();
  return (hosts.length > 0 && hosts.some(isIP))
    || (browserDnsRebindingExplicitlyAllowed() && hosts.length > 0);
}

async function assertResolvedBrowserUrl(value, field = 'browser URL') {
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

async function assertResolvedPageUrl(value, field = 'browser page URL') {
  if (String(value || '') === 'about:blank') return value;
  return assertResolvedBrowserUrl(value, field);
}

function expressionHasPrivateDestination(expression) {
  const urls = expression.match(/(?:https?|wss?):\/\/[^\s"'`<>]+/gi) || [];
  return urls.some(value => {
    try { return isPrivateBrowserHost(new URL(value).hostname); }
    catch { return false; }
  });
}

function safeEvaluationExpression(value) {
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

async function assertSafeEvaluationExpression(value) {
  const expression = safeEvaluationExpression(value);
  const urls = expression.match(/(?:https?|wss?):\/\/[^\s"'`<>]+/gi) || [];
  await Promise.all(urls.map(url => assertResolvedBrowserUrl(url, 'expression destination')));
  return expression;
}

async function requestJson(pathname, endpoint, options = {}) {
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

export async function listBrowserTargets(endpoint) {
  assertBrowserRemoteEnabled();
  await ensureBrowserEndpoint(endpoint);
  const list = await requestJson('/json/list', endpoint);
  if (!Array.isArray(list)) return [];
  const targets = [];
  for (const item of list) {
    if (!item || item.type !== 'page' || !item.webSocketDebuggerUrl) continue;
    try {
      await assertResolvedPageUrl(item.url);
      targets.push(item);
    } catch {}
  }
  return targets;
}

function validatedTargetWebSocketUrl(target, endpoint) {
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

async function chooseTarget(args = {}) {
  const targets = (await listBrowserTargets(args.endpoint)).filter(item => item.type === 'page' && item.webSocketDebuggerUrl);
  const id = optionalString(args.target_id || args.targetId);
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

class CdpSession {
  constructor(url, timeoutMs) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Map();
    this.observers = new Map();
    this.closed = true;
  }

  async open() {
    if (typeof WebSocket !== 'function') throw new Error('This Node.js runtime does not provide WebSocket support');
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      const timer = setTimeout(() => {
        try { socket.close(); } catch {}
        reject(new Error('CDP websocket connection timed out'));
      }, this.timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); this.socket = socket; this.closed = false; resolve(); }, { once: true });
      socket.addEventListener('error', event => { clearTimeout(timer); try { socket.close(); } catch {}; reject(new Error(event?.message || 'CDP websocket error')); }, { once: true });
      socket.addEventListener('message', event => this.onMessage(event));
      socket.addEventListener('close', () => this.onClose());
    });
    return this;
  }

  onMessage(event) {
    const raw = String(event.data);
    if (Buffer.byteLength(raw, 'utf8') > MAX_CDP_MESSAGE_BYTES) {
      this.close();
      return;
    }
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    const sessionId = String(message.sessionId || '');
    const pendingKey = message.id ? `${sessionId}:${message.id}` : '';
    if (message.id && this.pending.has(pendingKey)) {
      const pending = this.pending.get(pendingKey);
      this.pending.delete(pendingKey);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result || {});
      return;
    }
    const observers = this.observers.get(message.method);
    if (observers) {
      for (const observer of [...observers]) {
        try { observer(message.params || {}, sessionId); } catch {}
      }
    }
    const listeners = this.waiters.get(message.method);
    if (!listeners) return;
    this.waiters.delete(message.method);
    for (const listener of listeners) {
      clearTimeout(listener.timer);
      listener.resolve(message.params || {});
    }
  }

  onClose() {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CDP websocket closed'));
    }
    this.pending.clear();
    for (const listeners of this.waiters.values()) {
      for (const listener of listeners) {
        clearTimeout(listener.timer);
        listener.reject(new Error('CDP websocket closed'));
      }
    }
    this.waiters.clear();
    this.observers.clear();
  }

  observe(method, callback) {
    const listeners = this.observers.get(method) || new Set();
    listeners.add(callback);
    this.observers.set(method, listeners);
    return () => {
      const current = this.observers.get(method);
      if (!current) return;
      current.delete(callback);
      if (!current.size) this.observers.delete(method);
    };
  }

  send(method, params = {}, sessionId = '', timeoutMs = this.timeoutMs) {
    if (this.closed || !this.socket || this.socket.readyState !== 1) {
      return Promise.reject(new Error('CDP websocket is not open'));
    }
    const id = this.nextId++;
    const key = `${sessionId}:${id}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  waitFor(method, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const listeners = this.waiters.get(method) || [];
      const listener = { resolve, reject, timer: null };
      listener.timer = setTimeout(() => {
        const current = this.waiters.get(method) || [];
        const next = current.filter(item => item !== listener);
        if (next.length) this.waiters.set(method, next); else this.waiters.delete(method);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      listeners.push(listener);
      this.waiters.set(method, listeners);
    });
  }

  close() {
    if (this.closed) return;
    try { this.socket?.close(); } catch {}
    this.onClose();
  }
}

async function installBrowserRequestGuard(session, { closeRootTarget = async () => {} } = {}) {
  const guardedSessions = new Set();
  const childSetup = new Map();
  const enableSession = async (sessionId, { autoAttach = false } = {}) => {
    if (guardedSessions.has(sessionId)) return;
    try {
      await session.send('Network.enable', {}, sessionId, 2000);
      await session.send('Network.setBlockedURLs', { urls:['ws://*', 'wss://*'] }, sessionId, 2000);
      await session.send('Fetch.enable', { patterns:[{ urlPattern:'*' }] }, sessionId, 2000);
      if (autoAttach) await session.send('Target.setAutoAttach', { autoAttach:true, waitForDebuggerOnStart:true, flatten:true }, sessionId, 2000);
      guardedSessions.add(sessionId);
    } catch (error) {
      await session.send('Fetch.disable', {}, sessionId, 1000).catch(() => {});
      throw error;
    }
  };
  const guardChild = params => {
    const childSessionId = String(params?.sessionId || '');
    if (!childSessionId) return Promise.resolve();
    if (childSetup.has(childSessionId)) return childSetup.get(childSessionId);
    const setup = (async () => {
      try {
        await enableSession(childSessionId, { autoAttach:process.env.NODE_ENV === 'production' });
        await session.send('Runtime.runIfWaitingForDebugger', {}, childSessionId, 2000);
      } catch (error) {
        const targetId = params?.targetInfo?.targetId;
        let closed = false;
        if (targetId) {
          try {
            await session.send('Target.closeTarget', { targetId }, '', 2000);
            closed = true;
          } catch {}
        }
        if (!closed) throw new Error(`Browser child guard failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    childSetup.set(childSessionId, setup);
    return setup;
  };
  const removePaused = session.observe('Fetch.requestPaused', (params, eventSessionId) => {
    const requestId = params?.requestId;
    const requestUrl = params?.request?.url || '';
    void (async () => {
      let allowed = requestUrl === 'about:blank';
      if (!allowed) {
        try { await assertResolvedBrowserUrl(requestUrl, 'browser request'); allowed = true; }
        catch {}
      }
      if (!requestId) return;
      try {
        if (allowed) await session.send('Fetch.continueRequest', { requestId }, eventSessionId);
        else await session.send('Fetch.failRequest', { requestId, errorReason:'BlockedByClient' }, eventSessionId);
      } catch {}
    })();
  });
  const removeAttached = session.observe('Target.attachedToTarget', params => {
    void guardChild(params).catch(async () => {
      await closeRootTarget().catch(() => {});
      session.close();
    });
  });
  await enableSession('');
  if (process.env.NODE_ENV === 'production') {
    await session.send('Target.setAutoAttach', { autoAttach:true, waitForDebuggerOnStart:true, flatten:true }, '', 2000);
    let existing;
    try {
      existing = await session.send('Target.getTargets', {}, '', 2000);
    } catch (error) {
      throw new Error(`Could not enumerate browser child targets safely: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const targetInfo of existing.targetInfos || []) {
      if (!['worker', 'service_worker', 'shared_worker', 'iframe', 'webview'].includes(targetInfo.type)) continue;
      const attached = await session.send('Target.attachToTarget', { targetId:targetInfo.targetId, flatten:true }, '', 2000).catch(async error => {
        await session.send('Target.closeTarget', { targetId:targetInfo.targetId }, '', 2000).catch(() => {});
        throw new Error(`Could not attach browser child target safely: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (attached?.sessionId) await guardChild({ sessionId:attached.sessionId, targetInfo });
      else {
        await session.send('Target.closeTarget', { targetId:targetInfo.targetId }, '', 2000).catch(() => {});
        throw new Error('Browser child target did not expose a guard session');
      }
    }
  }
  return () => {
    childSetup.clear();
    removePaused();
    removeAttached();
  };
}

async function closeBrowserTarget(endpoint, targetId) {
  if (!targetId) return false;
  try {
    const base = endpoint instanceof URL ? endpoint.href : endpoint;
    await requestJson(`/json/close/${encodeURIComponent(String(targetId))}`, base, { timeout_ms:2000 });
    return true;
  } catch {
    return false;
  }
}

function productionSessionKey(endpoint, target) {
  return `${endpoint.origin}|${String(target.id)}`;
}

function closeProductionSession(key, record) {
  if (!record) return;
  if (record.timer) clearTimeout(record.timer);
  record.removeGuard();
  if (record.ownedTarget && record.targetId) {
    record.session.send('Target.closeTarget', { targetId:record.targetId }, '', 2000).catch(() => {});
    if (record.endpoint) void closeBrowserTarget(record.endpoint, record.targetId);
  }
  record.session.send('Fetch.disable').catch(() => {});
  record.session.close();
  if (productionBrowserSessions.get(key) === record) productionBrowserSessions.delete(key);
}

function retainProductionSession(key, session, removeGuard, targetId, endpoint, ownedTarget = false) {
  const existing = productionBrowserSessions.get(key);
  if (existing) closeProductionSession(key, existing);
  const record = { session, removeGuard, targetId, endpoint, ownedTarget, timer:null };
  productionBrowserSessions.set(key, record);
  const schedule = () => {
    if (record.timer) clearTimeout(record.timer);
    record.timer = setTimeout(() => closeProductionSession(key, record), PRODUCTION_SESSION_IDLE_MS);
    record.timer.unref?.();
  };
  record.schedule = schedule;
  schedule();
  return record;
}

async function createGuardedNewTab(url, args) {
  await ensureBrowserEndpoint(args.endpoint);
  const created = await requestJson('/json/new', args.endpoint, { method:'PUT', timeout_ms:args.timeout_ms });
  if (!created?.id) throw new Error('Browser did not return a new page target');
  const endpoint = endpointUrl(args.endpoint);
  let target;
  try {
    target = { ...created, webSocketDebuggerUrl: validatedTargetWebSocketUrl(created, endpoint) };
  } catch (error) {
    await closeBrowserTarget(endpoint, created.id);
    throw error;
  }
  let session;
  try {
    session = await new CdpSession(target.webSocketDebuggerUrl, clamp(args.timeout_ms, 10_000, 100, 120_000)).open();
  } catch (error) {
    await closeBrowserTarget(endpoint, target.id);
    throw error;
  }
  let removeGuard = () => {};
  let productionRecord = null;
  let productionKey = '';
  let operationFailed = false;
  try {
    removeGuard = await installBrowserRequestGuard(session, { closeRootTarget:() => closeBrowserTarget(endpoint, target.id) });
    if (process.env.NODE_ENV === 'production') {
      productionKey = productionSessionKey(endpoint, target);
      productionRecord = retainProductionSession(productionKey, session, removeGuard, target.id, endpoint, true);
    }
    await session.send('Page.enable');
    const loaded = session.waitFor('Page.loadEventFired', clamp(args.timeout_ms, 15_000, 500, 120_000)).catch(() => null);
    const navigation = await session.send('Page.navigate', { url });
    if (loaded) await loaded;
    const finalUrl = await evaluate(session, 'location.href');
    await assertResolvedPageUrl(finalUrl);
    return { target, navigation, finalUrl };
  } catch (error) {
    operationFailed = true;
    if (!productionRecord) await closeBrowserTarget(endpoint, target.id);
    throw error;
  } finally {
    if (productionRecord) {
      if (operationFailed) closeProductionSession(productionKey, productionRecord);
      else productionRecord.schedule();
    }
    else {
      removeGuard();
      await session.send('Fetch.disable').catch(() => {});
      session.close();
    }
  }
}

async function withTarget(args, callback) {
  const target = await chooseTarget(args);
  await assertResolvedPageUrl(target.url);
  const endpoint = endpointUrl(args.endpoint);
  const production = process.env.NODE_ENV === 'production';
  const key = production ? productionSessionKey(endpoint, target) : '';
  let record = production ? productionBrowserSessions.get(key) : null;
  if (record?.session?.closed || (record?.session?.socket && record.session.socket.readyState !== 1)) {
    closeProductionSession(key, record);
    record = null;
  }
  let session = record?.session;
  let removeGuard = record?.removeGuard || (() => {});
  if (!session) {
    try {
      session = await new CdpSession(target.webSocketDebuggerUrl, clamp(args.timeout_ms, 10_000, 100, 120_000)).open();
      removeGuard = await installBrowserRequestGuard(session);
      if (production) record = retainProductionSession(key, session, removeGuard, target.id, endpoint);
    } catch (error) {
      removeGuard();
      if (session) {
        await session.send('Fetch.disable').catch(() => {});
        session.close();
      }
      throw error;
    }
  }
  let operationFailed = false;
  try {
    const currentUrl = await evaluate(session, 'location.href');
    await assertResolvedPageUrl(currentUrl);
    const result = await callback(session, target);
    const finalUrl = await evaluate(session, 'location.href').catch(() => { throw new Error('Browser page URL could not be verified after the operation'); });
    await assertResolvedPageUrl(finalUrl);
    return result;
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    if (production && record) {
      if (operationFailed) closeProductionSession(key, record);
      else record.schedule();
    }
    else {
      removeGuard();
      await session.send('Fetch.disable').catch(() => {});
      session.close();
    }
  }
}

async function evaluate(session, expression, awaitPromise = true) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'JavaScript evaluation failed');
  }
  return result.result?.value;
}

async function callPageFunction(session, functionDeclaration, args = [], awaitPromise = true) {
  const global = await session.send('Runtime.evaluate', {
    expression: 'globalThis',
    returnByValue: false,
    awaitPromise: false,
  });
  if (global.exceptionDetails || !global.result?.objectId) {
    throw new Error(global.exceptionDetails?.exception?.description || global.exceptionDetails?.text || 'Could not access the page execution context');
  }
  const result = await session.send('Runtime.callFunctionOn', {
    objectId: global.result.objectId,
    functionDeclaration,
    arguments: args.map(value => ({ value })),
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'JavaScript function call failed');
  }
  return result.result?.value;
}

export async function browserTabs(args = {}) {
  const targets = await listBrowserTargets(args.endpoint);
  return jsonResult(targets.filter(item => item.type === 'page').slice(0, 500).map(item => ({
    id: boundedText(item.id, 256),
    title: boundedText(item.title, 1000),
    url: boundedText(item.url, 4096),
    description: boundedText(item.description, 1000),
  })));
}

async function waitForHistoryReady(session, expectedUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const state = await evaluate(session, '({url:location.href,ready:document.readyState})').catch(() => null);
    if (state?.ready === 'complete' && (!expectedUrl || state.url === expectedUrl)) return true;
    await new Promise(resolve => setTimeout(resolve, 75));
  } while (Date.now() < deadline);
  return false;
}

export async function browserNavigate(args = {}) {
  const requestedUrl = optionalString(args.url);
  const action = requireEnum(args.action || (requestedUrl ? 'url' : 'reload'), 'action', ['url','new_tab','back','forward','reload']);
  const url = ['url','new_tab'].includes(action) ? await assertResolvedBrowserUrl(requestedUrl, 'url') : null;
  if (['url','new_tab'].includes(action) && !url) throw new Error('url is required when action=url or new_tab');
  if (action === 'new_tab') {
    if (process.env.NODE_ENV === 'production') {
      const opened = await createGuardedNewTab(url, args);
      return jsonResult({
        target_id: opened.target.id,
        action,
        url: opened.finalUrl,
        title: opened.target.title || '',
        error_text: opened.navigation?.errorText || null,
      });
    }
    await ensureBrowserEndpoint(args.endpoint);
    const created = await requestJson(`/json/new?${encodeURIComponent(url)}`, args.endpoint, { method:'PUT', timeout_ms:args.timeout_ms });
    return jsonResult({
      target_id:created?.id || null,
      action,
      url:created?.url ? await assertResolvedPageUrl(created.url) : url,
      title:created?.title || '',
    });
  }
  return withTarget(args, async (session, target) => {
    await session.send('Page.enable');
    const timeoutMs = clamp(args.timeout_ms, 15_000, 500, 120_000);
    const loaded = args.wait === false || ['back','forward'].includes(action)
      ? null
      : session.waitFor('Page.loadEventFired', timeoutMs).catch(() => null);
    let frameId = null;
    let errorText = null;
    let historyUrl = null;
    if (action === 'url') {
      const result = await session.send('Page.navigate', { url });
      frameId = result.frameId || null;
      errorText = result.errorText || null;
    } else if (action === 'reload') {
      await session.send('Page.reload', { ignoreCache: Boolean(args.ignore_cache) });
    } else {
      const history = await session.send('Page.getNavigationHistory');
      const current = Number(history.currentIndex || 0);
      const nextIndex = action === 'back' ? current - 1 : current + 1;
      const entry = Array.isArray(history.entries) ? history.entries[nextIndex] : null;
      if (!entry) throw new Error(`Cannot navigate ${action}: no history entry is available`);
      historyUrl = entry.url ? await assertResolvedPageUrl(entry.url, 'history URL') : null;
      await session.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    }
    if (loaded) await loaded;
    if (args.wait !== false && ['back','forward'].includes(action)) {
      await waitForHistoryReady(session, historyUrl, timeoutMs);
    }
    const currentUrl = await evaluate(session, 'location.href').catch(() => url || target.url || null);
    if (currentUrl) await assertResolvedPageUrl(currentUrl);
    return jsonResult({ target_id: target.id, action, url: currentUrl, frame_id: frameId, error_text: errorText });
  });
}

export async function browserSnapshot(args) {
  return withTarget(args, async (session, target) => {
    await session.send('Accessibility.enable');
    const { nodes = [] } = await session.send('Accessibility.getFullAXTree');
    const limit = clamp(args.max_nodes, 1500, 1, 10_000);
    const simplified = nodes.slice(0, limit).map(node => ({
      node_id: boundedText(node.nodeId, 256),
      ignored: Boolean(node.ignored),
      role: boundedText(node.role?.value, 256),
      name: boundedText(node.name?.value, 1000),
      value: boundedText(node.value?.value, 1000),
      description: boundedText(node.description?.value, 1000),
      child_ids: Array.isArray(node.childIds) ? node.childIds.slice(0, 200).map(id => boundedText(id, 256)) : [],
      backend_dom_node_id: node.backendDOMNodeId || null,
    }));
    const payload = {
      target_id: target.id,
      title: target.title,
      url: target.url,
      count: simplified.length,
      truncated: nodes.length > limit,
      nodes: simplified,
    };
    if (!args.include_screenshot) return jsonResult(payload);

    await session.send('Page.enable');
    const selector = optionalString(args.selector);
    let restoreScroll = null;
    if (selector) {
      const bounds = await evaluate(session, `new Promise((resolve,reject) => {
        const el=document.querySelector(${JSON.stringify(selector)});
        if(!el){reject(new Error('Screenshot element not found'));return;}
        const originalScrollX=scrollX, originalScrollY=scrollY;
        const initial=el.getBoundingClientRect();
        const desiredTop=Math.max(0, scrollY + initial.top - Math.max(0,(innerHeight-initial.height)/2));
        window.scrollTo({top:desiredTop,left:scrollX,behavior:'instant'});
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const r=el.getBoundingClientRect();
          resolve({
            x:r.x,
            y:r.y,
            width:r.width,
            height:r.height,
            viewport_width:innerWidth,
            viewport_height:innerHeight,
            scroll_x:scrollX,
            scroll_y:scrollY,
            original_scroll_x:originalScrollX,
            original_scroll_y:originalScrollY,
            fully_visible:r.x>=0 && r.y>=0 && r.right<=innerWidth && r.bottom<=innerHeight
          });
        }));
      })`);
      if (!bounds || !Number.isFinite(Number(bounds.width)) || !Number.isFinite(Number(bounds.height)) || bounds.width <= 0 || bounds.height <= 0) {
        throw new Error('Screenshot element has invalid bounds');
      }
      restoreScroll = { x:Number(bounds.original_scroll_x || 0), y:Number(bounds.original_scroll_y || 0) };
      const { original_scroll_x: _originalX, original_scroll_y: _originalY, ...reportedBounds } = bounds;
      payload.screenshot_target = { selector, ...reportedBounds };
    }
    payload.screenshot = {
      scope: 'viewport',
      width: await evaluate(session, 'innerWidth').catch(() => null),
      height: await evaluate(session, 'innerHeight').catch(() => null),
    };
    const result = jsonResult(payload);
    let captured;
    try {
      captured = await session.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      });
    } finally {
      if (restoreScroll) {
        await evaluate(session, `window.scrollTo({left:${restoreScroll.x},top:${restoreScroll.y},behavior:'instant'})`).catch(() => {});
      }
    }
    const data = String(captured?.data || '');
    if (!data) throw new Error('CDP returned no screenshot data');
    if (Buffer.byteLength(data, 'base64') > 8 * 1024 * 1024) throw new Error('Browser screenshot exceeds the 8 MiB inline image limit');
    result.content.push({ type:'image', data, mimeType:'image/png' });
    return result;
  });
}

export function findExpression(args) {
  const selector = optionalString(args.selector);
  const needle = optionalString(args.text);
  const role = optionalString(args.role);
  const limit = clamp(args.limit, 20, 1, 200);
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const needle = ${JSON.stringify(needle)};
    const role = ${JSON.stringify(role)};
    const source = selector ? Array.from(document.querySelectorAll(selector)) : Array.from(document.querySelectorAll('*'));
    function cssPath(el) {
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      while (el && el.nodeType === 1 && el !== document.documentElement) {
        let part = el.tagName.toLowerCase();
        if (el.parentElement) {
          const same = Array.from(el.parentElement.children).filter(x => x.tagName === el.tagName);
          if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
        }
        parts.unshift(part); el = el.parentElement;
      }
      return parts.join(' > ');
    }
    function semanticRole(el) {
      const explicit = (el.getAttribute('role') || '').trim().toLowerCase();
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'button') return 'button';
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      if (tag === 'option') return 'option';
      if (tag === 'img') return 'img';
      if (tag === 'progress') return 'progressbar';
      if (tag === 'meter') return 'meter';
      if (tag === 'summary') return 'button';
      if (tag === 'input') {
        const type = String(el.type || 'text').toLowerCase();
        if (['button','submit','reset','image'].includes(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        if (!['hidden','file','color'].includes(type)) return 'textbox';
      }
      return '';
    }
    function visibleText(el) {
      return (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
    }
    function textQuality(value) {
      if (!needle) return 0;
      const hay = value.toLowerCase();
      const wanted = needle.toLowerCase();
      if (hay === wanted) return 0;
      if (hay.startsWith(wanted)) return 1;
      return 2;
    }
    function depthOf(el) {
      let depth = 0;
      for (let current = el.parentElement; current; current = current.parentElement) depth += 1;
      return depth;
    }
    const candidates = source.filter(el => {
      const style = getComputedStyle(el);
      const visible = style.visibility !== 'hidden' && style.display !== 'none' && el.getClientRects().length > 0;
      const hay = visibleText(el);
      const r = semanticRole(el);
      return visible && (!needle || hay.toLowerCase().includes(needle.toLowerCase())) && (!role || r === role.toLowerCase());
    }).map((el, index) => ({
      el,
      index,
      text: visibleText(el),
      role: semanticRole(el),
      depth: depthOf(el),
    }));
    let selected = candidates;
    if (needle && !selector) {
      selected = [...candidates].sort((a, b) =>
        textQuality(a.text) - textQuality(b.text)
        || Number(!a.role) - Number(!b.role)
        || a.text.length - b.text.length
        || b.depth - a.depth
        || a.index - b.index
      );
      const deduped = [];
      for (const candidate of selected) {
        if (deduped.some(existing => existing.el.contains(candidate.el) || candidate.el.contains(existing.el))) continue;
        deduped.push(candidate);
        if (deduped.length >= ${limit}) break;
      }
      selected = deduped;
    } else {
      selected = selected.slice(0, ${limit});
    }
    return selected.map(({ el }) => {
      const b = el.getBoundingClientRect();
      return { selector: cssPath(el), tag: el.tagName.toLowerCase(), role: semanticRole(el), name: el.getAttribute('aria-label') || el.getAttribute('name') || '', text: visibleText(el).slice(0, 500), value: 'value' in el ? String(el.value).slice(0, 500) : '', x: b.x, y: b.y, width: b.width, height: b.height, disabled: Boolean(el.disabled) };
    });
  })()`;
}

export async function browserFind(args) {
  if (!(args.selector || args.text || args.role)) throw new Error('browser_find requires selector, text, or role; use browser_snapshot to enumerate page structure');
  return withTarget(args, async (session, target) => {
    const matches = await evaluate(session, findExpression(args));
    return jsonResult({ target_id: target.id, count: Array.isArray(matches) ? matches.length : 0, matches: Array.isArray(matches) ? matches : [] });
  });
}

const PAGE_SCROLL_ACTION = `function(selector, needle, deltaX, deltaY) {
  let target = selector ? document.querySelector(selector) : null;
  if (!target && needle) {
    const lower = String(needle).toLowerCase();
    target = Array.from(document.querySelectorAll('*')).find(node =>
      String(node.innerText || node.textContent || '').trim().toLowerCase().includes(lower)
    ) || null;
  }
  if ((selector || needle) && !target) throw new Error('Element not found');

  let scroller = document.scrollingElement || document.documentElement;
  if (target) {
    let current = target;
    while (current && current !== document.documentElement) {
      const style = getComputedStyle(current);
      const scrollX = /(auto|scroll|overlay)/.test(String(style.overflowX || '')) && current.scrollWidth > current.clientWidth;
      const scrollY = /(auto|scroll|overlay)/.test(String(style.overflowY || '')) && current.scrollHeight > current.clientHeight;
      if (scrollX || scrollY) {
        scroller = current;
        break;
      }
      current = current.parentElement;
    }
  }

  const beforeX = Number(scroller.scrollLeft || 0);
  const beforeY = Number(scroller.scrollTop || 0);
  scroller.scrollLeft = beforeX + Number(deltaX || 0);
  scroller.scrollTop = beforeY + Number(deltaY || 0);
  return {
    target: target ? target.tagName.toLowerCase() : 'page',
    scroller: scroller === document.scrollingElement || scroller === document.documentElement ? 'page' : scroller.tagName.toLowerCase(),
    before_x: beforeX,
    before_y: beforeY,
    after_x: Number(scroller.scrollLeft || 0),
    after_y: Number(scroller.scrollTop || 0),
    delta_x: Number(deltaX || 0),
    delta_y: Number(deltaY || 0),
  };
}`;

const PAGE_ELEMENT_ACTION = `function(selector, needle, action, value) {
  let el = selector ? document.querySelector(selector) : null;
  if (!el && needle) {
    const lower = String(needle).toLowerCase();
    el = Array.from(document.querySelectorAll('*')).find(node =>
      String(node.innerText || node.textContent || '').trim().toLowerCase().includes(lower)
    ) || null;
  }
  if (!el) throw new Error('Element not found');
  if (action === 'click' || action === 'type' || action === 'scroll_into_view') {
    el.scrollIntoView({block:'center', inline:'center'});
  }
  if (action === 'focus' || action === 'type') el.focus();
  if (action === 'select') {
    el.value = value;
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
  } else if (action === 'set_value') {
    const proto = Object.getPrototypeOf(el);
    const own = Object.getOwnPropertyDescriptor(proto, 'value');
    const parent = Object.getPrototypeOf(proto);
    const inherited = parent ? Object.getOwnPropertyDescriptor(parent, 'value') : null;
    const setter = own?.set || inherited?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
  }
  const b = el.getBoundingClientRect();
  if (action === 'click' && (!b.width || !b.height)) throw new Error('Element has no clickable bounds');
  return {
    tag: el.tagName.toLowerCase(),
    value: 'value' in el ? String(el.value) : '',
    x: b.x, y: b.y, width: b.width, height: b.height,
  };
}`;

export function browserActionLocatorText(args = {}, action = '') {
  const explicit = optionalString(args.browser_text || args.match_text);
  if (explicit) return explicit;
  if (action === 'type') {
    // Legacy type calls used text as the locator and value/text_value as the payload.
    if (!optionalString(args.selector) && (args.value != null || args.text_value != null)) return optionalString(args.text);
    return null;
  }
  return optionalString(args.text);
}

export function browserActionInputValue(args = {}, action = '') {
  if (action === 'type') {
    if (!optionalString(args.selector) && !optionalString(args.browser_text || args.match_text) && (args.value != null || args.text_value != null)) {
      return String(args.text_value ?? args.value ?? '');
    }
    return String(args.text ?? args.text_value ?? args.value ?? '');
  }
  return String(args.value ?? args.text_value ?? args.text ?? '');
}

export function browserScrollDeltas(args = {}) {
  const direction = optionalString(args.direction);
  const hasDelta = [args.delta_x,args.delta_y,args.delta].some(value => value != null && Number.isFinite(Number(value)));
  if (!direction && !hasDelta) return null;
  const times = clamp(args.wheel_times, 1, 1, 50);
  let deltaX = Number(args.delta_x || 0);
  let deltaY = Number(args.delta_y ?? args.delta ?? 0);
  if (direction) {
    const normalized = requireEnum(direction, 'direction', ['up','down','left','right']);
    if (normalized === 'up') deltaY = -120 * times;
    if (normalized === 'down') deltaY = 120 * times;
    if (normalized === 'left') deltaX = -120 * times;
    if (normalized === 'right') deltaX = 120 * times;
  }
  return { delta_x:deltaX, delta_y:deltaY };
}

export async function browserAction(args) {
  const action = requireEnum(args.action, 'action', ['click', 'focus', 'type', 'set_value', 'select', 'scroll', 'scroll_into_view', 'upload', 'press', 'set_viewport']);
  return withTarget(args, async (session, target) => {
    if (action === 'set_viewport') {
      const width = clamp(args.width, 1280, 200, 8192);
      const height = clamp(args.height, 720, 200, 8192);
      const deviceScaleFactor = Math.max(0.1, Math.min(8, Number(args.device_scale_factor) || 1));
      await session.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor,
        mobile: Boolean(args.mobile),
        screenWidth: width,
        screenHeight: height,
      });
      return jsonResult({ target_id:target.id, action, width, height, device_scale_factor:deviceScaleFactor, mobile:Boolean(args.mobile) });
    }
    if (action === 'upload') {
      const selector = optionalString(args.selector);
      if (!selector) throw new Error('selector is required for upload');
      const requested = (Array.isArray(args.paths) ? args.paths : [args.path]).filter(Boolean);
      if (!requested.length) throw new Error('path or paths is required for upload');
      const files = [];
      for (const value of requested) files.push(await resolveSafePath(value, 'path'));
      await session.send('DOM.enable');
      const doc = await session.send('DOM.getDocument', { depth: 1 });
      const found = await session.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
      if (!found.nodeId) throw new Error(`No element matches selector ${selector}`);
      await session.send('DOM.setFileInputFiles', { nodeId: found.nodeId, files });
      return jsonResult({ target_id: target.id, action, selector, files: files.length });
    }
    if (action === 'press') {
      const key = optionalString(args.key);
      if (!key) throw new Error('key is required for press');
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key });
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
      return jsonResult({ target_id: target.id, action, key });
    }
    const selector = optionalString(args.selector);
    const needle = browserActionLocatorText(args, action);
    const value = browserActionInputValue(args, action);
    const option = String(args.option ?? value);

    if (action === 'scroll') {
      const deltas = browserScrollDeltas(args);
      if (!deltas) throw new Error('browser_action scroll requires direction or a delta');
      return jsonResult({
        target_id: target.id,
        action,
        result: await callPageFunction(session, PAGE_SCROLL_ACTION, [selector, needle, deltas.delta_x, deltas.delta_y]),
      });
    }

    if (!selector && !needle) throw new Error('selector or browser_text/text locator is required');

    if (action === 'click') {
      const rect = await callPageFunction(session, PAGE_ELEMENT_ACTION, [selector, needle, 'click', '']);
      const x = Number(rect.x) + Number(rect.width) / 2;
      const y = Number(rect.y) + Number(rect.height) / 2;
      await session.send('Input.dispatchMouseEvent', { type:'mouseMoved', x, y, button:'none' });
      await session.send('Input.dispatchMouseEvent', { type:'mousePressed', x, y, button:'left', clickCount:1 });
      await session.send('Input.dispatchMouseEvent', { type:'mouseReleased', x, y, button:'left', clickCount:1 });
      return jsonResult({ target_id:target.id, action, result:{ ...rect, x, y } });
    }

    if (action === 'type') {
      const focused = await callPageFunction(session, PAGE_ELEMENT_ACTION, [selector, needle, 'type', '']);
      if (args.clear === true) await callPageFunction(session, PAGE_ELEMENT_ACTION, [selector, needle, 'set_value', '']);
      await session.send('Input.insertText', { text:value });
      const current = await callPageFunction(session, PAGE_ELEMENT_ACTION, [selector, needle, 'read_value', '']);
      return jsonResult({ target_id:target.id, action, result:{ ...focused, value:current.value } });
    }

    const pageValue = action === 'select' ? option : value;
    return jsonResult({
      target_id: target.id,
      action,
      result: await callPageFunction(session, PAGE_ELEMENT_ACTION, [selector, needle, action, pageValue]),
    });
  });
}

export async function browserWait(args = {}) {
  const condition = requireEnum(args.condition || 'selector', 'condition', ['selector', 'text', 'url_contains', 'expression', 'load', 'navigation', 'network_idle']);
  const timeoutMs = clamp(args.timeout_ms, 10_000, 100, 120_000);
  const pollMs = clamp(args.poll_ms, 200, 50, 5000);
  const idleMs = clamp(args.idle_ms, 500, 100, 10_000);
  const wanted = optionalString(args.selector || args.text || args.value || args.expression);
  if (['selector','text','url_contains','expression'].includes(condition) && !wanted) throw new Error('selector/text/value/expression is required for this condition');
  if (condition === 'expression') await assertSafeEvaluationExpression(wanted);
  return withTarget(args, async (session, target) => {
    const started = Date.now();
    const initialUrl = await evaluate(session, 'location.href').catch(() => target.url || '');
    const inflight = new Set();
    let lastResourceCount = -1;
    let stableSince = Date.now();
    const unsubscribers = [];
    if (condition === 'network_idle') {
      await session.send('Network.enable');
      const markBusy = params => {
        if (params?.requestId) inflight.add(params.requestId);
        stableSince = Date.now();
      };
      const markDone = params => {
        if (params?.requestId) inflight.delete(params.requestId);
        stableSince = Date.now();
      };
      unsubscribers.push(
        session.observe('Network.requestWillBeSent', markBusy),
        session.observe('Network.loadingFinished', markDone),
        session.observe('Network.loadingFailed', markDone),
      );
    }
    try {
      while (Date.now() - started < timeoutMs) {
        let matched = false;
        if (condition === 'network_idle') {
          const state = await evaluate(session, `({ready:document.readyState,resources:performance.getEntriesByType('resource').length})`).catch(() => null);
          if (state) {
            if (state.resources !== lastResourceCount) {
              lastResourceCount = state.resources;
              stableSince = Date.now();
            }
            matched = state.ready === 'complete' && inflight.size === 0 && Date.now() - stableSince >= idleMs;
          }
        } else {
          const expression = condition === 'selector' ? `Boolean(document.querySelector(${JSON.stringify(wanted)}))`
            : condition === 'text' ? `(document.body?.innerText||'').toLowerCase().includes(${JSON.stringify(wanted?.toLowerCase())})`
            : condition === 'url_contains' ? `location.href.includes(${JSON.stringify(wanted)})`
            : condition === 'load' ? `document.readyState === 'complete'`
            : condition === 'navigation' ? `location.href !== ${JSON.stringify(initialUrl)}`
            : `Boolean(${wanted})`;
          matched = Boolean(await evaluate(session, expression));
        }
        if (matched) return jsonResult({
          target_id: target.id,
          condition,
          matched: true,
          elapsed_ms: Date.now() - started,
          ...(condition === 'network_idle' ? { inflight: inflight.size, idle_ms: idleMs } : {}),
          url: await evaluate(session, 'location.href').catch(() => target.url || null),
        });
        await new Promise(resolve => setTimeout(resolve, pollMs));
      }
      return jsonResult({
        target_id: target.id,
        condition,
        matched: false,
        elapsed_ms: Date.now() - started,
        ...(condition === 'network_idle' ? { inflight: inflight.size, idle_ms: idleMs } : {}),
        url: await evaluate(session, 'location.href').catch(() => target.url || null),
      });
    } finally {
      for (const unsubscribe of unsubscribers) unsubscribe();
    }
  });
}

export async function browserEvaluate(args) {
  assertBrowserRemoteEnabled();
  const expression = await assertSafeEvaluationExpression(args.expression);
  return withTarget(args, async (session, target) => jsonResult({ target_id: target.id, value: await evaluate(session, expression, args.await_promise !== false) }));
}

export const browserHandlers = {
  browser_tabs: browserTabs,
  browser_navigate: browserNavigate,
  browser_snapshot: browserSnapshot,
  browser_find: browserFind,
  browser_action: browserAction,
  browser_wait: browserWait,
  browser_evaluate: browserEvaluate,
};
