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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const adapter = process.platform === 'win32' ? windows : process.platform === 'darwin' ? macos : linux;

const UI_CACHE_TTL_MS = 5_000;
let latestUiSnapshot = null;

function suggestedUiAction(node = {}) {
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

function semanticTreeText(nodes = [], maxChars = 48_000) {
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

function enrichUiPayload(value, args = {}) {
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

function cachedUiNodes(args = {}) {
  if (!latestUiSnapshot || Date.now() - latestUiSnapshot.at > UI_CACHE_TTL_MS) return null;
  const requestedPid = Number.isInteger(Number(args.pid)) ? Number(args.pid) : null;
  const cachedNodes = latestUiSnapshot.payload?.nodes;
  if (!Array.isArray(cachedNodes)) return null;
  if (requestedPid != null && !cachedNodes.some(node => Number(node.pid) === requestedPid)) return null;
  if (args.app && !cachedNodes.some(node => String(node.app || '').toLowerCase().includes(String(args.app).toLowerCase()))) return null;
  if ((args.window_title || args.windowTitle) && !cachedNodes.some(node => String(node.window || node.window_title || '').toLowerCase().includes(String(args.window_title || args.windowTitle).toLowerCase()))) return null;
  return cachedNodes;
}

function resolveCachedLabel(value, field = 'label') {
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

function withResolvedUiLabel(args = {}) {
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

function resultValue(result) {
  if (result?.structuredContent && !(Object.keys(result.structuredContent).length === 1 && typeof result.structuredContent.text === 'string')) {
    if (Object.keys(result.structuredContent).length === 1 && Object.hasOwn(result.structuredContent, 'data')) return result.structuredContent.data;
    return result.structuredContent;
  }
  const raw = result?.content?.find(part => part.type === 'text')?.text;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

function objectRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function toolResultMessage(result) {
  const text = result?.content?.find(part => part.type === 'text')?.text;
  return String(text || 'tool returned an error result').slice(0, 2000);
}

function snapshotError(source, settled) {
  if (settled?.status === 'rejected') {
    return { source, message:String(settled.reason?.message || settled.reason || 'capture rejected').slice(0, 2000) };
  }
  if (settled?.status === 'fulfilled' && settled.value?.isError === true) {
    return { source, message:toolResultMessage(settled.value) };
  }
  return null;
}

function normalizeSnapshotErrors(errors) {
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

function jsonBytes(value) {
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

function bestMonitor(window, displays) {
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

function matches(node, args) {
  const id = optionalString(args.id);
  const label = args.label == null || args.label === '' ? null : Number(args.label);
  const name = optionalString(args.name);
  const role = optionalString(args.role);
  const value = optionalString(args.value);
  const automationId = optionalString(args.automation_id || args.automationId);
  const app = optionalString(args.app);
  const windowTitle = optionalString(args.window_title || args.windowTitle);
  const pid = Number.isInteger(Number(args.pid)) ? Number(args.pid) : null;
  if (label != null && (!Number.isInteger(label) || Number(node.label) !== label)) return false;
  if (id && node.id !== id) return false;
  if (pid != null && Number(node.pid) !== pid) return false;
  if (app && !String(node.app || '').toLowerCase().includes(app.toLowerCase())) return false;
  if (windowTitle && !String(node.window || node.window_title || '').toLowerCase().includes(windowTitle.toLowerCase())) return false;
  if (name && !String(node.name || '').toLowerCase().includes(name.toLowerCase())) return false;
  if (role && !String(node.role || '').toLowerCase().includes(role.toLowerCase())) return false;
  if (value && !String(node.value || '').toLowerCase().includes(value.toLowerCase())) return false;
  if (automationId && String(node.automationId || '') !== automationId) return false;
  return true;
}

async function uiMatches(args = {}) {
  const resolved = args.label != null ? withResolvedUiLabel(args) : args;
  const cached = resolved.refresh === true ? null : cachedUiNodes(resolved);
  if (cached) {
    const hits = cached.filter(node => matches(node, resolved)).slice(0, clamp(resolved.limit, 20, 1, 200));
    if (hits.length || resolved.cache_only === true || resolved.id || resolved.label != null) return hits;
  }
  const stableLinuxPid = optionalString(resolved.id)?.match(/^linux:(\d+):/)?.[1];
  const scopedPid = resolved.pid != null ? resolved.pid : stableLinuxPid ? Number(stableLinuxPid) : null;
  const result = await uiSnapshot({
    max_nodes: resolved.max_nodes || 2000,
    max_depth: resolved.max_depth || (process.platform === 'linux' ? 12 : 16),
    ...(scopedPid != null ? { pid: scopedPid } : {}),
    ...(resolved.app ? { app: resolved.app } : {}),
    ...((resolved.window_title || resolved.windowTitle) ? { window_title: resolved.window_title || resolved.windowTitle } : {}),
    ...(resolved.browser_dom === true ? { browser_dom:true } : {}),
  });
  const payload = resultValue(result) || {};
  const nodes = Array.isArray(payload) ? payload : payload.nodes || [];
  return nodes.filter(node => matches(node, resolved)).slice(0, clamp(resolved.limit, 20, 1, 200));
}

export async function uiFind(args = {}) {
  const hasSelector = Boolean(args.id || args.label != null || args.name || args.role || args.automation_id || args.automationId);
  if (!hasSelector) throw new Error('ui_find requires id, label, name, role, or automation_id; use ui_snapshot to enumerate UI');
  const nodes = await uiMatches(args);
  return jsonResult({ count: nodes.length, nodes });
}

function uiFingerprint(nodes) {
  return JSON.stringify((nodes || []).map(node => ({
    id: node.id ?? null,
    role: node.role ?? null,
    name: node.name ?? null,
    value: node.value ?? null,
    x: Number(node.x || 0), y: Number(node.y || 0),
    width: Number(node.width || 0), height: Number(node.height || 0),
  })));
}

function uiTextContains(node, needle) {
  if (!needle) return true;
  const normalized = String(needle).toLowerCase();
  return [
    node.name, node.value, node.description, node.help_text, node.helpText,
    node.role, node.window, node.window_title, node.automationId,
  ].some(value => String(value || '').toLowerCase().includes(normalized));
}

async function uiConditionMatches(args, condition) {
  if (condition === 'active_window') {
    const expected = optionalString(args.window_title || args.windowTitle || args.text || args.name);
    const nodes = await uiMatches({ ...args, name:undefined, role:undefined, value:undefined, id:undefined, label:undefined, limit:200 });
    const active = nodes.filter(node => node.active === true || (
      node.focused === true && /window|frame|dialog/i.test(String(node.role || ''))
    ));
    const matched = expected ? active.filter(node => uiTextContains(node, expected)) : active;
    return { matched:matched.length > 0, nodes:matched, detail:matched[0]?.window || matched[0]?.name || null };
  }
  if (condition === 'text_exists') {
    const needle = optionalString(args.text || args.name || args.value);
    if (!needle) throw new Error('text is required for wait_for_ui condition=text_exists');
    const cached = cachedUiNodes(args);
    let nodes = cached || [];
    if (!cached) {
      const snapshot = resultValue(await uiSnapshot({
        max_nodes:args.max_nodes || 2000,
        max_depth:args.max_depth || (process.platform === 'linux' ? 12 : 16),
        ...(args.pid != null ? { pid:args.pid } : {}),
        ...(args.app ? { app:args.app } : {}),
        ...((args.window_title || args.windowTitle) ? { window_title:args.window_title || args.windowTitle } : {}),
        ...(args.browser_dom === true ? { browser_dom:true } : {}),
      })) || {};
      nodes = Array.isArray(snapshot) ? snapshot : snapshot.nodes || [];
    }
    const matched = nodes.filter(node => uiTextContains(node, needle)).slice(0, clamp(args.limit, 20, 1, 200));
    return { matched:matched.length > 0, nodes:matched, detail:needle };
  }

  const nodes = await uiMatches(args);
  if (condition === 'element_enabled') {
    const enabled = nodes.filter(node => node.enabled === true || node.disabled === false);
    return { matched:enabled.length > 0, nodes:enabled };
  }
  if (condition === 'focused_element') {
    const focused = nodes.filter(node => node.focused === true || node.has_focused === true);
    return { matched:focused.length > 0, nodes:focused };
  }
  return { matched:nodes.length > 0, nodes };
}

export async function waitForUi(args = {}) {
  const timeoutMs = clamp(args.timeout_ms, 10_000, 100, 120_000);
  const pollMs = clamp(args.poll_ms, 250, 50, 5000);
  const rawCondition = optionalString(args.condition);
  const rawState = optionalString(args.state);
  if (!rawCondition && !rawState) throw new Error('wait_for_ui requires state or condition');
  const aliases = { text:'text_exists', window:'active_window', element:'element_exists', enabled:'element_enabled', focused:'focused_element' };
  const condition = rawCondition
    ? requireEnum(aliases[rawCondition] || rawCondition, 'condition', ['text_exists','active_window','element_exists','element_enabled','focused_element'])
    : null;
  const state = condition ? null : requireEnum(rawState, 'state', ['present', 'absent', 'changed']);
  const hasSelector = Boolean(args.id || args.label != null || args.name || args.role || args.automation_id || args.automationId);
  if (['element_exists','element_enabled'].includes(condition) && !hasSelector) throw new Error(`wait_for_ui condition=${condition} requires a semantic target`);
  if (condition === 'active_window' && !(args.text || args.name || args.window_title || args.windowTitle)) throw new Error('wait_for_ui condition=active_window requires text, name, or window_title');
  if (['present','absent'].includes(state) && !hasSelector) throw new Error(`wait_for_ui state=${state} requires a semantic target`);
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let attempts = 0;

  if (condition) {
    let evaluation = { matched:false, nodes:[] };
    do {
      attempts += 1;
      // A wait must observe fresh state, not repeatedly query the same 5-second cache.
      latestUiSnapshot = null;
      evaluation = await uiConditionMatches(args, condition);
      if (evaluation.matched) {
        return jsonResult({
          condition,
          matched:true,
          attempts,
          elapsed_ms:Date.now() - startedAt,
          count:evaluation.nodes.length,
          nodes:evaluation.nodes,
          ...(evaluation.detail ? { detail:evaluation.detail } : {}),
        });
      }
      await sleep(pollMs);
    } while (Date.now() < deadline);
    return jsonResult({
      condition,
      matched:false,
      state:'timeout',
      attempts,
      elapsed_ms:Date.now() - startedAt,
      count:evaluation.nodes?.length || 0,
      nodes:evaluation.nodes || [],
    });
  }

  latestUiSnapshot = null;
  const baseline = state === 'changed' ? await uiMatches(args) : [];
  const baselineFingerprint = state === 'changed' ? uiFingerprint(baseline) : null;
  let nodes = baseline;
  do {
    attempts += 1;
    latestUiSnapshot = null;
    nodes = await uiMatches(args);
    const changed = state === 'changed' && uiFingerprint(nodes) !== baselineFingerprint;
    if ((state === 'present' && nodes.length) || (state === 'absent' && !nodes.length) || changed) {
      return jsonResult({
        state,
        matched: nodes.length,
        attempts,
        elapsed_ms:Date.now() - startedAt,
        nodes,
        ...(state === 'changed' ? { before: baseline } : {}),
      });
    }
    await sleep(pollMs);
  } while (Date.now() < deadline);
  return jsonResult({ state:'timeout', wanted:state, matched:nodes.length, attempts, elapsed_ms:Date.now() - startedAt, nodes, ...(state === 'changed' ? { before:baseline } : {}) });
}

function explicitTypeTextWindowTarget(args = {}, hasElementSelector = false) {
  const windowId = optionalString(args.window_id || args.windowId);
  const title = optionalString(args.title);
  if (!windowId && !title && hasElementSelector) return null;
  const pid = Number.isInteger(Number(args.pid)) ? Number(args.pid) : null;
  const app = optionalString(args.app);
  const scopedTitle = optionalString(args.window_title || args.windowTitle);
  if (!windowId && !title && pid == null && !app && !scopedTitle) return null;
  return {
    ...(windowId ? { id:windowId } : {}),
    ...(pid != null ? { pid } : {}),
    ...(app ? { app } : {}),
    ...((title || scopedTitle) ? { title:title || scopedTitle } : {}),
    ...(args.backend ? { backend:args.backend } : {}),
  };
}

export async function typeText(args = {}) {
  const value = String(args.text ?? '');
  const method = requireEnum(args.method || 'auto', 'method', ['auto','accessibility','clipboard','keys']);
  const resolvedArgs = args.label != null ? withResolvedUiLabel(args) : args;
  const hasElementSelector = Boolean(
    optionalString(resolvedArgs.id) || optionalString(resolvedArgs.name) || optionalString(resolvedArgs.role) ||
    optionalString(resolvedArgs.automation_id || resolvedArgs.automationId)
  );
  const explicitWindowTarget = explicitTypeTextWindowTarget(resolvedArgs, hasElementSelector);
  const clear = args.clear === true;
  const pressEnter = args.press_enter === true;
  const caret = requireEnum(args.caret_position || 'idle', 'caret_position', ['start','idle','end']);

  if (
    explicitWindowTarget && !hasElementSelector && clear && !pressEnter
    && (method === 'auto' || method === 'accessibility')
    && typeof adapter.typeTextWindowTarget === 'function'
  ) {
    const semantic = await adapter.typeTextWindowTarget(value, resolvedArgs);
    if (semantic) {
      return jsonResult({ length:value.length, method:'accessibility', target:semantic, clear:true, press_enter:false });
    }
    if (method === 'accessibility') {
      throw new Error('Accessibility-only text input needs exactly one editable control in the targeted window when no element selector is provided');
    }
  }

  if ((method === 'auto' || method === 'accessibility') && hasElementSelector) {
    try {
      const result = await uiAction({ ...resolvedArgs, action:'set_value', value });
      const raw = result.content?.[0]?.text || '';
      let target = raw;
      try { target = JSON.parse(raw); } catch {}
      if (pressEnter) await keyboard({ ...resolvedArgs, key:'ENTER' });
      return jsonResult({ length:value.length, method:'accessibility', target, clear:true, press_enter:pressEnter });
    } catch (error) {
      if (method === 'accessibility') throw error;
      if (!clear && caret === 'idle' && typeof adapter.typeTextFocused === 'function') {
        await uiAction({ ...resolvedArgs, action:'focus' });
        const semantic = await adapter.typeTextFocused(value, resolvedArgs);
        if (semantic) {
          if (pressEnter) await keyboard({ ...resolvedArgs, key:'ENTER' });
          return jsonResult({ length:value.length, method:'accessibility', target:semantic, press_enter:pressEnter });
        }
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Semantic text target rejected accessibility input. Refresh the UI target or use browser_action for browser page content. ${detail}`);
    }
  }
  if (
    !explicitWindowTarget && (method === 'auto' || method === 'accessibility') && !hasElementSelector
    && typeof adapter.typeTextFocused === 'function' && !clear && caret === 'idle'
  ) {
    const semantic = await adapter.typeTextFocused(value, resolvedArgs);
    if (semantic) {
      if (pressEnter) await keyboard({ ...resolvedArgs, key:'ENTER' });
      return jsonResult({ length:value.length, method:'accessibility', target:semantic, press_enter:pressEnter });
    }
    if (method === 'accessibility') throw new Error('No focused editable accessibility element is available');
  }
  if (method === 'accessibility') {
    throw new Error('Accessibility-only text input requires a semantic element target, one editable control in the targeted window with clear=true, or a focused editable control with clear=false and caret_position=idle');
  }

  if (explicitWindowTarget) await windowAction({ action:'focus', ...explicitWindowTarget });
  if (hasElementSelector) await uiAction({ ...resolvedArgs, action:'focus' });
  if (clear) {
    await keyboard({ ...resolvedArgs, shortcut:process.platform === 'darwin' ? 'CMD+A' : 'CTRL+A' });
    await keyboard({ ...resolvedArgs, key:'BACKSPACE' });
  }
  if (caret === 'start') await keyboard({ ...resolvedArgs, key:'HOME' });
  if (caret === 'end') await keyboard({ ...resolvedArgs, key:'END' });

  if (method === 'keys' && typeof adapter.typeTextKeys === 'function') {
    const result = await adapter.typeTextKeys(value, resolvedArgs);
    if (pressEnter) await keyboard({ ...resolvedArgs, key:'ENTER' });
    return jsonResult({ length:value.length, method:'keys', press_enter:pressEnter, ...(result?.backend ? { backend:result.backend } : {}) });
  }

  let prior = null;
  let priorReadable = false;
  try {
    const previous = await clipboard({ action:'read' });
    prior = previous.content?.[0]?.text ?? '';
    priorReadable = true;
  } catch {}
  try {
    await clipboard({ action:'write', text:value });
    await sleep(50);
    await keyboard({ ...resolvedArgs, shortcut:process.platform === 'darwin' ? 'CMD+V' : 'CTRL+V' });
    await sleep(75);
    if (pressEnter) await keyboard({ ...resolvedArgs, key:'ENTER' });
  } finally {
    if (priorReadable) {
      try { await clipboard({ action:'write', text:prior }); } catch {}
    }
  }
  return jsonResult({ length:value.length, method:'clipboard_paste', clipboard_restored:priorReadable, press_enter:pressEnter });
}

async function uiElementCenter(id, field) {
  const matches = await uiMatches({ id, limit: 1, max_nodes: 5000, max_depth: 32, refresh:true });
  const node = matches[0];
  if (!node) throw new Error(`${field} UI element was not found: ${id}`);
  const x = Number(node.x), y = Number(node.y), width = Number(node.width), height = Number(node.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error(`${field} UI element has no usable screen bounds: ${id}`);
  }
  return { x: Math.round(x + width / 2), y: Math.round(y + height / 2), node };
}

export async function dragDrop(args = {}) {
  let fromX = Number(args.from_x), fromY = Number(args.from_y);
  let toX = Number(args.to_x), toY = Number(args.to_y);
  let fromNode = null;
  let toNode = null;
  if (!Number.isFinite(fromX) || !Number.isFinite(fromY)) {
    const id = optionalString(args.from_id);
    if (!id) throw new Error('Provide from_x/from_y or from_id');
    const resolved = await uiElementCenter(id, 'from_id');
    fromX = resolved.x; fromY = resolved.y; fromNode = resolved.node;
  }
  if (!Number.isFinite(toX) || !Number.isFinite(toY)) {
    const id = optionalString(args.to_id);
    if (!id) throw new Error('Provide to_x/to_y or to_id');
    const resolved = await uiElementCenter(id, 'to_id');
    toX = resolved.x; toY = resolved.y; toNode = resolved.node;
  }
  if (typeof adapter.dragDrop === 'function') {
    const result = await adapter.dragDrop({ ...args, from_x: fromX, from_y: fromY, to_x: toX, to_y: toY });
    if (!fromNode && !toNode) return result;
    return jsonResult({ from: [fromX, fromY], to: [toX, toY], from_element: fromNode?.id || null, to_element: toNode?.id || null });
  }
  await pointer({ action: 'move', x: fromX, y: fromY, button: args.button });
  await pointer({ action: 'down', x: fromX, y: fromY, button: args.button });
  await sleep(clamp(args.hold_ms, 120, 0, 5000));
  await pointer({ action: 'move', x: toX, y: toY, button: args.button });
  await sleep(clamp(args.duration_ms, 120, 0, 5000));
  await pointer({ action: 'up', x: toX, y: toY, button: args.button });
  return jsonResult({ from: [fromX, fromY], to: [toX, toY], from_element: fromNode?.id || null, to_element: toNode?.id || null });
}

export async function launchApp(args = {}) {
  const app = optionalString(args.app || args.path);
  if (!app) throw new Error('app is required');
  const argv = Array.isArray(args.args) ? args.args.map(String) : [];
  const cwd = args.cwd != null ? await resolveSafePath(args.cwd, 'cwd') : null;
  const policy = assertAllowedCommand([app, ...argv].join(' '));
  const result = await adapter.launchApp(app, argv, { ...args, cwd });
  const body = result?.content?.[0]?.text || (typeof result === 'string' ? result : `Launched ${app}.`);

  const waitHint = optionalString(args.wait_for_window);
  if (waitHint) {
    const timeoutMs = clamp(args.wait_timeout_ms, 10_000, 100, 120_000);
    const deadline = Date.now() + timeoutMs;
    let match = null;
    do {
      const windows = resultValue(await listWindows({ include_monitor:false }));
      match = Array.isArray(windows) ? windows.find(row =>
        String(row.title || '').toLowerCase().includes(waitHint.toLowerCase())
        || String(row.app || '').toLowerCase().includes(waitHint.toLowerCase())
      ) : null;
      if (match) break;
      await sleep(100);
    } while (Date.now() < deadline);
    if (!match) throw new Error(`Application launched but no window matching "${waitHint}" appeared within ${timeoutMs} ms`);
    return text(`${policy.note ? `${policy.note}\n` : ''}${body}\nWindow ready: ${match.title || match.app || match.id}`);
  }
  return text(`${policy.note ? `${policy.note}\n` : ''}${body}`);
}

export async function openPath(args = {}) {
  const target = await resolveSafePath(args.path, 'path');
  await adapter.openPath(target);
  return text(`Opened ${target}.`);
}

export async function revealPath(args = {}) {
  const target = await resolveSafePath(args.path, 'path');
  await adapter.revealPath(target);
  return text(`Revealed ${target}.`);
}

function screenshotImagePart(screenshotResult) {
  return screenshotResult?.content?.find(part => part.type === 'image' && typeof part.data === 'string') || null;
}

async function ocrScreenshotResult(screenshotResult, args = {}) {
  const imagePart = screenshotImagePart(screenshotResult);
  if (!imagePart) return { available:false, reason:'no screenshot image is available for OCR' };
  return ocrImage(Buffer.from(imagePart.data, 'base64'), {
    language:args.ocr_language,
    max_words:args.ocr_max_words,
    psm:args.ocr_psm,
    timeout_ms:args.ocr_timeout_ms,
  });
}

function pngDimensions(imagePart) {
  if (!imagePart || imagePart.mimeType !== 'image/png') return null;
  let buffer;
  try { buffer = Buffer.from(imagePart.data, 'base64'); } catch { return null; }
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function virtualDesktopBounds(displays) {
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

async function clickOcrText(args = {}) {
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

function browserTitleHint(activeWindow) {
  const title = optionalString(activeWindow?.title);
  if (!title) return null;
  const stripped = title.replace(/\s+[-—]\s+(Google Chrome|Chromium|Microsoft Edge|Brave)(?:\s+Browser)?$/i, '').trim();
  return stripped || null;
}

function hasExplicitComputerScreenshotTarget(args = {}) {
  return (Array.isArray(args.screenshot_region) && args.screenshot_region.length === 4)
    || Boolean(args.screenshot_window_id)
    || args.screenshot_monitor != null
    || args.screenshot_monitor_index != null;
}

function activeWindowCaptureBounds(window) {
  if (!window) return null;
  const x = Number(window.x), y = Number(window.y), width = Number(window.width), height = Number(window.height);
  if (![x,y,width,height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x:Math.round(x), y:Math.round(y), width:Math.round(width), height:Math.round(height) };
}

function computerScreenshotTask(args = {}) {
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

function browserComputerAction(args, action) {
  const mapped = {
    click:'click',
    invoke:'click',
    toggle:'click',
    focus:'focus',
    set_value:'set_value',
    select:'select',
    type:'type',
    scroll:'scroll',
  }[action];
  if (!mapped) throw new Error(`Browser target does not support computer_action action: ${action}`);
  const visibleText = optionalString(args.browser_text)
    || optionalString(args.name)
    || ((['click','invoke','toggle','focus'].includes(action) && optionalString(args.text)) ? optionalString(args.text) : null);
  return browserAction({
    endpoint: args.endpoint,
    target_id: args.target_id,
    title: args.title,
    url_contains: args.url_contains,
    timeout_ms: args.timeout_ms,
    action: mapped,
    selector: args.selector,
    ...(visibleText ? { browser_text: visibleText } : {}),
    ...(args.value != null ? { value: args.value } : {}),
    ...(args.option != null ? { option: args.option } : {}),
    ...(action === 'type' && args.text != null ? { text: args.text, clear:args.clear === true } : {}),
    ...(action === 'scroll' ? {
      delta_x:args.delta_x,
      delta_y:args.delta_y,
      delta:args.delta,
      direction:args.direction,
      wheel_times:args.wheel_times,
    } : {}),
  });
}

export async function computerAction(args = {}) {
  const legacy = ['ui','pointer','window','type','keyboard','scroll','drag','clipboard','launch_app','open_path','reveal_path','notification'];
  const universal = [
    'click','double_click','right_click','move','down','up','invoke','focus','set_value','select','toggle',
    'expand','collapse','scroll_into_view','set_range_value','add_to_selection','remove_from_selection',
    'minimize','maximize','restore','move_resize','resize','close','wait','batch','multi_select','multi_edit',
  ];
  const action = requireEnum(args.action, 'action', [...legacy, ...universal]);
  const explicitTarget = optionalString(args.target || args.target_type);
  const target = explicitTarget ? requireEnum(explicitTarget, 'target', ['auto','ui','ui_element','browser','ocr','coordinates','window']) : 'auto';
  const nested = { ...args, action: args.operation || args.subaction };
  const hasUi = Boolean(args.label != null || args.id || args.name || args.role || args.automation_id || args.automationId);
  const hasBrowser = Boolean(args.selector || args.browser_text || args.name);
  const ocrNeedle = optionalString(args.ocr_text || args.name || args.browser_text);
  const hasOcr = Boolean(ocrNeedle);
  const hasCoordinates = Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y));
  const automatic = target === 'auto';

  if (action === 'batch') {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    if (!steps.length) throw new Error('computer_action batch requires a non-empty steps array');
    if (steps.length > 50) throw new Error('computer_action batch supports at most 50 steps');
    const stopOnError = args.stop_on_error !== false;
    const results = [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`batch step ${index} must be an object`);
      if (step.action === 'batch') throw new Error('nested computer_action batches are not allowed');
      try {
        const result = await computerAction(step);
        results.push({ index, ok:true, action:step.action, result:resultValue(result) ?? result?.content?.[0]?.text ?? null });
      } catch (error) {
        const failure = { index, ok:false, action:step.action || null, error:String(error?.message || error).slice(0, 1000) };
        results.push(failure);
        if (stopOnError) return jsonResult({ action:'batch', ok:false, stopped_at:index, completed:index, results });
      }
    }
    return jsonResult({ action:'batch', ok:results.every(row => row.ok), completed:results.length, results });
  }

  if (action === 'multi_select') {
    const targets = Array.isArray(args.targets) ? args.targets : [];
    if (!targets.length) throw new Error('multi_select requires a non-empty targets array');
    if (targets.length > 100) throw new Error('multi_select supports at most 100 targets');
    const results = [];
    for (let index = 0; index < targets.length; index += 1) {
      const targetSpec = targets[index];
      const operation = index === 0 && args.replace_selection !== false ? 'select' : 'add_to_selection';
      const result = await uiAction({ ...targetSpec, action:operation });
      results.push({ index, action:operation, result:resultValue(result) ?? result?.content?.[0]?.text ?? null });
    }
    return jsonResult({ action:'multi_select', count:results.length, results });
  }

  if (action === 'multi_edit') {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    if (!edits.length) throw new Error('multi_edit requires a non-empty edits array');
    if (edits.length > 100) throw new Error('multi_edit supports at most 100 edits');
    const results = [];
    for (let index = 0; index < edits.length; index += 1) {
      const edit = edits[index];
      if (!edit || typeof edit !== 'object' || edit.text == null) throw new Error(`multi_edit item ${index} requires target fields plus text`);
      const result = await typeText({ ...edit, method:edit.method || 'auto', clear:edit.clear !== false });
      results.push({ index, result:resultValue(result) ?? result?.content?.[0]?.text ?? null });
    }
    return jsonResult({ action:'multi_edit', count:results.length, results });
  }

  if (action === 'wait') {
    const requested = args.wait_ms != null ? Number(args.wait_ms) : Number(args.seconds) * 1000;
    if (!Number.isFinite(requested) || requested < 0) throw new Error('computer_action wait requires wait_ms or seconds');
    const waitMs = Math.min(120_000, Math.round(requested));
    await sleep(waitMs);
    return jsonResult({ action:'wait', waited_ms:waitMs, capped:requested > 120_000 });
  }

  if (action === 'ui') return uiAction(nested);
  if (action === 'pointer') return pointer(nested);
  if (action === 'window') return windowAction(nested);

  const windowTarget = () => ({
    ...args,
    ...(args.window_id ? { id:args.window_id } : {}),
    ...(args.window_title && !args.title ? { title:args.window_title } : {}),
  });

  if (action === 'type') {
    if (target === 'browser') return browserComputerAction(args, 'type');
    if (target === 'ocr' || target === 'coordinates') {
      throw new Error('computer_action type requires a native UI, browser, or window target');
    }
    if (target === 'window') return typeText(windowTarget());
    if (!automatic) return typeText({ ...args, method:args.method || 'accessibility' });

    const failures = [];
    if (hasUi) {
      try { return await typeText({ ...args, method:'accessibility' }); }
      catch (error) { failures.push(`accessibility: ${String(error?.message || error).slice(0, 300)}`); }
    }
    if (hasBrowser) {
      if (await browserCapabilityAvailable(args.endpoint, 300)) {
        try { return await browserComputerAction(args, 'type'); }
        catch (error) { failures.push(`browser DOM: ${String(error?.message || error).slice(0, 300)}`); }
      } else {
        failures.push('browser DOM: no local CDP endpoint is available');
      }
    }
    if (args.window_id || args.pid != null || args.app || args.window_title || args.title) {
      try { return await typeText(windowTarget()); }
      catch (error) { failures.push(`window: ${String(error?.message || error).slice(0, 300)}`); }
    }
    if (failures.length) throw new Error(`computer_action type targeting failed: ${failures.join('; ')}`);
    throw new Error('computer_action type requires a native UI, browser, or window target');
  }

  if (action === 'keyboard') {
    if (target === 'browser' && args.key && !args.shortcut && !Array.isArray(args.keys)) {
      return browserAction({ ...args, action:'press' });
    }
    return keyboard(args);
  }

  if (action === 'scroll') {
    if (target === 'browser') return browserComputerAction(args, 'scroll');
    if (target === 'ocr') throw new Error('computer_action scroll does not support OCR targets; use browser/UI/window/coordinates');

    if (automatic) {
      let uiError = null;
      if (hasUi) {
        try { return await scroll(args); }
        catch (error) { uiError = error; }
      }
      if (hasBrowser) {
        if (await browserCapabilityAvailable(args.endpoint, 300)) return browserComputerAction(args, 'scroll');
        if (uiError) throw new Error(`computer_action scroll targeting failed: accessibility: ${String(uiError?.message || uiError).slice(0, 300)}; browser DOM: no local CDP endpoint is available`);
        throw new Error('computer_action scroll browser target is unavailable because no local CDP endpoint is available');
      }
      if (args.window_id || args.pid != null || args.app || args.window_title || args.title) {
        await windowAction({ ...windowTarget(), action:'focus' });
      }
      return scroll(args);
    }

    if (target === 'window') {
      await windowAction({ ...windowTarget(), action:'focus' });
      return scroll(args);
    }
    return scroll(args);
  }

  if (action === 'drag') {
    if (target === 'browser' || target === 'ocr') {
      throw new Error('computer_action drag currently requires native UI element ids or desktop coordinates; browser/OCR drag is not advertised');
    }
    if (target === 'window') await windowAction({ ...windowTarget(), action:'focus' });
    return dragDrop(args);
  }
  if (action === 'clipboard') return clipboard(nested);
  if (action === 'launch_app') return launchApp(args);
  if (action === 'open_path') return openPath(args);
  if (action === 'reveal_path') return revealPath(args);
  if (action === 'notification') return notification(args);

  const inferredTarget = automatic
    ? (hasUi ? 'ui_element' : hasBrowser ? 'browser' : args.ocr_text ? 'ocr' : hasCoordinates ? 'coordinates' : 'window')
    : target;

  const tryUiThenBrowser = async uiActionName => {
    let uiError = null;
    if (hasUi) {
      try { return await uiAction({ ...args, action:uiActionName }); }
      catch (error) { uiError = error; }
    }
    if (hasBrowser) return browserComputerAction(args, uiActionName);
    if (uiError) throw uiError;
    return null;
  };

  if (['invoke','set_value','select','toggle','expand','collapse','scroll_into_view','set_range_value','add_to_selection','remove_from_selection'].includes(action)) {
    const browserCompatible = ['invoke','set_value','select','toggle'].includes(action);
    if (inferredTarget === 'browser') {
      if (!browserCompatible) throw new Error(`Browser target does not support ${action}; use browser_action or native accessibility`);
      return browserComputerAction(args, action);
    }
    if (inferredTarget === 'ui' || inferredTarget === 'ui_element') {
      if (automatic && browserCompatible) {
        const result = await tryUiThenBrowser(action);
        if (result) return result;
      }
      return uiAction({ ...args, action });
    }
    throw new Error(`${action} requires a UI${browserCompatible ? ' or browser' : ''} target`);
  }

  if (action === 'focus') {
    if (inferredTarget === 'browser') return browserComputerAction(args, 'focus');
    if (inferredTarget === 'ui' || inferredTarget === 'ui_element') {
      if (automatic) {
        const result = await tryUiThenBrowser('focus');
        if (result) return result;
      }
      return uiAction({ ...args, action:'focus' });
    }
    return windowAction({ ...windowTarget(), action:'focus' });
  }

  if (['minimize','maximize','restore','move_resize','resize','close'].includes(action)) {
    return windowAction({ ...args, action });
  }

  if (['click','double_click','right_click','move','down','up'].includes(action)) {
    if (action === 'click' && automatic) {
      const failures = [];
      if (hasUi) {
        try { return await uiAction({ ...args, action:'click' }); }
        catch (error) { failures.push(`accessibility: ${String(error?.message || error).slice(0, 300)}`); }
      }
      if (hasBrowser) {
        if (await browserCapabilityAvailable(args.endpoint, 300)) {
          try { return await browserComputerAction(args, 'click'); }
          catch (error) { failures.push(`browser DOM: ${String(error?.message || error).slice(0, 300)}`); }
        } else {
          failures.push('browser DOM: no local CDP endpoint is available');
        }
      }
      if (hasOcr) {
        try { return await clickOcrText({ ...args, ocr_text:ocrNeedle }); }
        catch (error) { failures.push(`OCR: ${String(error?.message || error).slice(0, 300)}`); }
      }
      if (hasCoordinates) return pointer({ ...args, action:'click' });
      if (failures.length) throw new Error(`computer_action click targeting failed: ${failures.join('; ')}`);
      throw new Error('computer_action click requires a UI/browser/OCR target or x/y coordinates');
    }
    if (inferredTarget === 'browser') {
      if (action !== 'click') throw new Error(`Browser target does not support ${action}; use browser_action or coordinates`);
      return browserComputerAction(args, 'click');
    }
    if (inferredTarget === 'ocr') {
      if (action !== 'click') throw new Error(`OCR target only supports click; ${action} requires a semantic or coordinate target`);
      return clickOcrText({ ...args, ocr_text:ocrNeedle });
    }
    if ((inferredTarget === 'ui' || inferredTarget === 'ui_element') && action === 'click') {
      return uiAction({ ...args, action:'click' });
    }
    return pointer({ ...args, action });
  }
  throw new Error(`Unsupported computer_action action: ${action}`);
}

export const desktopHandlers = {
  computer_snapshot: computerSnapshot,
  computer_action: computerAction,
  list_windows: listWindows,
  window_action: windowAction,
  launch_app: launchApp,
  ui_snapshot: uiSnapshot,
  ui_find: uiFind,
  ui_action: uiAction,
  type_text: typeText,
  keyboard,
  pointer,
  drag_drop: dragDrop,
  scroll,
  wait_for_ui: waitForUi,
  clipboard,
  display_inventory: displayInventory,
  screenshot_region: screenshotRegion,
  open_path: openPath,
  reveal_path: revealPath,
  notification,
};
