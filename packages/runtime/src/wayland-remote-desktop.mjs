import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runtimeConfigDir } from './config.mjs';
import { ToolError } from './util.mjs';
import { createWaylandInput } from './wayland-remote-desktop-input.mjs';
import { cleanError, unwrap, token, withTimeout } from './wayland-remote-desktop-utils.mjs';

const PORTAL_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const REMOTE_INTERFACE = 'org.freedesktop.portal.RemoteDesktop';
const REQUEST_INTERFACE = 'org.freedesktop.portal.Request';
const SESSION_INTERFACE = 'org.freedesktop.portal.Session';
const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DEVICES = 1 | 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const portalStateDir = path.resolve(process.env.REMCP_RUNTIME_PORTAL_STATE_DIR || runtimeConfigDir);
const TOKEN_FILE = path.join(portalStateDir, 'remote-desktop-portal.json');
const EIS_HELPER = fileURLToPath(new URL('./helpers/wayland-eis-helper.py', import.meta.url));
const EIS_LIB_CANDIDATES = ['/lib/x86_64-linux-gnu/libei.so.1','/usr/lib/x86_64-linux-gnu/libei.so.1','/lib/aarch64-linux-gnu/libei.so.1','/usr/lib/aarch64-linux-gnu/libei.so.1'];

let active = null;
let starting = null;
let dbusModule = null;

async function loadDbus() {
  dbusModule ||= await import('@jellybrick/dbus-next');
  return dbusModule;
}

async function waitForBusName(bus, timeoutMs) {
  if (typeof bus.name === 'string' && bus.name.startsWith(':')) return bus.name;
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      bus.off?.('connect', onConnect);
      bus.off?.('error', onError);
    };
    const onConnect = () => {
      if (typeof bus.name !== 'string' || !bus.name.startsWith(':')) {
        cleanup();
        reject(new ToolError('session D-Bus connected without a unique bus name'));
        return;
      }
      const name = bus.name;
      cleanup();
      resolve(name);
    };
    const onError = error => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    bus.once('connect', onConnect);
    bus.once('error', onError);
    timer = setTimeout(() => {
      cleanup();
      reject(new ToolError(`session D-Bus did not connect within ${timeoutMs} ms`));
    }, timeoutMs);
  });
}

function requestPath(uniqueBusName, requestToken) {
  const sender = uniqueBusName.replace(/^:/, '').replace(/\./g, '_');
  return `/org/freedesktop/portal/desktop/request/${sender}/${requestToken}`;
}

function matchRule() {
  return `type='signal',sender='${PORTAL_NAME}',interface='${REQUEST_INTERFACE}',member='Response'`;
}

function dbusMatchMessage(dbus, member, rule) {
  return new dbus.Message({
    destination: DBUS_NAME,
    path: DBUS_PATH,
    interface: DBUS_NAME,
    member,
    signature: 's',
    body: [rule],
  });
}

function responseCollector(bus, dbus, initialPath, timeoutMs) {
  let targetPath = initialPath;
  let settled = false;
  const buffered = new Map();
  let resolveResponse;
  const promise = new Promise(resolve => { resolveResponse = resolve; });
  const finish = value => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveResponse(value);
  };
  const onMessage = message => {
    if (message?.type !== dbus.MessageType.SIGNAL) return;
    if (message.interface !== REQUEST_INTERFACE || message.member !== 'Response') return;
    if (typeof message.path !== 'string') return;
    const value = {
      response: Number(message.body?.[0]),
      results: unwrap(message.body?.[1] || {}),
    };
    if (message.path === targetPath) finish(value);
    else buffered.set(message.path, value);
  };
  const timer = setTimeout(() => finish({ timeout: true, results: {} }), timeoutMs);
  bus.on('message', onMessage);
  return {
    promise,
    setPath(value) {
      targetPath = value;
      const bufferedValue = buffered.get(value);
      if (bufferedValue) finish(bufferedValue);
    },
    stop() {
      clearTimeout(timer);
      bus.off?.('message', onMessage);
    },
  };
}

async function portalRequest(context, label, call, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { bus, dbus, uniqueBusName } = context;
  const requestToken = token(label);
  const rule = matchRule();
  const collector = responseCollector(bus, dbus, requestPath(uniqueBusName, requestToken), timeoutMs);
  let installed = false;
  try {
    await withTimeout(bus.call(dbusMatchMessage(dbus, 'AddMatch', rule)), Math.min(timeoutMs, 5000), `${label} signal subscription`);
    installed = true;
    const handle = await withTimeout(call(requestToken), Math.min(timeoutMs, 10_000), `${label} request`);
    if (typeof handle !== 'string' || !handle.startsWith('/')) throw new ToolError(`${label} returned an invalid request handle`);
    collector.setPath(handle);
    const response = await collector.promise;
    if (response.timeout) throw new ToolError(`${label} timed out after ${timeoutMs} ms`);
    if (response.response === 1) throw new ToolError(`${label} was cancelled on the computer`);
    if (response.response !== 0) throw new ToolError(`${label} was denied by the desktop portal (response ${response.response})`);
    return response.results;
  } finally {
    collector.stop();
    if (installed) {
      try { await bus.call(dbusMatchMessage(dbus, 'RemoveMatch', rule)); } catch {}
    }
  }
}

async function readRestoreToken() {
  try {
    const parsed = JSON.parse(await readFile(TOKEN_FILE, 'utf8'));
    return typeof parsed.restore_token === 'string' && parsed.restore_token ? parsed.restore_token : null;
  } catch {
    return null;
  }
}

async function persistRestoreToken(restoreToken) {
  if (!restoreToken) return;
  await mkdir(portalStateDir, { recursive: true, mode: 0o700 });
  await writeFile(TOKEN_FILE, `${JSON.stringify({ version: 1, restore_token: restoreToken }, null, 2)}\n`, { mode: 0o600 });
}

async function clearRestoreToken() {
  await rm(TOKEN_FILE, { force: true }).catch(() => {});
}

function eisUnsupported(error) {
  return Boolean(error && typeof error === 'object' && error.eisUnsupported === true);
}

function eisHelperCandidate(env = process.env) {
  if (process.platform !== 'linux' || !existsSync(EIS_HELPER)) return false;
  if (!/wayland/i.test(String(env.XDG_SESSION_TYPE || '')) && !env.WAYLAND_DISPLAY) return false;
  return true;
}

function helperError(message, stderr = '') {
  const detail = cleanError(message?.error || stderr || 'EIS helper failed');
  const error = new ToolError(`Wayland EIS input failed: ${detail}`);
  if (message?.kind === 'unsupported') error.eisUnsupported = true;
  return error;
}

async function createWaylandEisSession({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  parentWindow = '',
  env = process.env,
  readToken = readRestoreToken,
  persistToken = persistRestoreToken,
} = {}) {
  if (!eisHelperCandidate(env)) {
    const error = new ToolError('Wayland EIS helper prerequisites are unavailable');
    error.eisUnsupported = true;
    throw error;
  }

  const restoreToken = await readToken();
  const python = existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
  const child = spawn(python, [EIS_HELPER], {
    env: {
      ...env,
      REMCP_EIS_TIMEOUT_MS:String(Math.max(1000, Math.min(120_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))),
      REMCP_EIS_PARENT_WINDOW:String(parentWindow || ''),
      REMCP_EIS_RESTORE_TOKEN:restoreToken || '',
    },
    stdio:['pipe','pipe','pipe'],
  });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  let stderr = '';
  let buffer = '';
  let readySettled = false;
  let requestId = 0;
  const pending = new Map();
  let state = null;

  const failPending = error => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (readySettled) return;
      readySettled = true;
      try { child.kill('SIGTERM'); } catch {}
      reject(new ToolError(`Wayland EIS helper timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    const settleReady = async message => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(timer);
      if (!message?.ready) {
        reject(helperError(message, stderr));
        return;
      }
      try {
        if (typeof message.restore_token === 'string' && message.restore_token) await persistToken(message.restore_token);
      } catch (error) {
        reject(error);
        return;
      }
      state = {
        backend:'xdg-eis',
        child,
        devices:Number(message.devices || 0),
        capabilities:message.capabilities && typeof message.capabilities === 'object' ? { ...message.capabilities } : {},
        send(payload, commandTimeoutMs = 5000) {
          if (!child.stdin || child.exitCode != null || child.killed) {
            return Promise.reject(new ToolError('Wayland EIS helper is not running'));
          }
          const id = ++requestId;
          return new Promise((resolveCommand, rejectCommand) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectCommand(new ToolError(`Wayland EIS ${payload.op || 'command'} timed out after ${commandTimeoutMs} ms`));
            }, commandTimeoutMs);
            pending.set(id, { resolve:resolveCommand, reject:rejectCommand, timer });
            try {
              child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`, error => {
                if (!error) return;
                const entry = pending.get(id);
                if (!entry) return;
                pending.delete(id);
                clearTimeout(entry.timer);
                entry.reject(error);
              });
            } catch (error) {
              const entry = pending.get(id);
              if (entry) {
                pending.delete(id);
                clearTimeout(entry.timer);
                entry.reject(error);
              }
            }
          });
        },
      };
      resolve(state);
    };

    child.stdout?.on('data', chunk => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const raw = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!raw) continue;
        let message;
        try { message = JSON.parse(raw); }
        catch {
          if (stderr.length < 2000) stderr += ` invalid helper output: ${raw.slice(0, 500)}`;
          continue;
        }
        if (Object.hasOwn(message, 'ready') && !readySettled) {
          void settleReady(message);
          continue;
        }
        const id = Number(message.id);
        const entry = pending.get(id);
        if (!entry) continue;
        pending.delete(id);
        clearTimeout(entry.timer);
        if (message.ok === true) {
          if (state && message.capabilities && typeof message.capabilities === 'object') state.capabilities = { ...message.capabilities };
          entry.resolve(message);
        } else {
          entry.reject(helperError(message, stderr));
        }
      }
    });

    child.stderr?.on('data', chunk => {
      if (stderr.length < 4000) stderr = (stderr + chunk).slice(-4000);
    });
    child.once('error', error => {
      if (!readySettled) {
        readySettled = true;
        clearTimeout(timer);
        const wrapped = helperError({ kind:error?.code === 'ENOENT' ? 'unsupported' : 'runtime', error:error?.message }, stderr);
        reject(wrapped);
      }
      failPending(error);
    });
    child.once('exit', (code, signal) => {
      const error = new ToolError(`Wayland EIS helper exited unexpectedly (code=${code ?? 'null'}, signal=${signal || 'none'})`);
      if (!readySettled) {
        readySettled = true;
        clearTimeout(timer);
        reject(helperError({ kind:code === 78 ? 'unsupported' : 'runtime', error:stderr || error.message }, stderr));
      }
      failPending(error);
      if (active === state) active = null;
    });
  });

  return ready;
}

function closeState(state) {
  if (!state) return;
  if (state.backend === 'xdg-eis') {
    try { state.child?.kill('SIGTERM'); } catch {}
  } else {
    try { state.bus?.disconnect(); } catch {}
  }
  if (active === state) active = null;
}

export async function createWaylandRemoteDesktopSession({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  parentWindow = '',
  env = process.env,
  loadDbusModule = loadDbus,
  readToken = readRestoreToken,
  persistToken = persistRestoreToken,
  clearToken = clearRestoreToken,
} = {}) {
  if (!/wayland/i.test(String(env.XDG_SESSION_TYPE || '')) && !env.WAYLAND_DISPLAY) {
    throw new ToolError('Wayland Remote Desktop portal is only used inside a Wayland graphical session');
  }
  const dbus = await loadDbusModule();
  const bus = dbus.sessionBus();
  let state;
  try {
    const uniqueBusName = await waitForBusName(bus, Math.min(timeoutMs, 5000));
    const desktop = await withTimeout(bus.getProxyObject(PORTAL_NAME, PORTAL_PATH), Math.min(timeoutMs, 5000), 'Remote Desktop portal discovery');
    const remote = desktop.getInterface(REMOTE_INTERFACE);
    const context = { dbus, bus, uniqueBusName, remote };

    const created = await portalRequest(context, 'create_remote_desktop', requestToken => remote.CreateSession({
      handle_token: new dbus.Variant('s', requestToken),
      session_handle_token: new dbus.Variant('s', token('session')),
    }), timeoutMs);
    const session = created.session_handle;
    if (typeof session !== 'string' || !session.startsWith('/')) throw new ToolError('Remote Desktop portal returned no session handle');

    const restoreToken = await readToken();
    const options = {
      handle_token: new dbus.Variant('s', token('select')),
      types: new dbus.Variant('u', DEVICES),
      persist_mode: new dbus.Variant('u', 2),
      ...(restoreToken ? { restore_token: new dbus.Variant('s', restoreToken) } : {}),
    };
    await portalRequest(context, 'select_remote_devices', requestToken => {
      options.handle_token = new dbus.Variant('s', requestToken);
      return remote.SelectDevices(session, options);
    }, timeoutMs);

    let started;
    try {
      started = await portalRequest(context, 'start_remote_desktop', requestToken => remote.Start(session, String(parentWindow || ''), {
        handle_token: new dbus.Variant('s', requestToken),
      }), timeoutMs);
    } catch (error) {
      if (restoreToken) await clearToken();
      throw error;
    }
    const devices = Number(started.devices || 0);
    if ((devices & DEVICES) !== DEVICES) throw new ToolError(`Remote Desktop permission did not grant keyboard and pointer access (devices=${devices})`);
    if (typeof started.restore_token === 'string' && started.restore_token) await persistToken(started.restore_token);

    state = { dbus, bus, remote, session, devices, streams: Array.isArray(started.streams) ? started.streams : [] };
    try {
      const sessionObject = await bus.getProxyObject(PORTAL_NAME, session);
      const sessionInterface = sessionObject.getInterface(SESSION_INTERFACE);
      sessionInterface.on?.('Closed', () => closeState(state));
    } catch {}
    return state;
  } catch (error) {
    try { bus.disconnect(); } catch {}
    const message = cleanError(error);
    if (/timed out/i.test(message)) {
      throw new ToolError(`GNOME Wayland requires one-time Remote Desktop permission. Approve the system dialog on the computer and retry. ${message}`);
    }
    throw error instanceof ToolError ? error : new ToolError(`Wayland Remote Desktop portal failed: ${message}`);
  }
}

export async function ensureWaylandRemoteDesktop(options = {}) {
  if (active) return active;
  if (!starting) {
    starting = (async () => {
      const injectedLegacyHooks = Boolean(options.loadDbusModule || options.readToken || options.persistToken || options.clearToken);
      if (options.preferEis !== false && !injectedLegacyHooks && eisHelperCandidate(options.env || process.env)) {
        try {
          return await createWaylandEisSession(options);
        } catch (error) {
          if (!eisUnsupported(error)) throw error;
        }
      }
      return createWaylandRemoteDesktopSession(options);
    })().then(state => {
      active = state;
      return state;
    }).finally(() => { starting = null; });
  }
  return starting;
}

// Keep portal and EIS input bound to the existing grant/session lifecycle.
const {
  portalShortcut, portalTypeText, portalPointerMotion, portalPointerMotionAbsolute,
  portalPointerButton, portalScroll,
} = createWaylandInput(ensureWaylandRemoteDesktop);
export {
  portalShortcut, portalTypeText, portalPointerMotion, portalPointerMotionAbsolute,
  portalPointerButton, portalScroll,
};

export function hasWaylandRemoteDesktopRestoreToken() {
  return existsSync(TOKEN_FILE);
}

export function waylandPortalCandidate(env = process.env, platform = process.platform) {
  const wayland = /wayland/i.test(String(env.XDG_SESSION_TYPE || '')) || Boolean(env.WAYLAND_DISPLAY);
  if (!wayland || platform !== 'linux') return false;
  if (env.DBUS_SESSION_BUS_ADDRESS) return true;
  return typeof process.getuid === 'function' && existsSync(path.join('/run/user', String(process.getuid()), 'bus'));
}

export function hasWaylandRemoteDesktopGrant() {
  return Boolean(active) || existsSync(TOKEN_FILE);
}

export async function closeWaylandRemoteDesktop() {
  const state = active;
  active = null;
  if (!state) return;
  if (state.backend === 'xdg-eis') {
    try { await state.send({ op:'close' }, 1500); } catch {}
    try { state.child?.stdin?.end(); } catch {}
    if (state.child && state.child.exitCode == null) {
      await Promise.race([
        new Promise(resolve => state.child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 500)),
      ]);
    }
    if (state.child && state.child.exitCode == null) {
      try { state.child.kill('SIGTERM'); } catch {}
    }
    return;
  }
  try {
    const sessionObject = await state.bus.getProxyObject(PORTAL_NAME, state.session);
    const sessionInterface = sessionObject.getInterface(SESSION_INTERFACE);
    await sessionInterface.Close();
  } catch {}
  closeState(state);
}
