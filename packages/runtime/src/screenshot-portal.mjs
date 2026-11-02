import process from 'node:process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PORTAL_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const SCREENSHOT_INTERFACE = 'org.freedesktop.portal.Screenshot';
const REQUEST_INTERFACE = 'org.freedesktop.portal.Request';
const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DEFAULT_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5_000;

export function isWaylandSession(env = process.env) {
  return /wayland/i.test(String(env.XDG_SESSION_TYPE || '')) || Boolean(env.WAYLAND_DISPLAY);
}

function cleanError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 500) || 'unknown error';
}

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function waitForBusName(bus, timeoutMs) {
  if (typeof bus.name === 'string' && bus.name.startsWith(':')) return Promise.resolve(bus.name);
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
        reject(new Error('session D-Bus connected without a unique bus name'));
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
      reject(new Error(`session D-Bus did not connect within ${timeoutMs} ms`));
    }, timeoutMs);
  });
}

function expectedRequestPath(uniqueBusName, token) {
  // xdg-desktop-portal 0.9+ derives the request object path from the caller's unique bus name and
  // handle_token. Subscribing before Screenshot() closes the documented race where Response can be
  // emitted before the method reply reaches us.
  const sender = uniqueBusName.replace(/^:/, '').replace(/\./g, '_');
  return `/org/freedesktop/portal/desktop/request/${sender}/${token}`;
}

function matchRule() {
  // Deliberately omit the path. Current portals return the predictable path above, while older
  // portals may return a different handle. A short-lived broad match lets us buffer either path and
  // still filter the response to this request in-process.
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

function createResponseCollector(bus, dbus, initialPath, timeoutMs) {
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
      results: message.body?.[1],
    };
    if (message.path === targetPath) finish(value);
    else buffered.set(message.path, value);
  };
  const timer = setTimeout(() => finish({ timeout: true }), timeoutMs);
  bus.on('message', onMessage);
  return {
    promise,
    setPath(path) {
      targetPath = path;
      const pending = buffered.get(path);
      if (pending) finish(pending);
    },
    stop() {
      clearTimeout(timer);
      bus.off?.('message', onMessage);
    },
  };
}

async function openDirectoryNoFollow(directory) {
  if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('screenshot path parent is not a safe directory');
    return { anchor:directory, close:async() => {} };
  }
  const descriptor = directory.match(/^(\/proc\/(?:self|\d+)\/fd\/\d+)(?:\/(.*))?$/);
  const directories = [];
  let current;
  try {
    if (descriptor) {
      const base = await open(`${descriptor[1]}/.`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      directories.push(base);
      current = `/proc/self/fd/${base.fd}`;
    } else {
      const root = path.parse(directory).root;
      current = root;
      const parts = directory.slice(root.length).split(path.sep).filter(Boolean);
      if (!parts.length) {
        const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        return { anchor:`/proc/self/fd/${handle.fd}`, close:() => handle.close() };
      }
      for (const part of parts) {
        const handle = await open(path.join(current, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const info = await handle.stat();
        if (!info.isDirectory()) {
          await handle.close().catch(() => {});
          throw new Error('screenshot path parent is not a safe directory');
        }
        directories.push(handle);
        current = `/proc/self/fd/${handle.fd}`;
      }
      const handle = directories.pop();
      return {
        anchor:current,
        close:async() => {
          try { await handle.close(); }
          finally { for (const entry of directories.reverse()) await entry.close().catch(() => {}); }
        },
      };
    }
    for (const part of (descriptor?.[2] || '').split(path.sep).filter(Boolean)) {
      const handle = await open(path.join(current, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isDirectory()) {
        await handle.close().catch(() => {});
        throw new Error('screenshot path parent is not a safe directory');
      }
      directories.push(handle);
      current = `/proc/self/fd/${handle.fd}`;
    }
    const handle = directories.pop();
    return {
      anchor:current,
      close:async() => {
        try { await handle.close(); }
        finally { for (const entry of directories.reverse()) await entry.close().catch(() => {}); }
      },
    };
  } catch (error) {
    for (const entry of directories.reverse()) await entry.close().catch(() => {});
    throw error;
  }
}

async function copyPortalFile(source, destination) {
  let sourceParent;
  let destinationParent;
  let input;
  let output;
  let temporary;
  try {
    sourceParent = await openDirectoryNoFollow(path.dirname(source));
    destinationParent = await openDirectoryNoFollow(path.dirname(destination));
    const sourcePath = path.join(sourceParent.anchor, path.basename(source));
    // On Windows O_NOFOLLOW is not available: inspect the leaf explicitly.
    // BigInt identifiers avoid rounding NTFS file IDs above 2^53.
    const before = await lstat(sourcePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink())
      throw new Error('desktop portal screenshot source cannot be a symbolic link');
    input = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await input.stat({ bigint: true });
    const current = await lstat(sourcePath, { bigint: true });
    if (!info.isFile() || current.isSymbolicLink() || !current.isFile() ||
        info.dev !== before.dev || info.ino !== before.ino ||
        current.dev !== before.dev || current.ino !== before.ino)
      throw new Error('desktop portal screenshot source changed or is not regular');
    const destinationPath = path.join(destinationParent.anchor, path.basename(destination));
    const existing = await lstat(destinationPath).catch(() => null);
    if (existing?.isSymbolicLink()) throw new Error('desktop portal screenshot destination cannot be a symbolic link');
    temporary = path.join(destinationParent.anchor, `.${path.basename(destination)}.${randomUUID()}.tmp`);
    output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, offset + written);
        if (!result.bytesWritten) throw new Error('Could not finish copying the desktop portal screenshot');
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await output.sync();
    await output.close();
    output = null;
    await rename(temporary, destinationPath);
    temporary = null;
  } finally {
    if (output) await output.close().catch(() => {});
    if (temporary) await unlink(temporary).catch(() => {});
    if (input) await input.close().catch(() => {});
    if (destinationParent) await destinationParent.close().catch(() => {});
    if (sourceParent) await sourceParent.close().catch(() => {});
  }
}

export async function capturePortalScreenshot(destination, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  loadDbus = () => import('@jellybrick/dbus-next'),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  let dbus;
  let bus;
  let collector;
  let rule;
  let matchInstalled = false;
  try {
    dbus = await loadDbus();
    if (typeof dbus.sessionBus !== 'function' || typeof dbus.Variant !== 'function' ||
        typeof dbus.Message !== 'function' || typeof dbus.MessageType?.SIGNAL !== 'number') {
      throw new Error('D-Bus client module is missing required exports');
    }

    bus = dbus.sessionBus();
    const uniqueBusName = await waitForBusName(bus, Math.min(CONNECT_TIMEOUT_MS, remaining()));
    const desktop = await withTimeout(bus.getProxyObject(PORTAL_NAME, PORTAL_PATH), remaining(), 'desktop portal discovery');
    const screenshot = desktop.getInterface(SCREENSHOT_INTERFACE);
    const token = `remcp_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      .replace(/[^A-Za-z0-9_]/g, '_');
    const predictedHandle = expectedRequestPath(uniqueBusName, token);

    // Install the D-Bus match and listener *before* calling Screenshot. The portal can emit Response
    // very quickly, and attaching a proxy listener only after the method returns can lose it.
    rule = matchRule();
    collector = createResponseCollector(bus, dbus, predictedHandle, remaining());
    await withTimeout(bus.call(dbusMatchMessage(dbus, 'AddMatch', rule)), remaining(), 'desktop portal signal subscription');
    matchInstalled = true;

    const handle = await withTimeout(screenshot.Screenshot('', {
      handle_token: new dbus.Variant('s', token),
      interactive: new dbus.Variant('b', false),
    }), remaining(), 'desktop portal screenshot request');
    if (typeof handle !== 'string' || !handle.startsWith('/')) {
      throw new Error('desktop portal returned an invalid request handle');
    }
    collector.setPath(handle);

    const responseResult = await collector.promise;
    if (responseResult.timeout) throw new Error(`desktop portal did not respond within ${timeoutMs} ms`);
    const { response, results } = responseResult;
    if (response === 1) throw errorWithCode('screen capture permission was cancelled', 'PORTAL_CANCELLED');
    if (response !== 0) throw new Error(`desktop portal returned response ${response}`);

    const uri = results?.uri?.value;
    if (typeof uri !== 'string') throw new Error('desktop portal returned no screenshot URI');
    const sourceUrl = new URL(uri);
    if (sourceUrl.protocol !== 'file:' || (sourceUrl.hostname && sourceUrl.hostname !== 'localhost')) throw new Error('desktop portal returned an unsupported file URI');
    const source = fileURLToPath(sourceUrl);
    await copyPortalFile(source, destination);
    return destination;
  } catch (error) {
    const wrapped = new Error(`xdg-desktop-portal: ${cleanError(error)}`);
    if (error && typeof error === 'object' && typeof error.code === 'string') wrapped.code = error.code;
    throw wrapped;
  } finally {
    collector?.stop();
    if (bus && matchInstalled && rule) {
      try { await bus.call(dbusMatchMessage(dbus, 'RemoveMatch', rule)); } catch {}
    }
    try { bus?.disconnect(); } catch {}
  }
}
