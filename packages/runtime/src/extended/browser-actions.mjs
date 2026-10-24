import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { closeSync, constants as fsConstants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { resolveSafePath } from '../util.mjs';
import { preserveInterruptedBrowserSession } from './browser-session-backup.mjs';
import { clamp, commandExists, jsonResult, optionalString, requireEnum, spawnDetached, unavailable } from './common.mjs';


import { assertBrowserRemoteEnabled, assertSafeEvaluationExpression, endpointUrl } from './browser-endpoint.mjs';
import { callPageFunction, evaluate, withTarget, productionSessionKey } from './browser-session.mjs';
import { rememberBrowserViewport } from './browser-viewport.mjs';
import { browserNavigate, browserSnapshot, browserTabs, findExpression } from './browser-read.mjs';
import { executeBrowserWorkflow, validateBrowserWorkflow } from './browser-workflow.mjs';
import { browserDevtools } from './browser-devtools.mjs';

export async function browserFind(args) {
  if (!(args.selector || args.text || args.role)) throw new Error('browser_find requires selector, text, or role; use browser_snapshot to enumerate page structure');
  return withTarget(args, async (session, target) => {
    const matches = await evaluate(session, findExpression(args));
    return jsonResult({ target_id: target.id, count: Array.isArray(matches) ? matches.length : 0, matches: Array.isArray(matches) ? matches : [] });
  });
}

export const PAGE_SCROLL_ACTION = `function(selector, needle, deltaX, deltaY) {
  let target = selector ? document.querySelector(selector) : null;
  if (!target && needle) {
    const lower = String(needle).toLowerCase();
    target = Array.from(document.querySelectorAll('*')).find(node =>
      String(node.innerText || node.textContent || '').trim().toLowerCase().includes(lower)
    ) || null;
  }
  if ((selector || needle) && !target) throw new Error('Element not found');

  let scroller = document.scrollingElement || document.documentElement;
  if (target) {
    let current = target;
    while (current && current !== document.documentElement) {
      const style = getComputedStyle(current);
      const scrollX = /(auto|scroll|overlay)/.test(String(style.overflowX || '')) && current.scrollWidth > current.clientWidth;
      const scrollY = /(auto|scroll|overlay)/.test(String(style.overflowY || '')) && current.scrollHeight > current.clientHeight;
      if (scrollX || scrollY) {
        scroller = current;
        break;
      }
      current = current.parentElement;
    }
  }

  const beforeX = Number(scroller.scrollLeft || 0);
  const beforeY = Number(scroller.scrollTop || 0);
  scroller.scrollLeft = beforeX + Number(deltaX || 0);
  scroller.scrollTop = beforeY + Number(deltaY || 0);
  return {
    target: target ? target.tagName.toLowerCase() : 'page',
    scroller: scroller === document.scrollingElement || scroller === document.documentElement ? 'page' : scroller.tagName.toLowerCase(),
    before_x: beforeX,
    before_y: beforeY,
    after_x: Number(scroller.scrollLeft || 0),
    after_y: Number(scroller.scrollTop || 0),
    delta_x: Number(deltaX || 0),
    delta_y: Number(deltaY || 0),
  };
}`;

export const PAGE_ELEMENT_ACTION = `function(selector, needle, action, value) {
  let el = selector ? document.querySelector(selector) : null;
  if (!el && needle) {
    const lower = String(needle).toLowerCase();
    el = Array.from(document.querySelectorAll('*')).find(node =>
      String(node.innerText || node.textContent || '').trim().toLowerCase().includes(lower)
    ) || null;
  }
  if (!el) throw new Error('Element not found');
  if (action === 'click' || action === 'type' || action === 'scroll_into_view') {
    el.scrollIntoView({block:'center', inline:'center'});
  }
  if (action === 'focus' || action === 'type') el.focus();
  if (action === 'select') {
    el.value = value;
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
  } else if (action === 'set_value') {
    const proto = Object.getPrototypeOf(el);
    const own = Object.getOwnPropertyDescriptor(proto, 'value');
    const parent = Object.getPrototypeOf(proto);
    const inherited = parent ? Object.getOwnPropertyDescriptor(parent, 'value') : null;
    const setter = own?.set || inherited?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
  }
  let b = el.getBoundingClientRect();
  if (action === 'click') {
    // An inline element can span several text fragments. Its bounding box center
    // can point to a completely unrelated input (or even a destructive button).
    // Only return a point whose actual hit target belongs to this element.
    const rectangles = Array.from(el.getClientRects());
    const safe = rectangles.find(rect => {
      if (!rect.width || !rect.height) return false;
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      const target = document.elementFromPoint(x, y);
      return target && (target === el || el.contains(target));
    });
    if (!safe) throw new Error('Element has no unobstructed clickable fragment');
    b = safe;
  }
  return {
    tag: el.tagName.toLowerCase(),
    // Never expose password or credential field contents in tool responses.
    value: 'value' in el && !el.matches('input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[autocomplete="one-time-code"]') ?
      String(el.value) : '',
    x: b.x, y: b.y, width: b.width, height: b.height,
  };
}`;

// Bounded form mutation: validate every target before changing any field.
// Values are intentionally excluded from the return object and tool logs.
export const PAGE_FILL_FORM = `function(fields) {
  const targets = fields.map(field => {
    const el = document.querySelector(field.selector);
    if (!el || !el.getClientRects().length || el.disabled || el.readOnly ||
        el.matches('input[type="file"],input[type="submit"],input[type="reset"],button')) {
      throw new Error('Form field unavailable or not editable: ' + field.selector);
    }
    const tag = el.tagName.toLowerCase();
    if (!['input','textarea','select'].includes(tag)) throw new Error('Unsupported form field: ' + field.selector);
    if (tag === 'input' && ['checkbox','radio'].includes(el.type) && typeof field.value !== 'boolean') {
      throw new Error('Checkbox and radio fields require a boolean value: ' + field.selector);
    }
    if (tag === 'select' && !Array.from(el.options).some(option => option.value === String(field.value))) {
      throw new Error('No matching select option: ' + field.selector);
    }
    return {el,tag,value:field.value};
  });
  const summary = [];
  for (const {el,tag,value} of targets) {
    const checkbox = tag === 'input' && ['checkbox','radio'].includes(el.type);
    const prop = checkbox ? 'checked' : 'value';
    let prototype = Object.getPrototypeOf(el);
    let setter;
    while (prototype && !setter) {
      setter = Object.getOwnPropertyDescriptor(prototype, prop)?.set;
      prototype = Object.getPrototypeOf(prototype);
    }
    const next = checkbox ? Boolean(value) : String(value);
    if (setter) setter.call(el, next); else el[prop] = next;
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
    summary.push({tag, changed:true});
  }
  return {filled:summary.length, fields:summary};
}`;

export function validateFormFields(fields) {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 20) {
    throw new Error('fill_form requires 1 to 20 fields');
  }
  return fields.map(field => {
    const selector = typeof field?.selector === 'string' ? field.selector.trim() : '';
    if (!selector || selector.length > 512 || !Object.hasOwn(field,'value') ||
        !['string','boolean','number'].includes(typeof field.value) ||
        (typeof field.value === 'number' && !Number.isFinite(field.value))) {
      throw new Error('Each form field requires a CSS selector and a string/boolean/number value');
    }
    if (String(field.value).length > 16384) throw new Error('Form field value exceeds 16384 characters');
    return {selector, value:field.value};
  });
}

export function browserActionLocatorText(args = {}, action = '') {
  const explicit = optionalString(args.browser_text || args.match_text);
  if (explicit) return explicit;
  if (action === 'type') {
    // Legacy type calls used text as the locator and value/text_value as the payload.
    if (!optionalString(args.selector) && (args.value != null || args.text_value != null)) return optionalString(args.text);
    return null;
  }
  return optionalString(args.text);
}

export function browserActionInputValue(args = {}, action = '') {
  if (action === 'type') {
    if (!optionalString(args.selector) && !optionalString(args.browser_text || args.match_text) && (args.value != null || args.text_value != null)) {
      return String(args.text_value ?? args.value ?? '');
    }
    return String(args.text ?? args.text_value ?? args.value ?? '');
  }
  return String(args.value ?? args.text_value ?? args.text ?? '');
}

export function browserScrollDeltas(args = {}) {
  const direction = optionalString(args.direction);
  const hasDelta = [args.delta_x,args.delta_y,args.delta].some(value => value != null && Number.isFinite(Number(value)));
  if (!direction && !hasDelta) return null;
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
  return { delta_x:deltaX, delta_y:deltaY };
}

export async function browserAction(args) {
  const action = requireEnum(args.action, 'action', ['click', 'focus', 'type', 'set_value', 'select', 'scroll', 'scroll_into_view', 'upload', 'press', 'set_viewport', 'fill_form', 'workflow']);
  const formFields = action === 'fill_form' ? validateFormFields(args.fields) : null;
  const workflowSteps = action === 'workflow' ?
    validateBrowserWorkflow(args.steps, {validateFormFields}) : null;
  return withTarget(args, async (session, target) => {
    if (action === 'workflow') {
      const result = await executeBrowserWorkflow(session, workflowSteps, {
        pageElementAction:PAGE_ELEMENT_ACTION, pageFillForm:PAGE_FILL_FORM,
      });
      return jsonResult({target_id:target.id, action, result});
    }
    if (action === 'fill_form') {
      const result = await callPageFunction(session, PAGE_FILL_FORM, [formFields]);
      return jsonResult({target_id:target.id, action, result});
    }
    if (action === 'set_viewport') {
      const width = clamp(args.width, 1280, 200, 8192);
      const height = clamp(args.height, 720, 200, 8192);
      const deviceScaleFactor = Math.max(0.1, Math.min(8, Number(args.device_scale_factor) || 1));
      const metrics = { width, height, deviceScaleFactor, mobile:Boolean(args.mobile), screenWidth:width, screenHeight:height };
      await session.send('Emulation.setDeviceMetricsOverride', metrics);
      rememberBrowserViewport(productionSessionKey(endpointUrl(args.endpoint), target), metrics);
      return jsonResult({ target_id:target.id, action, width, height, device_scale_factor:deviceScaleFactor, mobile:Boolean(args.mobile) });
    }
    if (action === 'upload') {
      const selector = optionalString(args.selector);
      if (!selector) throw new Error('selector is required for upload');
      const requested = (Array.isArray(args.paths) ? args.paths : [args.path]).filter(Boolean);
      if (!requested.length) throw new Error('path or paths is required for upload');
      const files = [];
      for (const value of requested) files.push(await resolveSafePath(value, 'path'));
      await session.send('DOM.enable');
      const doc = await session.send('DOM.getDocument', { depth: 1 });
      const found = await session.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
      if (!found.nodeId) throw new Error(`No element matches selector ${selector}`);
      await session.send('DOM.setFileInputFiles', { nodeId: found.nodeId, files });
      return jsonResult({ target_id: target.id, action, selector, files: files.length });
    }
    if (action === 'press') {
      const key = optionalString(args.key);
      if (!key) throw new Error('key is required for press');
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key });
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
      return jsonResult({ target_id: target.id, action, key });
    }
    const selector = optionalString(args.selector);
    const needle = browserActionLocatorText(args, action);
    const value = browserActionInputValue(args, action);
    const option = String(args.option ?? value);

    if (action === 'scroll') {
      const deltas = browserScrollDeltas(args);
      if (!deltas) throw new Error('browser_action scroll requires direction or a delta');
      return jsonResult({
        target_id: target.id,
        action,
        result: await callPageFunction(session, PAGE_SCROLL_ACTION, [selector, needle, deltas.delta_x, deltas.delta_y]),
      });
    }

    if (!selector && !needle) throw new Error('selector or browser_text/text locator is required');

    if (action === 'click') {
      const rect = await callPageFunction(session, PAGE_ELEMENT_ACTION, [selector, needle, 'click', '']);
      const x = Number(rect.x) + Number(rect.width) / 2;
      const y = Number(rect.y) + Number(rect.height) / 2;
      await session.send('Input.dispatchMouseEvent', { type:'mouseMoved', x, y, button:'none' });
      await session.send('Input.dispatchMouseEvent', { type:'mousePressed', x, y, button:'left', clickCount:1 });
      await session.send('Input.dispatchMouseEvent', { type:'mouseReleased', x, y, button:'left', clickCount:1 });
      return jsonResult({ target_id:target.id, action, result:{ ...rect, x, y } });
    }

    if (action === 'type') {
      const focused = await callPageFunction(session, PAGE_ELEMENT_ACTION, [selector, needle, 'type', '']);
      if (args.clear === true) await callPageFunction(session, PAGE_ELEMENT_ACTION, [selector, needle, 'set_value', '']);
      await session.send('Input.insertText', { text:value });
      const current = await callPageFunction(session, PAGE_ELEMENT_ACTION, [selector, needle, 'read_value', '']);
      return jsonResult({ target_id:target.id, action, result:{ ...focused, value:current.value } });
    }

    const pageValue = action === 'select' ? option : value;
    return jsonResult({
      target_id: target.id,
      action,
      result: await callPageFunction(session, PAGE_ELEMENT_ACTION, [selector, needle, action, pageValue]),
    });
  });
}

export async function browserWait(args = {}) {
  const condition = requireEnum(args.condition || 'selector', 'condition', ['selector', 'text', 'url_contains', 'expression', 'load', 'navigation', 'network_idle']);
  const timeoutMs = clamp(args.timeout_ms, 10_000, 100, 120_000);
  const pollMs = clamp(args.poll_ms, 200, 50, 5000);
  const idleMs = clamp(args.idle_ms, 500, 100, 10_000);
  const wanted = optionalString(args.selector || args.text || args.value || args.expression);
  if (['selector','text','url_contains','expression'].includes(condition) && !wanted) throw new Error('selector/text/value/expression is required for this condition');
  if (condition === 'expression') await assertSafeEvaluationExpression(wanted);
  return withTarget(args, async (session, target) => {
    const started = Date.now();
    const initialUrl = await evaluate(session, 'location.href').catch(() => target.url || '');
    const inflight = new Set();
    let lastResourceCount = -1;
    let stableSince = Date.now();
    const unsubscribers = [];
    if (condition === 'network_idle') {
      await session.send('Network.enable');
      const markBusy = params => {
        if (params?.requestId) inflight.add(params.requestId);
        stableSince = Date.now();
      };
      const markDone = params => {
        if (params?.requestId) inflight.delete(params.requestId);
        stableSince = Date.now();
      };
      unsubscribers.push(
        session.observe('Network.requestWillBeSent', markBusy),
        session.observe('Network.loadingFinished', markDone),
        session.observe('Network.loadingFailed', markDone),
      );
    }
    try {
      while (Date.now() - started < timeoutMs) {
        let matched = false;
        if (condition === 'network_idle') {
          const state = await evaluate(session, `({ready:document.readyState,resources:performance.getEntriesByType('resource').length})`).catch(() => null);
          if (state) {
            if (state.resources !== lastResourceCount) {
              lastResourceCount = state.resources;
              stableSince = Date.now();
            }
            matched = state.ready === 'complete' && inflight.size === 0 && Date.now() - stableSince >= idleMs;
          }
        } else {
          const expression = condition === 'selector' ? `Boolean(document.querySelector(${JSON.stringify(wanted)}))`
            : condition === 'text' ? `(document.body?.innerText||'').toLowerCase().includes(${JSON.stringify(wanted?.toLowerCase())})`
            : condition === 'url_contains' ? `location.href.includes(${JSON.stringify(wanted)})`
            : condition === 'load' ? `document.readyState === 'complete'`
            : condition === 'navigation' ? `location.href !== ${JSON.stringify(initialUrl)}`
            : `Boolean(${wanted})`;
          matched = Boolean(await evaluate(session, expression));
        }
        if (matched) return jsonResult({
          target_id: target.id,
          condition,
          matched: true,
          elapsed_ms: Date.now() - started,
          ...(condition === 'network_idle' ? { inflight: inflight.size, idle_ms: idleMs } : {}),
          url: await evaluate(session, 'location.href').catch(() => target.url || null),
        });
        await new Promise(resolve => setTimeout(resolve, pollMs));
      }
      return jsonResult({
        target_id: target.id,
        condition,
        matched: false,
        elapsed_ms: Date.now() - started,
        ...(condition === 'network_idle' ? { inflight: inflight.size, idle_ms: idleMs } : {}),
        url: await evaluate(session, 'location.href').catch(() => target.url || null),
      });
    } finally {
      for (const unsubscribe of unsubscribers) unsubscribe();
    }
  });
}

export async function browserEvaluate(args) {
  assertBrowserRemoteEnabled();
  const expression = await assertSafeEvaluationExpression(args.expression);
  return withTarget(args, async (session, target) => jsonResult({ target_id: target.id, value: await evaluate(session, expression, args.await_promise !== false) }));
}

export const browserHandlers = {
  browser_tabs: browserTabs,
  browser_navigate: browserNavigate,
  browser_snapshot: browserSnapshot,
  browser_find: browserFind,
  browser_action: browserAction,
  browser_wait: browserWait,
  browser_evaluate: browserEvaluate,
  browser_devtools: browserDevtools,
};
