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


import { adapter, cachedUiNodes, clipboard, keyboard, invalidateUiSnapshotCache, listWindows, pointer, resultValue, sleep, uiAction, uiSnapshot, windowAction, withResolvedUiLabel } from './desktop-core.mjs';

export function matches(node, args) {
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

export async function uiMatches(args = {}) {
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

export function uiFingerprint(nodes) {
  return JSON.stringify((nodes || []).map(node => ({
    id: node.id ?? null,
    role: node.role ?? null,
    name: node.name ?? null,
    value: node.value ?? null,
    x: Number(node.x || 0), y: Number(node.y || 0),
    width: Number(node.width || 0), height: Number(node.height || 0),
  })));
}

export function uiTextContains(node, needle) {
  if (!needle) return true;
  const normalized = String(needle).toLowerCase();
  return [
    node.name, node.value, node.description, node.help_text, node.helpText,
    node.role, node.window, node.window_title, node.automationId,
  ].some(value => String(value || '').toLowerCase().includes(normalized));
}

export async function uiConditionMatches(args, condition) {
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
      invalidateUiSnapshotCache();
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

  invalidateUiSnapshotCache();
  const baseline = state === 'changed' ? await uiMatches(args) : [];
  const baselineFingerprint = state === 'changed' ? uiFingerprint(baseline) : null;
  let nodes = baseline;
  do {
    attempts += 1;
    invalidateUiSnapshotCache();
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

export function explicitTypeTextWindowTarget(args = {}, hasElementSelector = false) {
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

export async function uiElementCenter(id, field) {
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
