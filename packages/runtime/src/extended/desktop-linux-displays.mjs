import path from 'node:path';
import process from 'node:process';
import { open } from 'node:fs/promises';

import { image, multi, text } from '../util.mjs';
import { capturePortalScreenshot, isWaylandSession } from '../screenshot-portal.mjs';
import { hasWaylandRemoteDesktopGrant, portalPointerButton, portalPointerMotion, portalPointerMotionAbsolute, portalScroll, portalShortcut, portalTypeText, waylandPortalCandidate } from '../wayland-remote-desktop.mjs';
import {
  clamp,
  commandExists,
  jsonResult,
  optionalString,
  readPrivateTempFile,
  removeTemp,
  requireEnum,
  runFile,
  spawnDetached,
  spawnDetachedWithInput,
  tempDir,
  unavailable,
} from './common.mjs';



export function unwrapDbus(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'value')) return unwrapDbus(value.value);
  if (Array.isArray(value)) return value.map(unwrapDbus);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrapDbus(item)]));
  return value;
}

export async function mutterDisplayInventory() {
  if (!isWaylandSession()) return null;
  let dbus;
  try { dbus = await import('@jellybrick/dbus-next'); } catch { return null; }
  const bus = dbus.sessionBus();
  try {
    const object = await bus.getProxyObject('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig');
    const iface = object.getInterface('org.gnome.Mutter.DisplayConfig');
    const state = unwrapDbus(await iface.GetCurrentState());
    if (!Array.isArray(state) || state.length < 3) return null;
    const monitors = Array.isArray(state[1]) ? state[1] : [];
    const logical = Array.isArray(state[2]) ? state[2] : [];
    const monitorByKey = new Map();
    for (const monitor of monitors) {
      const spec = Array.isArray(monitor?.[0]) ? monitor[0] : [];
      const modes = Array.isArray(monitor?.[1]) ? monitor[1] : [];
      const props = monitor?.[2] && typeof monitor[2] === 'object' ? monitor[2] : {};
      const current = modes.find(mode => mode?.[6]?.['is-current'] === true)
        || modes.find(mode => mode?.[6]?.['is-preferred'] === true)
        || modes[0];
      monitorByKey.set(JSON.stringify(spec), {
        connector: String(spec[0] || ''),
        vendor: String(spec[1] || ''),
        product: String(spec[2] || ''),
        serial: String(spec[3] || ''),
        display_name: String(props['display-name'] || spec[0] || 'Display'),
        builtin: Boolean(props['is-builtin']),
        mode: current ? {
          width: Number(current[1]) || null,
          height: Number(current[2]) || null,
          refresh_hz: Number(current[3]) || null,
        } : null,
      });
    }
    const rows = [];
    for (const item of logical) {
      if (!Array.isArray(item) || item.length < 6) continue;
      const x = Number(item[0]), y = Number(item[1]), scale = Number(item[2]) || 1;
      const transform = Number(item[3]) || 0;
      const primary = Boolean(item[4]);
      const specs = Array.isArray(item[5]) ? item[5] : [];
      for (const spec of specs) {
        const details = monitorByKey.get(JSON.stringify(spec)) || {
          connector: String(spec?.[0] || ''),
          vendor: String(spec?.[1] || ''),
          product: String(spec?.[2] || ''),
          serial: String(spec?.[3] || ''),
          display_name: String(spec?.[0] || 'Display'),
          mode: null,
        };
        const pixelWidth = Number(details.mode?.width) || null;
        const pixelHeight = Number(details.mode?.height) || null;
        const rotated = [1,3,5,7].includes(transform);
        rows.push({
          name: details.connector || details.display_name,
          display_name: details.display_name,
          primary,
          x: Number.isFinite(x) ? x : null,
          y: Number.isFinite(y) ? y : null,
          width: pixelWidth == null ? null : Math.round((rotated ? pixelHeight : pixelWidth) / scale),
          height: pixelHeight == null ? null : Math.round((rotated ? pixelWidth : pixelHeight) / scale),
          pixel_width: pixelWidth,
          pixel_height: pixelHeight,
          scale,
          refresh_hz: details.mode?.refresh_hz ?? null,
          transform,
          builtin: Boolean(details.builtin),
          vendor: details.vendor || null,
          product: details.product || null,
          serial: details.serial || null,
          backend: 'mutter',
        });
      }
    }
    return rows.length ? rows : null;
  } catch {
    return null;
  } finally {
    try { bus.disconnect(); } catch {}
  }
}

export function parseWlrRandrOutput(stdout) {
  const rows = [];
  let current = null;

  const finish = () => {
    if (!current || current.enabled === false) return;
    const mode = current.currentMode || current.firstMode;
    if (!mode) return;
    const scale = Number.isFinite(current.scale) && current.scale > 0 ? current.scale : 1;
    const rotated = /(?:^|\D)(?:90|270)(?:\D|$)/.test(current.transform || '');
    const pixelWidth = mode.width;
    const pixelHeight = mode.height;
    rows.push({
      name:current.name,
      display_name:current.description || current.model || current.name,
      primary:false,
      x:Number.isFinite(current.x) ? current.x : null,
      y:Number.isFinite(current.y) ? current.y : null,
      width:Math.round((rotated ? pixelHeight : pixelWidth) / scale),
      height:Math.round((rotated ? pixelWidth : pixelHeight) / scale),
      pixel_width:pixelWidth,
      pixel_height:pixelHeight,
      scale,
      refresh_hz:mode.refresh_hz,
      transform:current.transform || 'normal',
      builtin:/^(?:eDP|LVDS|DSI)-/i.test(current.name),
      vendor:current.make || null,
      product:current.model || null,
      serial:current.serial || null,
      backend:'wlr-randr',
    });
  };

  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    if (rawLine && !/^\s/.test(rawLine)) {
      finish();
      const header = rawLine.match(/^(\S+)(?:\s+"([^"]*)")?\s*$/);
      current = header ? {
        name:header[1],
        description:header[2] || '',
        enabled:true,
        scale:1,
        transform:'normal',
        currentMode:null,
        firstMode:null,
      } : null;
      continue;
    }
    if (!current) continue;
    const line = rawLine.trim();
    let match;
    if ((match = line.match(/^Enabled:\s*(yes|no)$/i))) current.enabled = match[1].toLowerCase() === 'yes';
    else if ((match = line.match(/^Position:\s*(-?\d+)\s*,\s*(-?\d+)$/i))) {
      current.x = Number(match[1]);
      current.y = Number(match[2]);
    } else if ((match = line.match(/^Scale:\s*(\d+(?:\.\d+)?)$/i))) current.scale = Number(match[1]);
    else if ((match = line.match(/^Transform:\s*(.+)$/i))) current.transform = match[1].trim();
    else if ((match = line.match(/^Make:\s*(.*)$/i))) current.make = match[1].trim();
    else if ((match = line.match(/^Model:\s*(.*)$/i))) current.model = match[1].trim();
    else if ((match = line.match(/^Serial:\s*(.*)$/i))) current.serial = match[1].trim();
    else if ((match = line.match(/^(\d+)x(\d+)\s+px,\s*([\d.]+)\s+Hz(?:\s+\(([^)]*)\))?/i))) {
      const mode = { width:Number(match[1]), height:Number(match[2]), refresh_hz:Number(match[3]) };
      current.firstMode ||= mode;
      if (/\bcurrent\b/i.test(match[4] || '')) current.currentMode = mode;
    }
  }
  finish();
  return rows;
}

export function parseXrandrDisplayOutput(stdout, scale = 1) {
  const rows = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.match(/^(\S+) connected( primary)?(?: (\d+)x(\d+)\+(-?\d+)\+(-?\d+))?/);
    if (match) rows.push({
      name:match[1],
      display_name:match[1],
      primary:Boolean(match[2]),
      width:match[3]?Number(match[3]):null,
      height:match[4]?Number(match[4]):null,
      pixel_width:match[3]?Number(match[3]):null,
      pixel_height:match[4]?Number(match[4]):null,
      x:match[5]?Number(match[5]):null,
      y:match[6]?Number(match[6]):null,
      scale,
      backend:'xrandr',
    });
  }
  return rows;
}

export async function xrandrDisplayScale({ commandExistsFn = commandExists, runFileFn = runFile, env = process.env } = {}) {
  let scale = Number(env.GDK_SCALE || env.QT_SCALE_FACTOR || 0);
  if (!Number.isFinite(scale) || scale <= 0) scale = 0;
  if (!scale && commandExistsFn('gsettings')) {
    const probe = await runFileFn('gsettings', ['get','org.gnome.desktop.interface','scaling-factor'], { label:'display scale', allowFailure:true, timeout:1500 });
    const parsed = Number(String(probe.stdout || '').match(/(\d+(?:\.\d+)?)/)?.[1]);
    if (Number.isFinite(parsed) && parsed > 0) scale = parsed;
  }
  return scale || 1;
}

export async function resolveLinuxDisplayInventory({
  wayland = isWaylandSession(),
  mutterProbe = mutterDisplayInventory,
  commandExistsFn = commandExists,
  runFileFn = runFile,
  env = process.env,
} = {}) {
  if (wayland) {
    const mutter = await mutterProbe().catch(() => null);
    if (Array.isArray(mutter) && mutter.length) return mutter;

    if (commandExistsFn('wlr-randr')) {
      const result = await runFileFn('wlr-randr', [], { label:'display inventory', allowFailure:true, timeout:2500, maxBuffer:4*1024*1024 });
      if (result.code === 0) {
        const rows = parseWlrRandrOutput(result.stdout);
        if (rows.length) return rows;
      }
    }
  }

  if (commandExistsFn('xrandr')) {
    const result = await runFileFn('xrandr', ['--query'], { label:'display inventory', allowFailure:true, timeout:2500, maxBuffer:4*1024*1024 });
    if (result.code === 0) {
      const scale = await xrandrDisplayScale({ commandExistsFn, runFileFn, env });
      const rows = parseXrandrDisplayOutput(result.stdout, scale);
      if (rows.length) return rows;
    }
  }
  return null;
}

let displayCapabilityCache = { value:false, expiresAt:0, pending:null };

export async function displayInventoryAvailable(options) {
  if (options && Object.keys(options).length) {
    return Boolean((await resolveLinuxDisplayInventory(options))?.length);
  }
  const now = Date.now();
  if (displayCapabilityCache.expiresAt > now) return displayCapabilityCache.value;
  if (displayCapabilityCache.pending) return displayCapabilityCache.pending;
  const pending = resolveLinuxDisplayInventory()
    .then(rows => {
      const value = Boolean(rows?.length);
      displayCapabilityCache = { value, expiresAt:Date.now() + 5000, pending:null };
      return value;
    })
    .catch(() => {
      displayCapabilityCache = { value:false, expiresAt:Date.now() + 5000, pending:null };
      return false;
    });
  displayCapabilityCache.pending = pending;
  return pending;
}

export async function displayInventory() {
  const rows = await resolveLinuxDisplayInventory();
  if (!rows?.length) unavailable('Display inventory', 'GNOME Mutter DisplayConfig, wlr-randr or xrandr is required');
  return jsonResult(rows);
}

export async function pngDimensions(file) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(24);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead < buffer.length || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (!width || !height) return null;
    return { width, height };
  } finally {
    await handle.close();
  }
}

export function regionScreenshotBackends({
  wayland = isWaylandSession(),
  grim = commandExists('grim'),
  gnomeScreenshot = commandExists('gnome-screenshot'),
  ffmpeg = commandExists('ffmpeg'),
  imagemagick = commandExists('import'),
  portalCandidate = waylandPortalCandidate(),
} = {}) {
  const backends = [];
  if (wayland && grim) backends.push('grim');
  if (wayland) {
    if (gnomeScreenshot && ffmpeg) backends.push('gnome-screenshot');
    if (ffmpeg && portalCandidate) backends.push('portal');
  } else if (imagemagick) {
    backends.push('imagemagick');
  }
  return backends;
}

export function portalCropGeometry(rect, displays = [], bitmap = null) {
  const requested = {
    x: Math.trunc(Number(rect?.x)),
    y: Math.trunc(Number(rect?.y)),
    width: Math.trunc(Number(rect?.width)),
    height: Math.trunc(Number(rect?.height)),
  };
  if (![requested.x,requested.y,requested.width,requested.height].every(Number.isFinite)
      || requested.width <= 0 || requested.height <= 0) {
    throw new Error('portal crop requires a finite positive rectangle');
  }
  const visibleDisplays = Array.isArray(displays) ? displays.filter(item => {
    const x = Number(item?.x), y = Number(item?.y), width = Number(item?.width), height = Number(item?.height);
    return [x,y,width,height].every(Number.isFinite) && width > 0 && height > 0;
  }) : [];
  const bitmapWidth = Math.trunc(Number(bitmap?.width));
  const bitmapHeight = Math.trunc(Number(bitmap?.height));
  const hasBitmap = Number.isFinite(bitmapWidth) && bitmapWidth > 0 && Number.isFinite(bitmapHeight) && bitmapHeight > 0;

  let minX = 0, minY = 0;
  let maxX = hasBitmap ? bitmapWidth : requested.x + requested.width;
  let maxY = hasBitmap ? bitmapHeight : requested.y + requested.height;
  if (visibleDisplays.length) {
    minX = Math.min(...visibleDisplays.map(item => Number(item.x)));
    minY = Math.min(...visibleDisplays.map(item => Number(item.y)));
    maxX = Math.max(...visibleDisplays.map(item => Number(item.x) + Number(item.width)));
    maxY = Math.max(...visibleDisplays.map(item => Number(item.y) + Number(item.height)));
  }
  const left = Math.max(requested.x, minX);
  const top = Math.max(requested.y, minY);
  const right = Math.min(requested.x + requested.width, maxX);
  const bottom = Math.min(requested.y + requested.height, maxY);
  if (right <= left || bottom <= top) throw new Error('screenshot region is outside visible desktop bounds');

  const virtualWidth = maxX - minX;
  const virtualHeight = maxY - minY;
  const scaleX = hasBitmap && virtualWidth > 0 ? bitmapWidth / virtualWidth : 1;
  const scaleY = hasBitmap && virtualHeight > 0 ? bitmapHeight / virtualHeight : 1;
  const x = Math.max(0, Math.floor((left - minX) * scaleX));
  const y = Math.max(0, Math.floor((top - minY) * scaleY));
  const sourceRight = hasBitmap
    ? Math.min(bitmapWidth, Math.ceil((right - minX) * scaleX))
    : Math.ceil((right - minX) * scaleX);
  const sourceBottom = hasBitmap
    ? Math.min(bitmapHeight, Math.ceil((bottom - minY) * scaleY))
    : Math.ceil((bottom - minY) * scaleY);
  const width = sourceRight - x;
  const height = sourceBottom - y;
  if (width <= 0 || height <= 0) throw new Error('screenshot region has no visible portal pixels');

  return {
    x, y, width, height,
    visible: { x:left, y:top, width:right-left, height:bottom-top },
    clipped: left !== requested.x || top !== requested.y
      || right !== requested.x + requested.width || bottom !== requested.y + requested.height,
  };
}
