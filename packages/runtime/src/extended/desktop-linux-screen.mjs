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


import { displayInventory, pngDimensions, portalCropGeometry, regionScreenshotBackends } from './desktop-linux-displays.mjs';

export async function screenshotRegion(args = {}) {
  const x=Math.trunc(Number(args.x)), y=Math.trunc(Number(args.y)), width=Math.trunc(Number(args.width)), height=Math.trunc(Number(args.height));
  if (![x,y,width,height].every(Number.isFinite) || width<=0 || height<=0) throw new Error('x, y, width and height are required; width/height must be positive');
  if (width > 8192 || height > 8192 || width * height > 16_777_216) throw new Error('screenshot region is too large; width/height must be <= 8192 and area <= 16 megapixels');
  const dir = await tempDir('remcp-region-');
  const target = path.join(dir, 'region.png');
  const full = path.join(dir, 'full.png');
  let captured = { x, y, width, height };
  let clipped = false;
  let backend = '';
  try {
    const cropFullDesktop = async () => {
      const inventory = await displayInventory().catch(() => null);
      const displays = Array.isArray(inventory?.structuredContent?.data) ? inventory.structuredContent.data : [];
      const bitmap = await pngDimensions(full);
      const crop = portalCropGeometry({ x, y, width, height }, displays, bitmap);
      captured = crop.visible;
      clipped = crop.clipped;
      await runFile('ffmpeg', ['-hide_banner','-loglevel','error','-y','-i',full,'-vf',`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,'-frames:v','1',target], { label:'crop desktop screenshot', timeout:30_000, maxBuffer:4*1024*1024 });
    };

    const candidates = regionScreenshotBackends();
    if (!candidates.length) {
      unavailable('Region screenshots', isWaylandSession()
        ? 'install grim, or gnome-screenshot/ffmpeg, or provide the XDG Desktop Portal plus ffmpeg'
        : 'install ImageMagick import');
    }

    let lastError = null;
    for (const candidate of candidates) {
      try {
        if (candidate === 'grim') {
          await runFile('grim', ['-g',`${x},${y} ${width}x${height}`,target], { label:'screenshot region' });
        } else if (candidate === 'gnome-screenshot') {
          await runFile('gnome-screenshot', ['-f',full], { label:'GNOME screenshot', timeout:10_000, maxBuffer:1024*1024 });
          await cropFullDesktop();
        } else if (candidate === 'portal') {
          await capturePortalScreenshot(full);
          await cropFullDesktop();
        } else if (candidate === 'imagemagick') {
          await runFile('import', ['-window','root','-crop',`${width}x${height}+${x}+${y}`,target], { label:'screenshot region' });
        }
        backend = candidate;
        lastError = null;
        break;
      } catch (error) {
        if (error?.code === 'PORTAL_CANCELLED') throw error;
        lastError = error;
      }
    }
    if (lastError) throw lastError;

    const {data} = await readPrivateTempFile(target, 4 * 1024 * 1024);
    const baseSummary = clipped
      ? `Captured visible ${captured.width}x${captured.height} at ${captured.x},${captured.y}; clipped from requested ${width}x${height} at ${x},${y}.`
      : `Captured ${width}x${height} at ${x},${y}.`;
    return multi([{type:'text',text:`${baseSummary} Backend: ${backend}.`}, image(data.toString('base64'),'image/png')]);
  } finally { await removeTemp(dir); }
}

export async function notification(args = {}) {
  if (!commandExists('notify-send')) unavailable('Desktop notifications', 'install notify-send');
  await runFile('notify-send', [optionalString(args.title)||'ReMCP', String(args.message ?? args.body ?? '')], { label:'notification' });
  return text('Notification sent.');
}

export async function launchApp(app, argv = [], options = {}) {
  const pid = spawnDetached(app, argv, { cwd:options.cwd || undefined });
  return `Launched ${app} (pid ${pid})${options.cwd ? ` in ${options.cwd}` : ''}.`;
}

export async function openPath(target) {
  if (!commandExists('xdg-open')) unavailable('Open path', 'xdg-open is required');
  spawnDetached('xdg-open', [target]);
}

export async function revealPath(target) {
  if (!commandExists('xdg-open')) unavailable('Reveal path', 'xdg-open is required');
  spawnDetached('xdg-open', [path.dirname(target)]);
}
