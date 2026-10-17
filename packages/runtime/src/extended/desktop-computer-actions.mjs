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


import { clipboard, displayInventory, keyboard, listWindows, notification, pointer, resultValue, screenshotRegion, scroll, sleep, uiAction, uiSnapshot, windowAction } from './desktop-core.mjs';
import { dragDrop, launchApp, openPath, revealPath, typeText, uiFind, waitForUi } from './desktop-ui-actions.mjs';
import { clickOcrText } from './desktop-vision.mjs';
import { computerSnapshot } from './desktop-computer-snapshot.mjs';

export function browserComputerAction(args, action) {
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

export function computerActionWindowTextArgs(args = {}) {
  const {
    id: _id,
    label: _label,
    name: _name,
    role: _role,
    automation_id: _automationId,
    automationId: _automationIdAlias,
    selector: _selector,
    browser_text: _browserText,
    ...windowArgs
  } = args;
  return {
    ...windowArgs,
    ...(args.window_title && !args.title ? { title:args.window_title } : {}),
  };
}

// A UI element ID is scoped to the native accessibility tree. If it becomes
// stale, never reinterpret a remaining name, selector, OCR hint or x/y as a
// different target: refind that element in the same window first.
export function hasPinnedUiElement(args = {}) {
  return Boolean(args.id || args.automation_id || args.automationId);
}

function stalePinnedUiElement() {
  return new Error('Pinned UI element could not be resolved; use ui_snapshot and ui_find to refresh its ID. No browser, OCR, window or coordinate fallback was attempted.');
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
  const pinnedUi = automatic && hasPinnedUiElement(args);

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
  const windowTextTarget = () => computerActionWindowTextArgs(args);

  if (action === 'type') {
    if (target === 'browser') return browserComputerAction(args, 'type');
    if (target === 'ocr' || target === 'coordinates') {
      throw new Error('computer_action type requires a native UI, browser, or window target');
    }
    if (target === 'window') return typeText(windowTextTarget());
    if (!automatic) return typeText({ ...args, method:args.method || 'accessibility' });

    const failures = [];
    if (hasUi) {
      try { return await typeText({ ...args, method:'accessibility' }); }
      catch (error) {
        if (pinnedUi) throw stalePinnedUiElement();
        failures.push(`accessibility: ${String(error?.message || error).slice(0, 300)}`);
      }
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
      try { return await typeText(windowTextTarget()); }
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
        catch (error) {
          if (pinnedUi) throw stalePinnedUiElement();
          uiError = error;
        }
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
      catch (error) {
        if (pinnedUi) throw stalePinnedUiElement();
        uiError = error;
      }
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
        catch (error) {
        if (pinnedUi) throw stalePinnedUiElement();
        failures.push(`accessibility: ${String(error?.message || error).slice(0, 300)}`);
      }
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
