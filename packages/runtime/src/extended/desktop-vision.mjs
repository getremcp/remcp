import os from 'node:os';
import process from 'node:process';
import { fileToolHandlers } from '../tools/files.mjs';
import { liveConfig, runtimeConfig } from '../config.mjs';
import { assertAllowedCommand } from '../policy.mjs';
import { multi, resolveSafePath, text } from '../util.mjs';
import { clamp, desktopSessionAvailable, jsonResult, optionalString, requireEnum } from './common.mjs';
import * as linux from './desktop-linux.mjs';
import * as macos from './desktop-macos.mjs';
import * as windows from './desktop-windows.mjs';
import { browserAction, browserCapabilityAvailable, browserSnapshot } from './browser.mjs';
import { findOcrText, ocrImage } from './ocr.mjs';


import { displayInventory, pointer, resultValue, screenshotRegion, sleep } from './desktop-core.mjs';
import { computerSnapshot } from './desktop-computer-snapshot.mjs';

export function screenshotImagePart(screenshotResult) {
  return screenshotResult?.content?.find(part => part.type === 'image' && typeof part.data === 'string') || null;
}

export async function ocrScreenshotResult(screenshotResult, args = {}) {
  const imagePart = screenshotImagePart(screenshotResult);
  if (!imagePart) return { available:false, reason:'no screenshot image is available for OCR' };
  return ocrImage(Buffer.from(imagePart.data, 'base64'), {
    language:args.ocr_language,
    max_words:args.ocr_max_words,
    psm:args.ocr_psm,
    timeout_ms:args.ocr_timeout_ms,
  });
}

export function pngDimensions(imagePart) {
  if (!imagePart || imagePart.mimeType !== 'image/png') return null;
  let buffer;
  try { buffer = Buffer.from(imagePart.data, 'base64'); } catch { return null; }
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function virtualDesktopBounds(displays) {
  if (!Array.isArray(displays) || !displays.length) return null;
  const valid = displays.filter(display =>
    [display.x, display.y, display.width, display.height].every(value => Number.isFinite(Number(value)))
    && Number(display.width) > 0
    && Number(display.height) > 0
  );
  if (!valid.length) return null;
  const x = Math.min(...valid.map(display => Number(display.x)));
  const y = Math.min(...valid.map(display => Number(display.y)));
  const right = Math.max(...valid.map(display => Number(display.x) + Number(display.width)));
  const bottom = Math.max(...valid.map(display => Number(display.y) + Number(display.height)));
  return { x, y, width:right - x, height:bottom - y };
}

export function mapOcrBoxToDesktop(box, imagePart, displays, captureBounds = null) {
  const image = pngDimensions(imagePart);
  const desktop = captureBounds || virtualDesktopBounds(displays);
  const centerX = Number(box?.x) + Number(box?.width) / 2;
  const centerY = Number(box?.y) + Number(box?.height) / 2;
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) throw new Error('OCR match has invalid bounds');
  if (!image || !desktop || desktop.width <= 0 || desktop.height <= 0) {
    return { x:Math.round(centerX), y:Math.round(centerY), scale_x:1, scale_y:1, desktop_origin:[0,0] };
  }
  const scaleX = image.width / desktop.width;
  const scaleY = image.height / desktop.height;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
    throw new Error('Could not map OCR pixels to desktop coordinates');
  }
  return {
    x:Math.round(desktop.x + centerX / scaleX),
    y:Math.round(desktop.y + centerY / scaleY),
    scale_x:scaleX,
    scale_y:scaleY,
    desktop_origin:[desktop.x, desktop.y],
    screenshot_size:[image.width, image.height],
    desktop_size:[desktop.width, desktop.height],
  };
}

export async function clickOcrText(args = {}) {
  const needle = optionalString(args.ocr_text || args.name || args.browser_text);
  if (!needle) throw new Error('ocr_text is required for OCR targeting');

  let screenshot = null;
  let captureBounds = null;
  const explicitRegion = Array.isArray(args.ocr_region) && args.ocr_region.length === 4
    ? args.ocr_region.map(Number)
    : null;
  if (explicitRegion?.every(Number.isFinite)) {
    const [left, top, right, bottom] = explicitRegion;
    if (right <= left || bottom <= top) throw new Error('ocr_region must be [left,top,right,bottom] with positive area');
    captureBounds = { x:Math.round(left), y:Math.round(top), width:Math.round(right-left), height:Math.round(bottom-top) };
    screenshot = await screenshotRegion({ ...captureBounds, padding:0 });
  }

  // Without an explicit OCR region, discover the current semantic foreground first. OCR on a tightly
  // scoped active window is much more accurate than OCR on a dense whole-desktop screenshot and still
  // falls back safely below.
  if (!screenshot) try {
    const state = resultValue(await computerSnapshot({
      include_screenshot:false,
      include_browser:false,
      include_ocr:false,
      max_ui_nodes:300,
      max_ui_depth:8,
    }));
    captureBounds = activeWindowCaptureBounds(state?.active_window);
    if (captureBounds) screenshot = await screenshotRegion({ ...captureBounds, padding:0 });
  } catch {}

  if (!screenshot) {
    screenshot = await fileToolHandlers.take_screenshot({
      keep:false,
      ...(runtimeConfig.allowedRoots[0] ? { directory:runtimeConfig.allowedRoots[0] } : {}),
    });
    captureBounds = null;
  }
  const deadline = Date.now() + clamp(args.timeout_ms, 1500, 300, 10_000);
  let imagePart = null;
  let ocr = null;
  let match = null;
  let attempts = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    attempts = attempt + 1;
    imagePart = screenshotImagePart(screenshot);
    ocr = await ocrScreenshotResult(screenshot, args);
    if (!ocr.available) throw new Error(`OCR is unavailable: ${ocr.reason || 'unknown OCR error'}`);
    match = findOcrText(ocr, needle);
    if (match) break;
    if (attempt >= 2 || Date.now() >= deadline) break;
    await sleep(Math.min(150, Math.max(1, deadline - Date.now())));
    if (captureBounds) {
      screenshot = await screenshotRegion({ ...captureBounds, padding:0 });
    } else {
      screenshot = await fileToolHandlers.take_screenshot({
        keep:false,
        ...(runtimeConfig.allowedRoots[0] ? { directory:runtimeConfig.allowedRoots[0] } : {}),
      });
    }
  }
  if (!match) throw new Error(`OCR text not found after ${attempts} capture${attempts === 1 ? '' : 's'}: ${needle}`);
  let displays = null;
  try { displays = resultValue(await displayInventory()); } catch {}
  const point = mapOcrBoxToDesktop(match, imagePart, displays, captureBounds);
  const pointerResult = await pointer({ ...args, action:'click', x:point.x, y:point.y });
  return jsonResult({
    target:'ocr',
    action:'click',
    query:needle,
    attempts,
    match,
    point:{ x:point.x, y:point.y },
    mapping:{
      scale_x:point.scale_x,
      scale_y:point.scale_y,
      desktop_origin:point.desktop_origin,
      screenshot_size:point.screenshot_size || null,
      desktop_size:point.desktop_size || null,
      capture_bounds:captureBounds,
    },
    pointer:resultValue(pointerResult) || pointerResult?.content?.[0]?.text || null,
  });
}

export function browserTitleHint(activeWindow) {
  const title = optionalString(activeWindow?.title);
  if (!title) return null;
  const stripped = title.replace(/\s+[-—]\s+(Google Chrome|Chromium|Microsoft Edge|Brave)(?:\s+Browser)?$/i, '').trim();
  return stripped || null;
}

export function hasExplicitComputerScreenshotTarget(args = {}) {
  return (Array.isArray(args.screenshot_region) && args.screenshot_region.length === 4)
    || Boolean(args.screenshot_window_id)
    || args.screenshot_monitor != null
    || args.screenshot_monitor_index != null;
}

export function activeWindowCaptureBounds(window) {
  if (!window) return null;
  const x = Number(window.x), y = Number(window.y), width = Number(window.width), height = Number(window.height);
  if (![x,y,width,height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x:Math.round(x), y:Math.round(y), width:Math.round(width), height:Math.round(height) };
}

export function computerScreenshotTask(args = {}) {
  const region = Array.isArray(args.screenshot_region) ? args.screenshot_region.map(Number) : null;
  const targeted = region
    || args.screenshot_window_id
    || args.screenshot_monitor != null
    || args.screenshot_monitor_index != null;
  if (targeted) {
    const targetArgs = {
      padding:args.screenshot_padding,
      ...(region?.length === 4 ? { x:region[0], y:region[1], width:region[2] - region[0], height:region[3] - region[1] } : {}),
      ...(args.screenshot_window_id ? { window_id:args.screenshot_window_id } : {}),
      ...(args.screenshot_monitor != null ? { monitor:args.screenshot_monitor } : {}),
      ...(args.screenshot_monitor_index != null ? { monitor_index:args.screenshot_monitor_index } : {}),
    };
    return screenshotRegion(targetArgs);
  }
  return fileToolHandlers.take_screenshot({
    keep:false,
    ...(runtimeConfig.allowedRoots[0] ? { directory:runtimeConfig.allowedRoots[0] } : {}),
  });
}
