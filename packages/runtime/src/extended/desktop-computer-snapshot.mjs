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


import { boundedComputerSnapshot, clipboard, cursorPosition, displayInventory, listWindows, objectRecord, resultValue, screenshotRegion, snapshotError, suggestedUiAction, toolResultMessage, uiSnapshot } from './desktop-core.mjs';
import { activeWindowCaptureBounds, browserTitleHint, computerScreenshotTask, hasExplicitComputerScreenshotTarget, ocrScreenshotResult } from './desktop-vision.mjs';

export async function computerSnapshot(args = {}) {
  const desktopAvailable = desktopSessionAvailable();
  const screenshotRequested = args.include_screenshot !== false || args.include_ocr === true;
  const captureScreenshot = desktopAvailable && screenshotRequested;
  const includeUi = args.include_ui !== false;
  const [windowsResult, displaysResult, uiResult, clipboardResult, cursorResult, shotResult] = await Promise.allSettled([
    desktopAvailable ? listWindows() : Promise.resolve(null),
    desktopAvailable ? displayInventory() : Promise.resolve(null),
    includeUi && desktopAvailable
      ? uiSnapshot({
          max_nodes:args.max_ui_nodes || 800,
          max_depth:args.max_ui_depth || 12,
          semantic_tree:args.semantic_tree !== false,
          active_only:args.ui_scope === 'desktop' ? false : true,
          ...(args.ui_browser_dom === true ? { browser_dom:true } : {}),
        })
      : Promise.resolve(null),
    desktopAvailable ? clipboard({ action:'read' }) : Promise.resolve(null),
    desktopAvailable ? cursorPosition() : Promise.resolve(null),
    captureScreenshot ? computerScreenshotTask(args) : Promise.resolve(null),
  ]);
  const parse = (result, fallback = null) => {
    if (result.status !== 'fulfilled' || !result.value || result.value.isError === true) return fallback;
    return resultValue(result.value) ?? fallback;
  };
  const shapeErrors = [];
  const parsedWindows = parse(windowsResult, []);
  const windows = Array.isArray(parsedWindows) ? parsedWindows : [];
  if (parsedWindows !== windows && parsedWindows != null) {
    shapeErrors.push({ source:'windows', message:'window inventory returned an invalid result shape' });
  }
  const parsedDisplays = parse(displaysResult, []);
  const displays = Array.isArray(parsedDisplays) ? parsedDisplays : [];
  if (parsedDisplays !== displays && parsedDisplays != null) {
    shapeErrors.push({ source:'displays', message:'display inventory returned an invalid result shape' });
  }
  const parsedCursor = parse(cursorResult, { x:null, y:null });
  const cursor = objectRecord(parsedCursor) || { x:null, y:null };
  if (parsedCursor !== cursor && parsedCursor != null) {
    shapeErrors.push({ source:'cursor', message:'cursor position returned an invalid result shape' });
  }
  const parsedUi = includeUi ? parse(uiResult, null) : null;
  const ui = objectRecord(parsedUi) || { platform:process.platform, count:0, nodes:[], ...(includeUi ? { unavailable:true } : { skipped:true }) };
  if (includeUi && parsedUi !== ui && parsedUi != null) {
    shapeErrors.push({ source:'ui', message:'accessibility snapshot returned an invalid result shape' });
  }
  const clipboardOk = desktopAvailable && clipboardResult.status === 'fulfilled' && clipboardResult.value?.isError !== true && Boolean(clipboardResult.value);
  const clipText = clipboardOk ? clipboardResult.value.content?.[0]?.text || '' : '';
  const uiNodes = Array.isArray(ui?.nodes) ? ui.nodes : Array.isArray(ui) ? ui : [];
  const focusedNodes = uiNodes.filter(node => node.focused === true);
  const focusScore = node => {
    const app = String(node.app || '').toLowerCase();
    const windowName = String(node.window || '').trim();
    const role = String(node.role || '').toLowerCase();
    let score = 0;
    if (windowName) score += 100;
    if (app && app !== 'gnome-shell') score += 40;
    if (node.name) score += 15;
    if (!['window','filler','panel'].includes(role)) score += 15;
    if (Number(node.width) >= 100 && Number(node.height) >= 100) score += 10;
    if (/desktop icons/i.test(windowName)) score -= 80;
    if (app === 'gnome-shell' && !windowName) score -= 120;
    return score;
  };
  const focusedNode = focusedNodes.sort((a, b) => focusScore(b) - focusScore(a))[0] || null;
  const activeTopLevel = uiNodes.find(node =>
    node.active === true
    && /frame|window|dialog/i.test(String(node.role || ''))
    && String(node.window || node.name || '').trim()
    && !/desktop icons/i.test(String(node.window || node.name || ''))
  ) || null;
  const activeNode = activeTopLevel
    || focusedNode
    || uiNodes.find(node => /frame|window|dialog/i.test(String(node.role || '')) && String(node.window || node.name || '').trim())
    || uiNodes[0]
    || null;
  const windowRows = Array.isArray(windows) ? windows : [];
  const activeWindow = activeNode ? windowRows.find(row => {
    const activePid = Number(activeNode.pid);
    const rowPid = Number(row.pid);
    const wantedTitle = String(activeNode.window || activeNode.name || '').trim().toLowerCase();
    const rowTitle = String(row.title || '').trim().toLowerCase();
    const pidMatch = activePid > 0 && rowPid > 0 && rowPid === activePid;
    // XWayland/WM enumeration can report pid=0 while AT-SPI still exposes the real application PID.
    // A strong top-level title match is the safe fallback for joining those two views.
    const titleMatch = Boolean(wantedTitle && rowTitle && (rowTitle === wantedTitle || rowTitle.includes(wantedTitle) || wantedTitle.includes(rowTitle)));
    return (pidMatch || titleMatch) && (!wantedTitle || titleMatch || pidMatch);
  }) || null : null;
  const activeApp = activeNode ? {
    pid: Number(activeNode.pid) || activeWindow?.pid || null,
    app: activeNode.app || activeWindow?.app || null,
    window: activeNode.window || activeWindow?.title || null,
  } : null;

  const activeLabel = [activeApp?.app, activeApp?.window, activeWindow?.app, activeWindow?.title].filter(Boolean).join(' ');
  const browserRequested = args.include_browser === true
    || (args.include_browser !== false && /chrome|chromium|edge|brave/i.test(activeLabel));
  let browser = null;
  let browserError = null;
  if (browserRequested && await browserCapabilityAvailable(undefined, 400)) {
    const hint = browserTitleHint(activeWindow);
    try {
      const browserResult = await browserSnapshot({
        ...(hint ? { title:hint } : {}),
        max_nodes:clamp(args.browser_max_nodes, 500, 1, 2000),
        timeout_ms:3000,
      });
      if (browserResult?.isError === true) throw new Error(toolResultMessage(browserResult));
      browser = objectRecord(resultValue(browserResult));
      if (!browser) throw new Error('browser snapshot returned an invalid result shape');
    } catch (error) {
      if (hint) {
        try {
          const fallbackResult = await browserSnapshot({
            max_nodes:clamp(args.browser_max_nodes, 500, 1, 2000),
            timeout_ms:3000,
          });
          if (fallbackResult?.isError === true) throw new Error(toolResultMessage(fallbackResult));
          browser = objectRecord(resultValue(fallbackResult));
          if (!browser) throw new Error('browser snapshot returned an invalid result shape');
        } catch (fallbackError) {
          browserError = String(fallbackError?.message || fallbackError);
        }
      } else {
        browserError = String(error?.message || error);
      }
    }
  }

  const ocrRequested = args.include_ocr === true
    || (desktopAvailable && args.include_ocr !== false && screenshotRequested && uiNodes.length === 0 && !browser);
  const shouldOcr = desktopAvailable && ocrRequested;
  let ocr = null;
  let ocrCaptureBounds = null;
  let ocrShotResult = shotResult;
  // A whole-desktop OCR pass is noisy and slow when the active application is already known.
  // Keep the normal screenshot contract unchanged, but use a second tightly scoped capture for OCR.
  if (shouldOcr && !hasExplicitComputerScreenshotTarget(args)) {
    const bounds = activeWindowCaptureBounds(activeWindow);
    if (bounds) {
      try {
        const targeted = await screenshotRegion({ ...bounds, padding:0 });
        ocrShotResult = { status:'fulfilled', value:targeted };
        ocrCaptureBounds = bounds;
      } catch {
        // Fall back to the already captured desktop screenshot below.
      }
    }
  }
  if (shouldOcr) {
    ocr = ocrShotResult.status === 'fulfilled' && ocrShotResult.value
      ? await ocrScreenshotResult(ocrShotResult.value, args)
      : { available:false, reason:'screenshot capture failed before OCR could run' };
    if (ocr?.available && ocrCaptureBounds) {
      ocr = { ...ocr, coordinate_space:'capture_pixels', capture_bounds:ocrCaptureBounds };
    }
  }

  const payload = {
    device: { hostname: os.hostname(), platform: process.platform, arch: process.arch },
    platform: process.platform,
    hostname: os.hostname(),
    active_app: activeApp,
    active_window: activeWindow,
    windows,
    displays,
    cursor,
    ui,
    ...(browser ? { browser } : {}),
    ...(ocr ? { ocr } : {}),
    fallback_chain: {
      accessibility: { requested:includeUi, available:includeUi && desktopAvailable && uiResult.status === 'fulfilled' && Boolean(uiResult.value), nodes:uiNodes.length },
      native_browser_dom: {
        requested:includeUi && args.ui_browser_dom === true,
        available:Boolean(includeUi && ui?.browser_dom?.available),
        provider:ui?.browser_dom?.provider || null,
      },
      browser_dom: { requested:browserRequested, available:Boolean(browser) },
      ocr: { requested:ocrRequested, available:Boolean(ocr?.available), backend:ocr?.backend || null },
      vision_screenshot: { available:shotResult.status === 'fulfilled' && Boolean(shotResult.value?.content?.some(part => part.type === 'image')) },
    },
    visual: {
      coordinate_space:'virtual_desktop',
      labeled_targets:uiNodes.filter(node => Number.isInteger(node.label)).slice(0, 500).map(node => ({
        label:node.label,
        id:node.id || null,
        role:node.role || null,
        name:String(node.name || '').slice(0, 240),
        x:Number(node.x) || 0,
        y:Number(node.y) || 0,
        width:Number(node.width) || 0,
        height:Number(node.height) || 0,
        action:node.suggested_action || suggestedUiAction(node),
      })),
      ...(Number(args.grid_columns) > 0 || Number(args.grid_rows) > 0 ? {
        reference_grid:{
          columns:clamp(args.grid_columns, 0, 0, 20),
          rows:clamp(args.grid_rows, 0, 0, 20),
        },
      } : {}),
      screenshot_scope:Array.isArray(args.screenshot_region) ? 'region'
        : args.screenshot_window_id ? 'window'
        : (args.screenshot_monitor != null || args.screenshot_monitor_index != null) ? 'monitor'
        : 'desktop',
    },
    clipboard: { available:clipboardOk, length:clipText.length },
    errors: [
      ...[
        ['windows', windowsResult],
        ['displays', displaysResult],
        ...(includeUi ? [['ui', uiResult]] : []),
        ['clipboard', clipboardResult],
        ['cursor', cursorResult],
        ...(captureScreenshot ? [['screenshot', shotResult]] : []),
      ].map(([source, result]) => snapshotError(source, result)).filter(Boolean),
      ...shapeErrors,
      ...(browserError ? [{ source:'browser', message:browserError.slice(0, 2000) }] : []),
    ],
  };
  const boundedPayload = boundedComputerSnapshot(payload);
  const parts = [{ type: 'text', text: JSON.stringify(boundedPayload, null, 2) }];
  if (args.include_screenshot !== false && shotResult.status === 'fulfilled' && shotResult.value?.content) {
    for (const part of shotResult.value.content) if (part.type === 'image') parts.push(part);
  }
  const result = multi(parts);
  result.structuredContent = boundedPayload;
  return result;
}
