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


import { uiMatches } from './desktop-ui-actions.mjs';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const adapter = process.platform === 'win32' ? windows : process.platform === 'darwin' ? macos : linux;

export const UI_CACHE_TTL_MS = 5_000;
export let latestUiSnapshot = null;

export function suggestedUiAction(node = {}) {
  const role = String(node.role || '').toLowerCase();
  const patterns = Array.isArray(node.patterns) ? node.patterns.map(value => String(value).toLowerCase()) : [];
  if (patterns.includes('toggle') || /check|switch/.test(role)) return 'toggle';
  if (patterns.includes('range_value') || /slider|spin/.test(role)) return 'set_range_value';
  if (patterns.includes('selection_item') || /radio|listitem|treeitem|tabitem|option/.test(role)) return 'select';
  if (patterns.includes('expand_collapse') || /combo|treeitem|menuitem/.test(role)) return 'expand';
  if (patterns.includes('value') || /edit|textbox|text field|entry|search/.test(role)) return 'set_value';
  if (patterns.includes('invoke') || /button|link|menuitem/.test(role)) return 'invoke';
  if (node.scrollable === true || patterns.includes('scroll') || patterns.includes('scroll_item')) return 'scroll_into_view';
  return 'click';
}

export function semanticTreeText(nodes = [], maxChars = 48_000) {
  const lines = [];
  let chars = 0;
  for (const node of nodes) {
    const depth = Math.max(0, Math.min(32, Number(node.depth) || 0));
    const label = Number.isInteger(node.label) ? `#${node.label} ` : '';
    const role = String(node.role || 'element');
    const name = String(node.name || node.value || '').replace(/\s+/g, ' ').trim();
    const states = [
      node.focused === true ? 'focused' : '',
      node.enabled === false ? 'disabled' : '',
      node.offscreen === true ? 'offscreen' : '',
      node.password === true ? 'password' : '',
      node.toggle_state != null ? `toggle:${node.toggle_state}` : '',
      node.expand_collapse_state ? `state:${node.expand_collapse_state}` : '',
      node.range_value != null ? `value:${node.range_value}` : '',
    ].filter(Boolean);
    const line = `${'  '.repeat(depth)}${label}${role}${name ? ` "${name.slice(0, 240)}"` : ''} [${node.suggested_action || suggestedUiAction(node)}]${states.length ? ` ${states.map(v => `[${v}]`).join(' ')}` : ''}`;
    if (chars + line.length + (lines.length ? 1 : 0) > maxChars) {
      lines.push('… semantic tree truncated …');
      break;
    }
    lines.push(line);
    chars += line.length + (lines.length > 1 ? 1 : 0);
  }
  return lines.join('\n');
}

export function enrichUiPayload(value, args = {}) {
  const base = Array.isArray(value) ? { platform:process.platform, count:value.length, nodes:value } : { ...(value || {}) };
  const source = Array.isArray(base.nodes) ? base.nodes : [];
  let label = 0;
  const nodes = source.map(node => {
    const x = Number(node.x), y = Number(node.y), width = Number(node.width), height = Number(node.height);
    const usableBounds = [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0;
    const actionable = usableBounds && node.offscreen !== true && (
      node.enabled !== false || node.focused === true || String(node.name || '').trim() || String(node.role || '').trim()
    );
    const enriched = {
      ...node,
      ...(usableBounds ? { center_x:Math.round(x + width / 2), center_y:Math.round(y + height / 2) } : {}),
      suggested_action:suggestedUiAction(node),
    };
    if (actionable) enriched.label = label++;
    return enriched;
  });
  const payload = {
    ...base,
    count:Number(base.count) || nodes.length,
    nodes,
    label_count:label,
    semantic_tree:args.semantic_tree === false ? undefined : semanticTreeText(nodes),
    captured_at:new Date().toISOString(),
  };
  latestUiSnapshot = { at:Date.now(), payload, args:{ ...args } };
  return payload;
}

export function cachedUiNodes(args = {}) {
  if (!latestUiSnapshot || Date.now() - latestUiSnapshot.at > UI_CACHE_TTL_MS) return null;
  const requestedPid = Number.isInteger(Number(args.pid)) ? Number(args.pid) : null;
  const cachedNodes = latestUiSnapshot.payload?.nodes;
  if (!Array.isArray(cachedNodes)) return null;
  if (requestedPid != null && !cachedNodes.some(node => Number(node.pid) === requestedPid)) return null;
  if (args.app && !cachedNodes.some(node => String(node.app || '').toLowerCase().includes(String(args.app).toLowerCase()))) return null;
  if ((args.window_title || args.windowTitle) && !cachedNodes.some(node => String(node.window || node.window_title || '').toLowerCase().includes(String(args.window_title || args.windowTitle).toLowerCase()))) return null;
  return cachedNodes;
}

export function resolveCachedLabel(value, field = 'label') {
  if (value == null || value === '') return null;
  const label = Number(value);
  if (!Number.isInteger(label) || label < 0) throw new Error(`${field} must be a non-negative integer label returned by ui_snapshot/ui_find`);
  if (!latestUiSnapshot || Date.now() - latestUiSnapshot.at > UI_CACHE_TTL_MS) {
    throw new Error(`${field} refers to an expired UI snapshot; refresh ui_snapshot/ui_find before acting`);
  }
  const nodes = latestUiSnapshot.payload?.nodes;
  if (!Array.isArray(nodes)) throw new Error(`${field} requires a prior ui_snapshot/ui_find on the current desktop state`);
  const node = nodes.find(item => Number(item.label) === label);
  if (!node) throw new Error(`${field} ${label} is not present in the latest UI snapshot; refresh ui_snapshot`);
  return node;
}

export function withResolvedUiLabel(args = {}) {
  const node = resolveCachedLabel(args.label);
  if (!node) return args;
  return {
    ...args,
    id:args.id || node.id,
    pid:args.pid ?? node.pid,
    app:args.app || node.app,
    window_title:args.window_title || args.windowTitle || node.window || node.window_title,
    name:args.name || (!node.id ? node.name : undefined),
    role:args.role || (!node.id ? node.role : undefined),
  };
}

export function resultValue(result) {
  if (result?.structuredContent && !(Object.keys(result.structuredContent).length === 1 && typeof result.structuredContent.text === 'string')) {
    if (Object.keys(result.structuredContent).length === 1 && Object.hasOwn(result.structuredContent, 'data')) return result.structuredContent.data;
    return result.structuredContent;
  }
  const raw = result?.content?.find(part => part.type === 'text')?.text;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

export function objectRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function toolResultMessage(result) {
  const text = result?.content?.find(part => part.type === 'text')?.text;
  return String(text || 'tool returned an error result').slice(0, 2000);
}

export function snapshotError(source, settled) {
  if (settled?.status === 'rejected') {
    return { source, message:String(settled.reason?.message || settled.reason || 'capture rejected').slice(0, 2000) };
  }
  if (settled?.status === 'fulfilled' && settled.value?.isError === true) {
    return { source, message:toolResultMessage(settled.value) };
  }
  return null;
}

export function normalizeSnapshotErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.slice(0, 50).map((error, index) => {
    if (objectRecord(error)) {
      return {
        ...error,
        source:String(error.source || 'snapshot').slice(0, 120),
        message:String(error.message || error.error || 'snapshot capture error').slice(0, 2000),
      };
    }
    return { source:'snapshot', message:String(error ?? `snapshot error ${index + 1}`).slice(0, 2000) };
  });
}

export function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function boundedComputerSnapshot(payload) {
  const normalized = {
    ...payload,
    active_window:objectRecord(payload?.active_window),
    windows:Array.isArray(payload?.windows) ? payload.windows : [],
    displays:Array.isArray(payload?.displays) ? payload.displays : [],
    cursor:objectRecord(payload?.cursor) || { x:null, y:null },
    ui:objectRecord(payload?.ui) || { platform:process.platform, count:0, nodes:[] },
    clipboard:objectRecord(payload?.clipboard) || { available:false, length:0 },
    errors:normalizeSnapshotErrors(payload?.errors),
  };
  const budget = Math.min(768 * 1024, Math.max(16 * 1024, Math.floor(Number(liveConfig('maxOutputBytes') || 0) * 0.35)));
  const originalBytes = jsonBytes(normalized);
  if (originalBytes <= budget) {
    return { ...normalized, snapshot_bytes:originalBytes, snapshot_budget_bytes:budget, snapshot_truncated:false };
  }

  const bounded = {
    ...normalized,
    windows:[...normalized.windows],
    errors:normalizeSnapshotErrors(normalized.errors),
    ui:{
      ...normalized.ui,
      ...(Array.isArray(normalized.ui.nodes) ? { nodes:[...normalized.ui.nodes] } : {}),
    },
    browser:objectRecord(normalized.browser) ? {
      ...normalized.browser,
      ...(Array.isArray(normalized.browser.nodes) ? { nodes:[...normalized.browser.nodes] } : {}),
    } : undefined,
    ocr:objectRecord(normalized.ocr) ? {
      ...normalized.ocr,
      text:String(normalized.ocr.text || '').slice(0, 50_000),
      ...(Array.isArray(normalized.ocr.words) ? { words:[...normalized.ocr.words] } : {}),
      ...(Array.isArray(normalized.ocr.lines) ? { lines:[...normalized.ocr.lines] } : {}),
    } : undefined,
    snapshot_original_bytes:originalBytes,
    snapshot_budget_bytes:budget,
    snapshot_truncated:true,
  };

  const lists = [
    [bounded.ocr, 'words', 50],
    [bounded.ui, 'nodes', 100],
    [bounded.browser, 'nodes', 100],
    [bounded.visual, 'labeled_targets', 25],
    [bounded.ocr, 'lines', 25],
    [bounded, 'windows', 20],
  ];
  let guard = 0;
  while (jsonBytes(bounded) > budget && guard < 32) {
    guard += 1;
    let changed = false;
    for (const [container, key, floor] of lists) {
      const values = container?.[key];
      if (!Array.isArray(values) || values.length <= floor) continue;
      const nextLength = Math.max(floor, Math.floor(values.length * 0.6));
      container[key] = values.slice(0, nextLength);
      container.truncated = true;
      container[`returned_${key}`] = nextLength;
      changed = true;
      if (jsonBytes(bounded) <= budget) break;
    }
    if (!changed) break;
  }

  if (jsonBytes(bounded) > budget && bounded.ui && typeof bounded.ui.semantic_tree === 'string') {
    bounded.ui.semantic_tree = bounded.ui.semantic_tree.slice(0, 8_000);
    bounded.ui.semantic_tree_truncated = true;
  }

  if (jsonBytes(bounded) > budget) {
    if (bounded.ui && typeof bounded.ui === 'object') {
      bounded.ui = {
        platform:bounded.ui.platform || null,
        count:Number(bounded.ui.count) || (Array.isArray(bounded.ui.nodes) ? bounded.ui.nodes.length : 0),
        nodes:[],
        truncated:true,
        reason:'snapshot payload budget',
      };
    }
    if (bounded.browser && typeof bounded.browser === 'object') {
      bounded.browser = {
        target_id:bounded.browser.target_id || null,
        title:String(bounded.browser.title || '').slice(0, 500),
        url:String(bounded.browser.url || '').slice(0, 2000),
        count:Number(bounded.browser.count) || (Array.isArray(bounded.browser.nodes) ? bounded.browser.nodes.length : 0),
        nodes:[],
        truncated:true,
        reason:'snapshot payload budget',
      };
    }
    if (bounded.ocr && typeof bounded.ocr === 'object') {
      bounded.ocr = {
        available:Boolean(bounded.ocr.available),
        backend:bounded.ocr.backend || null,
        language:bounded.ocr.language || null,
        text:String(bounded.ocr.text || '').slice(0, 10_000),
        count:Number(bounded.ocr.count) || 0,
        total_words:Number(bounded.ocr.total_words) || 0,
        words:[],
        lines:[],
        truncated:true,
        reason:'snapshot payload budget',
      };
    }
    if (Array.isArray(bounded.windows)) bounded.windows = bounded.windows.slice(0, 10);
  }

  bounded.snapshot_bytes = jsonBytes(bounded);
  return bounded;
}

export function bestMonitor(window, displays) {
  if (!Array.isArray(displays)) return null;
  const wx1 = Number(window.x), wy1 = Number(window.y), ww = Number(window.width), wh = Number(window.height);
  if (![wx1, wy1, ww, wh].every(Number.isFinite) || ww <= 0 || wh <= 0) return null;
  const wx2 = wx1 + ww, wy2 = wy1 + wh;
  let best = null;
  let bestArea = 0;
  for (let index = 0; index < displays.length; index += 1) {
    const display = displays[index];
    const dx1 = Number(display.x), dy1 = Number(display.y), dw = Number(display.width), dh = Number(display.height);
    if (![dx1, dy1, dw, dh].every(Number.isFinite) || dw <= 0 || dh <= 0) continue;
    const area = Math.max(0, Math.min(wx2, dx1 + dw) - Math.max(wx1, dx1)) * Math.max(0, Math.min(wy2, dy1 + dh) - Math.max(wy1, dy1));
    if (area > bestArea) { bestArea = area; best = { index, ...display }; }
  }
  return best;
}

export async function listWindows(args = {}) {
  const raw = await adapter.listWindows(args);
  if (args.include_monitor === false) return raw;
  const windows = resultValue(raw);
  if (!Array.isArray(windows)) return raw;
  let displays = null;
  try { displays = resultValue(await adapter.displayInventory()); } catch {}
  if (!Array.isArray(displays)) return jsonResult(windows.map(window => ({ ...window, monitor: window.monitor ?? null })));
  return jsonResult(windows.map(window => {
    const monitor = bestMonitor(window, displays);
    return { ...window, monitor: monitor?.name ?? null, monitor_index: monitor?.index ?? null };
  }));
}
export async function windowAction(args = {}) {
  const hasTarget = Boolean(args.id || Number.isInteger(Number(args.pid)) || args.app || args.title);
  if (!hasTarget) throw new Error('window_action requires id, pid, app, or title');
  const action = optionalString(args.action);
  if (action === 'move' && ![args.x,args.y].every(value => Number.isFinite(Number(value)))) throw new Error('window_action move requires x and y');
  if (action === 'resize' && ![args.width,args.height].every(value => Number.isFinite(Number(value)))) throw new Error('window_action resize requires width and height');
  if (action === 'move_resize' && ![args.x,args.y,args.width,args.height].every(value => Number.isFinite(Number(value)))) throw new Error('window_action move_resize requires x, y, width and height');
  return adapter.windowAction(args);
}
export async function uiSnapshot(args = {}) {
  const explicitlyScoped = args.pid != null || args.app || args.window_title || args.windowTitle;
  const activeOnly = args.active_only != null
    ? args.active_only === true
    : (!explicitlyScoped && args.scope !== 'desktop');
  let effective = { ...args, active_only:activeOnly };
  let raw = await adapter.uiSnapshot(effective);
  let value = resultValue(raw);
  const requestedDepth = Number(effective.max_depth);
  const isEmptySnapshot = payload => Array.isArray(payload)
    ? payload.length === 0
    : Array.isArray(payload?.nodes) && payload.nodes.length === 0;
  if (process.platform === 'linux' && isEmptySnapshot(value)) {
    // GNOME/AT-SPI can transiently report an empty tree. Retry once at the requested
    // depth before reducing traversal depth, so valid deep trees are not discarded.
    await sleep(40);
    raw = await adapter.uiSnapshot(effective);
    value = resultValue(raw);
    if (isEmptySnapshot(value) && Number.isFinite(requestedDepth) && requestedDepth > 12) {
      effective = { ...effective, max_depth:12 };
      raw = await adapter.uiSnapshot(effective);
      value = resultValue(raw);
    }
  }
  return jsonResult(enrichUiPayload(value, effective));
}
export async function uiAction(args = {}) {
  const resolved = withResolvedUiLabel(args);
  const hasTarget = Boolean(resolved.id || resolved.label != null || resolved.name || resolved.role || resolved.automation_id || resolved.automationId);
  if (!hasTarget) throw new Error('ui_action requires id, label, name, role, or automation_id');
  const action = optionalString(resolved.action);
  if (['set_value','set_range_value'].includes(action) && resolved.value == null) throw new Error(`ui_action ${action} requires value`);
  return adapter.uiAction(resolved);
}
export async function keyboard(args = {}) { return adapter.keyboard(args); }
export async function pointer(args = {}) {
  if (args.action === 'move' && ![args.x,args.y].every(value => Number.isFinite(Number(value)))) throw new Error('pointer move requires x and y');
  return adapter.pointer(args);
}
export async function clipboard(args = {}) { return adapter.clipboard(args); }
export async function displayInventory(args = {}) { return adapter.displayInventory(args); }
export async function cursorPosition(args = {}) { return typeof adapter.cursorPosition === 'function' ? adapter.cursorPosition(args) : jsonResult({ x:null, y:null }); }

export async function screenshotRegion(args = {}) {
  let x = Number(args.x), y = Number(args.y), width = Number(args.width), height = Number(args.height);
  const hasRect = [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0;
  if (!hasRect) {
    const windowId = optionalString(args.window_id || args.id);
    const app = optionalString(args.app);
    const title = optionalString(args.title);
    const pid = Number.isInteger(Number(args.pid)) ? Number(args.pid) : null;
    if (windowId || app || title || pid != null) {
      let row = null;
      if (windowId && typeof adapter.resolveWindowTarget === 'function') {
        row = resultValue(await adapter.resolveWindowTarget({
          id:windowId,
          ...(pid != null ? { pid } : {}),
          ...(app ? { app } : {}),
          ...(title ? { title } : {}),
        }));
      } else {
        const rows = resultValue(await listWindows({ include_monitor:false }));
        row = Array.isArray(rows) ? rows.find(item =>
          (!windowId || item.id === windowId)
          && (pid == null || Number(item.pid) === pid)
          && (!app || String(item.app || '').toLowerCase().includes(app.toLowerCase()))
          && (!title || String(item.title || '').toLowerCase().includes(title.toLowerCase()))
        ) : null;
      }
      if (!row) throw new Error('No matching window found for screenshot_region');
      x = Number(row.x); y = Number(row.y); width = Number(row.width); height = Number(row.height);
    } else if (args.monitor != null || args.monitor_index != null) {
      const displays = resultValue(await displayInventory());
      if (!Array.isArray(displays)) throw new Error('This platform does not expose normalized monitor geometry for screenshot_region');
      const index = Number.isInteger(Number(args.monitor_index)) ? Number(args.monitor_index) : null;
      const monitor = optionalString(args.monitor);
      const row = displays.find((item, itemIndex) =>
        (index == null || itemIndex === index)
        && (!monitor || (monitor.toLowerCase() === 'primary' ? Boolean(item.primary) : String(item.name || item.display_name || '').toLowerCase().includes(monitor.toLowerCase())))
      );
      if (!row) throw new Error('No matching monitor found for screenshot_region');
      x = Number(row.x); y = Number(row.y); width = Number(row.width); height = Number(row.height);
    }
  }
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error('Provide x/y/width/height, a window selector, or a monitor selector');
  }
  const padding = clamp(args.padding, 0, 0, 200);
  if (padding) { x -= padding; y -= padding; width += padding * 2; height += padding * 2; }
  return adapter.screenshotRegion({ ...args, x, y, width, height });
}
export async function notification(args = {}) { return adapter.notification(args); }
export async function scroll(args = {}) {
  const direction = optionalString(args.direction);
  const hasDelta = [args.delta_x,args.delta_y,args.delta].some(value => value != null && Number.isFinite(Number(value)));
  if (!direction && !hasDelta) throw new Error('scroll requires direction or a delta');
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
  const semanticTarget = args.label != null || args.id || args.name || args.role || args.automation_id || args.automationId;
  if (semanticTarget) {
    const nodes = await uiMatches({ ...args, limit:1, refresh:true });
    const node = nodes[0];
    if (!node) throw new Error('Scroll target UI element was not found');
    const x = Number(node.center_x ?? (Number(node.x) + Number(node.width) / 2));
    const y = Number(node.center_y ?? (Number(node.y) + Number(node.height) / 2));
    if (Number.isFinite(x) && Number.isFinite(y)) await pointer({ action:'move', x:Math.round(x), y:Math.round(y), backend:args.backend });
  } else if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
    await pointer({ action:'move', x:Number(args.x), y:Number(args.y), backend:args.backend });
  }
  return adapter.scroll({ ...args, delta_x:deltaX, delta_y:deltaY });
}
