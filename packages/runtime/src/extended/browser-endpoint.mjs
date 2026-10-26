import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { resolveSafePath } from '../util.mjs';
import { selectSafeBrowserLaunchProfile } from './browser-session-backup.mjs';
import { shouldRestoreBrowserSession } from './browser-session-directory.mjs';
import { shareBrowserDiscovery } from './browser-discovery-flight.mjs';
import { observeBrowserLaunchExit, browserLaunchExitHint } from './browser-launch-lifecycle.mjs';
import { clamp, commandExists, jsonResult, optionalString, requireEnum, spawnDetached, unavailable } from './common.mjs';
import {
  endpointUrl, endpointAuthority, isLoopbackHost, normalizedHost,
  safePageUrl, assertResolvedPageUrl, productionBrowserPolicyReady,
} from './browser-policy.mjs';
export * from './browser-policy.mjs';

export const MAX_DISCOVERY_BYTES = 8 * 1024 * 1024;
export const MAX_CDP_MESSAGE_BYTES = 16 * 1024 * 1024;
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

export { shouldRestoreBrowserSession };

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
  if (endpoint || process.env.REMCP_CDP_URL) return false;
  if (await browserCapabilityAvailable(undefined, 250)) return false;
  if (!browserLaunchPromise) {
    browserLaunchPromise = (async () => {
      const executable = browserExecutable();
      if (!executable) throw new Error('Browser control is unavailable: no supported Chrome, Edge, or Chromium executable was found');
      const profile = browserDataDir();
      mkdirSync(profile, { recursive:true, mode:0o700 });
      // Chrome rotates its Sessions/ files on startup. Protect existing local
      // evidence before a restart, including profiles with only Tabs_* left.
      const selected = selectSafeBrowserLaunchProfile(profile);
      if (selected.isolated) console.warn('ReMCP browser: using an isolated recovery profile; existing session and backups are preserved, and sign-in state is not copied.');
      const restore = shouldRestoreBrowserSession(selected.profile);
      const startedAt = Date.now();
      spawnDetached(executable, browserAutoLaunchArgs(selected.profile), {
        onExit:value => observeBrowserLaunchExit(value, { startedAt, restore, isolated:selected.isolated }),
        onError:({ code }) => observeBrowserLaunchExit({ error:code || 'UNKNOWN' },
          { startedAt, restore, isolated:selected.isolated }),
      });
      if (!await waitForBrowserEndpoint(5000)) throw new Error('ReMCP launched a browser but its local CDP endpoint did not become ready');
      return true;
    })().finally(() => { browserLaunchPromise = null; });
  }
  return browserLaunchPromise;
}

export async function browserControlAvailable(endpoint, timeoutMs = 500) {
  if (!browserRemoteEnabled()) return false;
  if (process.env.NODE_ENV === 'production' && !productionBrowserPolicyReady()) return false;
  if (await browserCapabilityAvailable(endpoint, timeoutMs)) return true;
  if (endpoint || process.env.REMCP_CDP_URL) return false;
  return browserAutoLaunchAvailable();
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
export async function filterBrowserTargets(list, { validate = assertResolvedPageUrl, targetId = null, titleContains = null, urlContains = null, endpoint = null } = {}) {
  if (!Array.isArray(list)) return [];
  const candidates = [];
  const titleNeedle = String(titleContains || '').toLowerCase();
  const urlNeedle = String(urlContains || '').toLowerCase();
  for (const item of list) {
    if (!item || item.type !== 'page' || !item.webSocketDebuggerUrl) continue;
    if (targetId && item.id !== targetId) continue;
    // Filter untrusted CDP metadata before expensive URL/DNS validation, but
    // still validate every matching URL before it can reach the caller.
    if (titleNeedle && !String(item.title || '').toLowerCase().includes(titleNeedle)) continue;
    if (urlNeedle && !String(item.url || '').toLowerCase().includes(urlNeedle)) continue;
    // Reject fabricated/stale CDP socket metadata *before* DNS validation.
    // browser_tabs must never advertise a target that cannot pass chooseTarget.
    if (endpoint) {
      try { validatedTargetWebSocketUrl(item, endpoint); }
      catch { continue; }
    }
    candidates.push(item);
    if (candidates.length >= 1000) break;
  }
  const safe = new Array(candidates.length).fill(false);
  // A single tab-list request may contain hundreds of pages on the same host.
  // Every URL is still checked independently for scheme, credentials and private
  // targets; the bounded DNS/allowlist decision is shared *only within this call*.
  // Never cache across requests: every new call must revalidate DNS rebinding.
  const sharedHostChecks = validate === assertResolvedPageUrl ? new Map() : null;
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const index = cursor++;
      try {
        const rawUrl = candidates[index].url;
        if (sharedHostChecks) {
          const parsedUrl = safePageUrl(rawUrl);
          // about:blank has no DNS and should not alias a real host.
          const host = parsedUrl === 'about:blank' ? null : normalizedHost(new URL(parsedUrl).hostname);
          if (host) {
            if (!sharedHostChecks.has(host)) {
              sharedHostChecks.set(host, Promise.resolve().then(() => validate(parsedUrl)));
            }
            await sharedHostChecks.get(host);
          } else {
            await validate(parsedUrl);
          }
        } else {
          // Custom validators can have URL/path-specific policy: do not coalesce.
          await validate(rawUrl);
        }
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

export async function listBrowserTargets(endpoint, { targetId = null, titleContains = null, urlContains = null, readOnlySingleFlight = false, validate = assertResolvedPageUrl } = {}) {
  assertBrowserRemoteEnabled();
  // Reading tabs and page semantics must not launch a separate Chromium/profile.
  // Only an explicit browser_navigate(action=new_tab) can bootstrap an isolated browser.
  const base = endpointUrl(endpoint); // keeps the CDP address loopback-only
  let list;
  try {
    const load = () => requestJson('/json/list', endpoint, { timeout_ms: 1500 });
    list = readOnlySingleFlight && !base.username && !base.password
      ? await shareBrowserDiscovery(base.origin, load) : await load();
  } catch (error) {
    const message = String(error?.message || '');
    // Keep HTTP/policy/oversize/malformed-response errors distinct from an unavailable CDP.
    if (!/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|abort|timed out|network error/i.test(message)) throw error;
    const configured = Boolean(endpoint || process.env.REMCP_CDP_URL);
    const label = configured ? 'The configured CDP endpoint' : 'Browser CDP endpoint';
    throw new Error(`${label} is unavailable at ${base.origin}. Read-only browser_tabs and browser_snapshot do not launch a browser. Use ui_snapshot and ui_find for the existing browser window; do not retry this CDP endpoint unchanged. Only browser_navigate(action=new_tab), when explicitly requested, may start a local isolated browser.${browserLaunchExitHint({ configured })}`);
  }
  // Retain the current bounded concurrent DNS/security checks for up to 1000 tabs.
  return filterBrowserTargets(list, { targetId, titleContains, urlContains, validate, endpoint:base });
}

export function validatedTargetWebSocketUrl(target, endpoint) {
  let socketUrl;
  try { socketUrl = new URL(String(target?.webSocketDebuggerUrl)); }
  catch { throw new Error('Browser returned an invalid CDP WebSocket URL'); }
  const targetId = String(target?.id ?? '');
  if (!targetId || targetId.length > 256 || socketUrl.username || socketUrl.password ||
    socketUrl.search || socketUrl.hash) {
    throw new Error('Browser returned an invalid CDP WebSocket target');
  }
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
