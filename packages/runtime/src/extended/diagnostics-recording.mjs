// Screen recording backends and safe output handling, independent of system diagnostics.
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { lstat, mkdtemp, open, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { isWaylandSession } from '../screenshot-portal.mjs';
import { openDirectoryPath } from '../tools/files.mjs';
import { resolveSafePath } from '../util.mjs';
import { clamp, commandExists, jsonResult, runFile, unavailable } from './common.mjs';

export function resolveRecordScreenFfmpeg({
  platform = process.platform,
  commandExistsFn = commandExists,
  existsSyncFn = existsSync,
} = {}) {
  if (commandExistsFn('ffmpeg')) return 'ffmpeg';
  if (platform === 'darwin') {
    for (const candidate of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
      if (existsSyncFn(candidate)) return candidate;
    }
  }
  return null;
}

export function parseAvfoundationScreenInput(output) {
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/\[(\d+)\]\s+Capture screen(?:\s+\d+)?\s*$/i);
    if (match) return match[1];
  }
  return null;
}

async function avfoundationScreenInput(ffmpeg) {
  const result = await runFile(ffmpeg, [
    '-hide_banner',
    '-f','avfoundation',
    '-list_devices','true',
    '-i','',
  ], { label:'AVFoundation device inventory', timeout:10_000, allowFailure:true });
  const index = parseAvfoundationScreenInput(`${result.stderr || ''}\n${result.stdout || ''}`);
  if (!index) unavailable('Screen recording', 'ffmpeg could not find an AVFoundation Capture screen input');
  return index;
}

export function gnomeScreencastCandidate({
  platform = process.platform,
  wayland = platform === 'linux' ? isWaylandSession() : false,
  desktop = process.env.XDG_CURRENT_DESKTOP || '',
  gnomeSessionMode = process.env.GNOME_SHELL_SESSION_MODE || '',
  sessionBus = process.env.DBUS_SESSION_BUS_ADDRESS || '',
  commandExistsFn = commandExists,
} = {}) {
  const gnomeSession = /gnome/i.test(String(desktop)) || Boolean(String(gnomeSessionMode).trim());
  return platform === 'linux'
    && wayland
    && gnomeSession
    && Boolean(String(sessionBus).trim())
    && commandExistsFn('gjs');
}

export function recordScreenBackend({
  platform = process.platform,
  wayland = platform === 'linux' ? isWaylandSession() : false,
  display = process.env.DISPLAY || '',
  desktop = process.env.XDG_CURRENT_DESKTOP || '',
  gnomeSessionMode = process.env.GNOME_SHELL_SESSION_MODE || '',
  sessionBus = process.env.DBUS_SESSION_BUS_ADDRESS || '',
  gnomeSupported = false,
  commandExistsFn = commandExists,
  existsSyncFn = existsSync,
} = {}) {
  if (platform === 'linux') {
    if (wayland) {
      if (gnomeSupported && gnomeScreencastCandidate({
        platform,
        wayland,
        desktop,
        gnomeSessionMode,
        sessionBus,
        commandExistsFn,
      })) return 'gnome-shell';
      if (commandExistsFn('wf-recorder') && commandExistsFn('timeout')) return 'wf-recorder';
      return null;
    }
    return Boolean(String(display).trim()) && commandExistsFn('ffmpeg') ? 'ffmpeg-x11' : null;
  }
  if (platform === 'darwin') {
    return resolveRecordScreenFfmpeg({ platform, commandExistsFn, existsSyncFn }) ? 'ffmpeg-avfoundation' : null;
  }
  if (platform === 'win32') {
    return resolveRecordScreenFfmpeg({ platform, commandExistsFn, existsSyncFn }) ? 'ffmpeg-gdigrab' : null;
  }
  return null;
}

export function recordScreenAvailable({
  platform = process.platform,
  wayland = platform === 'linux' ? isWaylandSession() : false,
  display = process.env.DISPLAY || '',
  desktop = process.env.XDG_CURRENT_DESKTOP || '',
  gnomeSessionMode = process.env.GNOME_SHELL_SESSION_MODE || '',
  sessionBus = process.env.DBUS_SESSION_BUS_ADDRESS || '',
  gnomeSupported = false,
  commandExistsFn = commandExists,
  existsSyncFn = existsSync,
} = {}) {
  return Boolean(recordScreenBackend({
    platform,
    wayland,
    display,
    desktop,
    gnomeSessionMode,
    sessionBus,
    gnomeSupported,
    commandExistsFn,
    existsSyncFn,
  }));
}

const GNOME_SCREENCAST_SUPPORT_HELPER = `const {Gio, GLib} = imports.gi;
const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
const value = bus.call_sync(
  'org.gnome.Shell.Screencast',
  '/org/gnome/Shell/Screencast',
  'org.freedesktop.DBus.Properties',
  'Get',
  new GLib.Variant('(ss)', ['org.gnome.Shell.Screencast', 'ScreencastSupported']),
  new GLib.VariantType('(v)'),
  Gio.DBusCallFlags.NONE,
  3000,
  null
).deepUnpack();
print(value[0].deepUnpack() ? 'true' : 'false');
`;

let gnomeScreencastSupportCache = { key:'', value:false, expiresAt:0 };
let gnomeScreencastSupportProbe = { key:'', promise:null };

export async function gnomeScreencastSupported({
  platform = process.platform,
  wayland = platform === 'linux' ? isWaylandSession() : false,
  desktop = process.env.XDG_CURRENT_DESKTOP || '',
  gnomeSessionMode = process.env.GNOME_SHELL_SESSION_MODE || '',
  sessionBus = process.env.DBUS_SESSION_BUS_ADDRESS || '',
  commandExistsFn = commandExists,
  runFileFn = runFile,
  cacheMs = 15_000,
  nowFn = Date.now,
} = {}) {
  if (!gnomeScreencastCandidate({
    platform,
    wayland,
    desktop,
    gnomeSessionMode,
    sessionBus,
    commandExistsFn,
  })) return false;

  const key = [platform, wayland ? 'wayland' : '', desktop, gnomeSessionMode, sessionBus].join('|');
  const now = nowFn();
  if (cacheMs > 0 && gnomeScreencastSupportCache.key === key && gnomeScreencastSupportCache.expiresAt > now) {
    return gnomeScreencastSupportCache.value;
  }
  if (gnomeScreencastSupportProbe.key === key && gnomeScreencastSupportProbe.promise) {
    return gnomeScreencastSupportProbe.promise;
  }

  const promise = (async () => {
    let value = false;
    try {
      const result = await runFileFn('gjs', ['-c', GNOME_SCREENCAST_SUPPORT_HELPER], {
        label:'GNOME Shell screencast capability probe',
        timeout:5000,
        maxBuffer:64 * 1024,
        allowFailure:true,
      });
      value = Number(result.code) === 0 && String(result.stdout || '').trim() === 'true';
    } catch {
      value = false;
    }
    gnomeScreencastSupportCache = {
      key,
      value,
      expiresAt:nowFn() + Math.max(0, cacheMs),
    };
    return value;
  })();

  gnomeScreencastSupportProbe = { key, promise };
  try {
    return await promise;
  } finally {
    if (gnomeScreencastSupportProbe.key === key && gnomeScreencastSupportProbe.promise === promise) {
      gnomeScreencastSupportProbe = { key:'', promise:null };
    }
  }
}

const GNOME_SCREENCAST_HELPER = `const {Gio, GLib} = imports.gi;
const [destination, secondsRaw, fpsRaw] = ARGV;
const seconds = Number(secondsRaw);
const fps = Number(fpsRaw);
const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
const destinationName = 'org.gnome.Shell.Screencast';
const objectPath = '/org/gnome/Shell/Screencast';
const interfaceName = 'org.gnome.Shell.Screencast';
const property = bus.call_sync(
  destinationName,
  objectPath,
  'org.freedesktop.DBus.Properties',
  'Get',
  new GLib.Variant('(ss)', [interfaceName, 'ScreencastSupported']),
  new GLib.VariantType('(v)'),
  Gio.DBusCallFlags.NONE,
  5000,
  null
).deepUnpack();
if (!property[0].deepUnpack()) throw new Error('GNOME Shell reports ScreencastSupported=false');
const options = {
  'draw-cursor': new GLib.Variant('b', true),
  'framerate': new GLib.Variant('i', fps),
};
const started = bus.call_sync(
  destinationName,
  objectPath,
  interfaceName,
  'Screencast',
  new GLib.Variant('(sa{sv})', [destination, options]),
  new GLib.VariantType('(bs)'),
  Gio.DBusCallFlags.NONE,
  10000,
  null
).deepUnpack();
if (!started[0]) throw new Error('GNOME Shell refused to start screencast');
GLib.usleep(Math.round(seconds * 1000000));
const stopped = bus.call_sync(
  destinationName,
  objectPath,
  interfaceName,
  'StopScreencast',
  null,
  new GLib.VariantType('(b)'),
  Gio.DBusCallFlags.NONE,
  10000,
  null
).deepUnpack();
if (!stopped[0]) throw new Error('GNOME Shell did not stop screencast cleanly');
print(JSON.stringify({ destination:started[1], stopped:stopped[0] }));
`;

async function recordGnomeShellScreen({ staged, stagingDirectory, seconds, fps }) {
  const helper = path.join(stagingDirectory, 'gnome-screencast.js');
  await writeFile(helper, GNOME_SCREENCAST_HELPER, { mode:0o600 });
  await runFile('gjs', [helper, staged, String(seconds), String(fps)], {
    label:'GNOME Shell screen recording',
    timeout:(seconds + 20) * 1000,
    maxBuffer:2 * 1024 * 1024,
  });
}

export function validateRecordingDestinationFormat(destination, format) {
  if (!destination) return;
  const extension = path.extname(destination).slice(1).toLowerCase();
  if (extension && extension !== format) {
    throw new Error(`Screen recording backend produces .${format}; destination must use .${format} or omit the extension`);
  }
}

async function openRecordingParent(destination) {
  return openDirectoryPath(path.dirname(destination));
}

async function copyRecordingFile(source, destination) {
  let input;
  let output;
  let parent;
  let temporary;
  try {
    input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const sourceInfo = await input.stat();
    if (!sourceInfo.isFile()) throw new Error('Screen recording staging path is not a regular file');
    parent = await openRecordingParent(destination);
    const anchoredDestination = path.join(parent.anchor, path.basename(destination));
    const existing = await lstat(anchoredDestination).catch(() => null);
    if (existing?.isSymbolicLink()) throw new Error('Screen recording destination cannot be a symbolic link');
    if (existing && !existing.isFile()) throw new Error('Screen recording destination is not a regular file');
    temporary = path.join(parent.anchor, `.${path.basename(destination)}.${randomUUID()}.tmp`);
    output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, offset + written);
        if (!result.bytesWritten) throw new Error('Could not finish writing the screen recording');
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await output.sync();
    await output.close();
    output = null;
    await rename(temporary, anchoredDestination);
    temporary = null;
  } finally {
    if (output) await output.close().catch(() => {});
    if (temporary) await unlink(temporary).catch(() => {});
    if (input) await input.close().catch(() => {});
    if (parent) await parent.close().catch(() => {});
  }
}

export async function recordScreen(args) {
  const seconds = clamp(args.duration_seconds, 5, 1, 120);
  const fps = clamp(args.fps, 15, 1, 60);
  const wayland = process.platform === 'linux' && isWaylandSession();
  const gnomeSupported = wayland ? await gnomeScreencastSupported() : false;
  const backend = recordScreenBackend({ platform:process.platform, wayland, gnomeSupported });
  if (!backend) {
    if (wayland) unavailable('Screen recording', 'GNOME Shell Screencast or wf-recorder with timeout is required on Wayland');
    if (process.platform === 'linux' && !String(process.env.DISPLAY || '').trim()) unavailable('Screen recording', 'an active X11 DISPLAY is required on Linux X11');
    if (process.platform === 'darwin') unavailable('Screen recording', 'ffmpeg is required on macOS');
    if (process.platform === 'win32') unavailable('Screen recording', 'ffmpeg is required on Windows');
    unavailable('Screen recording', 'ffmpeg is required on X11');
  }

  const format = backend === 'gnome-shell' ? 'webm' : 'mp4';
  const requestedDestination = args.destination ? await resolveSafePath(args.destination, 'destination') : '';
  if (requestedDestination) {
    validateRecordingDestinationFormat(requestedDestination, format);
    const existing = await lstat(requestedDestination).catch(() => null);
    if (existing?.isSymbolicLink()) throw new Error('Screen recording destination cannot be a symbolic link');
    if (existing && !existing.isFile()) throw new Error('Screen recording destination is not a regular file');
  }

  const stagingDirectory = await mkdtemp(path.join(os.tmpdir(), 'remcp-screen-'));
  const staged = path.join(stagingDirectory, `capture-${randomUUID()}.${format}`);
  let keepStaging = false;
  try {
    if (backend === 'gnome-shell') {
      await recordGnomeShellScreen({ staged, stagingDirectory, seconds, fps });
    } else if (backend === 'wf-recorder') {
      const result = await runFile('timeout', ['--signal=INT', `${seconds}s`, 'wf-recorder', '-f',staged,'-r',String(fps),'-c','libx264'], { label:'screen recording', timeout:(seconds+10)*1000, allowFailure:true });
      if (![0, 124, 130].includes(Number(result.code))) throw new Error(result.stderr.trim() || `wf-recorder exited ${result.code}`);
    } else {
      const ffmpeg = resolveRecordScreenFfmpeg();
      if (!ffmpeg) {
        if (process.platform === 'darwin') unavailable('Screen recording', 'ffmpeg is required on macOS');
        if (process.platform === 'win32') unavailable('Screen recording', 'ffmpeg is required on Windows');
        unavailable('Screen recording', 'ffmpeg is required on X11');
      }
      let argv;
      if (process.platform === 'win32') argv=['-y','-f','gdigrab','-framerate',String(fps),'-i','desktop','-t',String(seconds),'-pix_fmt','yuv420p',staged];
      else if (process.platform === 'darwin') {
        const input = await avfoundationScreenInput(ffmpeg);
        argv=['-y','-f','avfoundation','-framerate',String(fps),'-i',`${input}:none`,'-t',String(seconds),'-pix_fmt','yuv420p',staged];
      } else argv=['-y','-f','x11grab','-framerate',String(fps),'-i',process.env.DISPLAY,'-t',String(seconds),'-pix_fmt','yuv420p',staged];
      await runFile(ffmpeg, argv, { label:'screen recording', timeout:(seconds+20)*1000, maxBuffer:8*1024*1024 });
    }
    if (requestedDestination) {
      await copyRecordingFile(staged, requestedDestination);
      await rm(stagingDirectory, { recursive:true, force:true });
    }
    const output = requestedDestination || staged;
    const info = await stat(output);
    keepStaging = !requestedDestination;
    return jsonResult({ path:output, bytes:info.size, duration_seconds:seconds, format });
  } finally {
    if (!keepStaging) await rm(stagingDirectory, { recursive:true, force:true }).catch(() => {});
  }
}
