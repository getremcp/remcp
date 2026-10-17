import { snapshotDelta } from './browser-snapshot-diff.mjs';
import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { closeSync, constants as fsConstants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { resolveSafePath } from '../util.mjs';
import { preserveInterruptedBrowserSession } from './browser-session-backup.mjs';
import { clamp, commandExists, jsonResult, optionalString, requireEnum, spawnDetached, unavailable } from './common.mjs';


import { assertResolvedBrowserUrl, assertResolvedPageUrl, boundedText, endpointUrl, ensureBrowserEndpoint, listBrowserTargets, requestJson } from './browser-endpoint.mjs';
import { createGuardedNewTab, evaluate, withTarget } from './browser-session.mjs';

export async function browserTabs(args = {}) {
  const targets = await listBrowserTargets(args.endpoint);
  const pages = targets.filter(item => item.type === 'page').slice(0, 500).map(item => ({
    id: boundedText(item.id, 256),
    title: boundedText(item.title, 1000),
    url: boundedText(item.url, 4096),
    description: boundedText(item.description, 1000),
  }));
  const result = jsonResult(pages);
  // Keep the typed empty-array contract while providing a native fallback hint.
  if (!pages.length) {
    result.content = [{ type: 'text', text: 'CDP is connected, but no debuggable Chromium tabs are available. Use ui_snapshot and ui_find to inspect existing browser windows without CDP; only open a new tab when explicitly requested.' }];
  }
  return result;
}

export async function waitForHistoryReady(session, expectedUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const state = await evaluate(session, '({url:location.href,ready:document.readyState})').catch(() => null);
    if (state?.ready === 'complete' && (!expectedUrl || state.url === expectedUrl)) return true;
    await new Promise(resolve => setTimeout(resolve, 75));
  } while (Date.now() < deadline);
  return false;
}

export async function browserNavigate(args = {}) {
  const requestedUrl = optionalString(args.url);
  const action = requireEnum(args.action || (requestedUrl ? 'url' : 'reload'), 'action', ['url','new_tab','back','forward','reload']);
  const url = ['url','new_tab'].includes(action) ? await assertResolvedBrowserUrl(requestedUrl, 'url') : null;
  if (['url','new_tab'].includes(action) && !url) throw new Error('url is required when action=url or new_tab');
  if (action === 'new_tab') {
    if (process.env.NODE_ENV === 'production') {
      const opened = await createGuardedNewTab(url, args);
      return jsonResult({
        target_id: opened.target.id,
        action,
        url: opened.finalUrl,
        title: opened.target.title || '',
        error_text: opened.navigation?.errorText || null,
      });
    }
    await ensureBrowserEndpoint(args.endpoint);
    const created = await requestJson(`/json/new?${encodeURIComponent(url)}`, args.endpoint, { method:'PUT', timeout_ms:args.timeout_ms });
    return jsonResult({
      target_id:created?.id || null,
      action,
      url:created?.url ? await assertResolvedPageUrl(created.url) : url,
      title:created?.title || '',
    });
  }
  return withTarget(args, async (session, target) => {
    await session.send('Page.enable');
    const timeoutMs = clamp(args.timeout_ms, 15_000, 500, 120_000);
    const loaded = args.wait === false || ['back','forward'].includes(action)
      ? null
      : session.waitFor('Page.loadEventFired', timeoutMs).catch(() => null);
    let frameId = null;
    let errorText = null;
    let historyUrl = null;
    if (action === 'url') {
      const result = await session.send('Page.navigate', { url });
      frameId = result.frameId || null;
      errorText = result.errorText || null;
    } else if (action === 'reload') {
      await session.send('Page.reload', { ignoreCache: Boolean(args.ignore_cache) });
    } else {
      const history = await session.send('Page.getNavigationHistory');
      const current = Number(history.currentIndex || 0);
      const nextIndex = action === 'back' ? current - 1 : current + 1;
      const entry = Array.isArray(history.entries) ? history.entries[nextIndex] : null;
      if (!entry) throw new Error(`Cannot navigate ${action}: no history entry is available`);
      historyUrl = entry.url ? await assertResolvedPageUrl(entry.url, 'history URL') : null;
      await session.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    }
    if (loaded) await loaded;
    if (args.wait !== false && ['back','forward'].includes(action)) {
      await waitForHistoryReady(session, historyUrl, timeoutMs);
    }
    const currentUrl = await evaluate(session, 'location.href').catch(() => url || target.url || null);
    if (currentUrl) await assertResolvedPageUrl(currentUrl);
    return jsonResult({ target_id: target.id, action, url: currentUrl, frame_id: frameId, error_text: errorText });
  });
}

export async function browserSnapshot(args) {
  return withTarget(args, async (session, target) => {
    await session.send('Accessibility.enable');
    const { nodes = [] } = await session.send('Accessibility.getFullAXTree');
    const limit = clamp(args.max_nodes, 1500, 1, 10_000);
    const simplified = nodes.slice(0, limit).map(node => ({
      node_id: boundedText(node.nodeId, 256),
      ignored: Boolean(node.ignored),
      role: boundedText(node.role?.value, 256),
      name: boundedText(node.name?.value, 1000),
      value: boundedText(node.value?.value, 1000),
      description: boundedText(node.description?.value, 1000),
      child_ids: Array.isArray(node.childIds) ? node.childIds.slice(0, 200).map(id => boundedText(id, 256)) : [],
      backend_dom_node_id: node.backendDOMNodeId || null,
    }));
    const delta = snapshotDelta(simplified,target,limit,{
      from:args.diff_from,
      endpoint:endpointUrl(args.endpoint).origin,
    });
    const payload = {
      target_id: target.id,
      title: target.title,
      url: target.url,
      count: simplified.length,
      truncated: nodes.length > limit,
      ...delta,
    };
    if (!args.include_screenshot) return jsonResult(payload);

    await session.send('Page.enable');
    const selector = optionalString(args.selector);
    let restoreScroll = null;
    if (selector) {
      const bounds = await evaluate(session, `new Promise((resolve,reject) => {
        const el=document.querySelector(${JSON.stringify(selector)});
        if(!el){reject(new Error('Screenshot element not found'));return;}
        const originalScrollX=scrollX, originalScrollY=scrollY;
        const initial=el.getBoundingClientRect();
        const desiredTop=Math.max(0, scrollY + initial.top - Math.max(0,(innerHeight-initial.height)/2));
        window.scrollTo({top:desiredTop,left:scrollX,behavior:'instant'});
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const r=el.getBoundingClientRect();
          resolve({
            x:r.x,
            y:r.y,
            width:r.width,
            height:r.height,
            viewport_width:innerWidth,
            viewport_height:innerHeight,
            scroll_x:scrollX,
            scroll_y:scrollY,
            original_scroll_x:originalScrollX,
            original_scroll_y:originalScrollY,
            fully_visible:r.x>=0 && r.y>=0 && r.right<=innerWidth && r.bottom<=innerHeight
          });
        }));
      })`);
      if (!bounds || !Number.isFinite(Number(bounds.width)) || !Number.isFinite(Number(bounds.height)) || bounds.width <= 0 || bounds.height <= 0) {
        throw new Error('Screenshot element has invalid bounds');
      }
      restoreScroll = { x:Number(bounds.original_scroll_x || 0), y:Number(bounds.original_scroll_y || 0) };
      const { original_scroll_x: _originalX, original_scroll_y: _originalY, ...reportedBounds } = bounds;
      payload.screenshot_target = { selector, ...reportedBounds };
    }
    payload.screenshot = {
      scope: 'viewport',
      width: await evaluate(session, 'innerWidth').catch(() => null),
      height: await evaluate(session, 'innerHeight').catch(() => null),
    };
    const result = jsonResult(payload);
    let captured;
    try {
      captured = await session.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      });
    } finally {
      if (restoreScroll) {
        await evaluate(session, `window.scrollTo({left:${restoreScroll.x},top:${restoreScroll.y},behavior:'instant'})`).catch(() => {});
      }
    }
    const data = String(captured?.data || '');
    if (!data) throw new Error('CDP returned no screenshot data');
    if (Buffer.byteLength(data, 'base64') > 8 * 1024 * 1024) throw new Error('Browser screenshot exceeds the 8 MiB inline image limit');
    result.content.push({ type:'image', data, mimeType:'image/png' });
    return result;
  });
}

export function findExpression(args) {
  const selector = optionalString(args.selector);
  const needle = optionalString(args.text);
  const role = optionalString(args.role);
  const limit = clamp(args.limit, 20, 1, 200);
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const needle = ${JSON.stringify(needle)};
    const role = ${JSON.stringify(role)};
    const source = selector ? Array.from(document.querySelectorAll(selector)) : Array.from(document.querySelectorAll('*'));
    function cssPath(el) {
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      while (el && el.nodeType === 1 && el !== document.documentElement) {
        let part = el.tagName.toLowerCase();
        if (el.parentElement) {
          const same = Array.from(el.parentElement.children).filter(x => x.tagName === el.tagName);
          if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
        }
        parts.unshift(part); el = el.parentElement;
      }
      return parts.join(' > ');
    }
    function semanticRole(el) {
      const explicit = (el.getAttribute('role') || '').trim().toLowerCase();
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'button') return 'button';
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      if (tag === 'option') return 'option';
      if (tag === 'img') return 'img';
      if (tag === 'progress') return 'progressbar';
      if (tag === 'meter') return 'meter';
      if (tag === 'summary') return 'button';
      if (tag === 'input') {
        const type = String(el.type || 'text').toLowerCase();
        if (['button','submit','reset','image'].includes(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        if (!['hidden','file','color'].includes(type)) return 'textbox';
      }
      return '';
    }
    function visibleText(el) {
      return (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
    }
    function textQuality(value) {
      if (!needle) return 0;
      const hay = value.toLowerCase();
      const wanted = needle.toLowerCase();
      if (hay === wanted) return 0;
      if (hay.startsWith(wanted)) return 1;
      return 2;
    }
    function depthOf(el) {
      let depth = 0;
      for (let current = el.parentElement; current; current = current.parentElement) depth += 1;
      return depth;
    }
    const candidates = source.filter(el => {
      const style = getComputedStyle(el);
      const visible = style.visibility !== 'hidden' && style.display !== 'none' && el.getClientRects().length > 0;
      const hay = visibleText(el);
      const r = semanticRole(el);
      return visible && (!needle || hay.toLowerCase().includes(needle.toLowerCase())) && (!role || r === role.toLowerCase());
    }).map((el, index) => ({
      el,
      index,
      text: visibleText(el),
      role: semanticRole(el),
      depth: depthOf(el),
    }));
    let selected = candidates;
    if (needle && !selector) {
      selected = [...candidates].sort((a, b) =>
        textQuality(a.text) - textQuality(b.text)
        || Number(!a.role) - Number(!b.role)
        || a.text.length - b.text.length
        || b.depth - a.depth
        || a.index - b.index
      );
      const deduped = [];
      for (const candidate of selected) {
        if (deduped.some(existing => existing.el.contains(candidate.el) || candidate.el.contains(existing.el))) continue;
        deduped.push(candidate);
        if (deduped.length >= ${limit}) break;
      }
      selected = deduped;
    } else {
      selected = selected.slice(0, ${limit});
    }
    return selected.map(({ el }) => {
      const b = el.getBoundingClientRect();
      return { selector: cssPath(el), tag: el.tagName.toLowerCase(), role: semanticRole(el), name: el.getAttribute('aria-label') || el.getAttribute('name') || '', text: visibleText(el).slice(0, 500), value: 'value' in el ? String(el.value).slice(0, 500) : '', x: b.x, y: b.y, width: b.width, height: b.height, disabled: Boolean(el.disabled) };
    });
  })()`;
}
