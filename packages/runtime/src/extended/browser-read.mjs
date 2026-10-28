import { snapshotDelta } from './browser-snapshot-diff.mjs';
import { requireSuccessfulBrowserNavigation } from './browser-navigation-result.mjs';
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
  const targetId = optionalString(args.target_id || args.targetId);
  const titleContains = optionalString(args.title);
  const urlContains = optionalString(args.url_contains || args.urlContains);
  const targets = await listBrowserTargets(args.endpoint, {
    targetId, titleContains, urlContains, readOnlySingleFlight:true,
  });
  const pages = targets.filter(item => item.type === 'page').slice(0, 500).map(item => ({
    id: boundedText(item.id, 256),
    title: boundedText(item.title, 1000),
    url: boundedText(item.url, 4096),
    description: boundedText(item.description, 1000),
  }));
  const result = jsonResult(pages);
  // Keep the typed empty-array contract while providing a native fallback hint.
  if (!pages.length) {
    const scoped = Boolean(targetId || titleContains || urlContains);
    result.content = [{ type: 'text', text: scoped
      ? 'CDP is connected, but no authorized browser page matches the requested selector. Check the selector or use ui_snapshot and ui_find for native browser accessibility.'
      : 'CDP is connected, but no debuggable Chromium tabs are available. Use ui_snapshot and ui_find to inspect existing browser windows without CDP; only open a new tab when explicitly requested.' }];
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
    const loadWait = new AbortController();
    const loaded = args.wait === false || ['back','forward'].includes(action)
      ? null
      : session.waitFor('Page.loadEventFired', timeoutMs, loadWait.signal).catch(() => null);
    try {
      let frameId = null;
      let errorText = null;
      let historyUrl = null;
      if (action === 'url') {
        const result = await session.send('Page.navigate', { url });
        requireSuccessfulBrowserNavigation(result);
        // Same-document navigation (fragment or pushState) has no loaderId
        // and does not emit Page.loadEventFired.
        if (!result.loaderId) loadWait.abort();
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
    } finally {
      loadWait.abort();
    }
  });
}

// CDP accessibility can include an input's current value even when it is
// masked on screen. The protected AX property must be checked before the
// node is mirrored to structuredContent or snapshot diff state.
export function safeAccessibilityValue(node) {
  const props = Array.isArray(node?.properties) ? node.properties : [];
  const protectedControl = props.some(item => item?.name === 'protected'
    && (item?.value?.value === true || String(item?.value?.value) === 'true'));
  const role = String(node?.role?.value || '').toLowerCase();
  if (protectedControl || role === 'password' || role === 'passwordtext') return '';
  return boundedText(node?.value?.value, 1000);
}

// Chromium's AX tree can repeat editable input values in descendant
// StaticText/InlineTextBox names. Blank the complete editable subtree before
// storing a snapshot diff or sending structured content to the MCP host.
export function sensitiveAccessibilityDescendants(nodes) {
  const indexed = new Map(nodes.map(node => [node.nodeId, node]));
  const secret = new Set();
  const queue = [];
  for (const node of nodes) {
    const role = String(node.role?.value || '').toLowerCase();
    const properties = Array.isArray(node.properties) ? node.properties : [];
    const editable = properties.some(item => item?.name === 'editable'
      && ![false,'false',null].includes(item?.value?.value));
    const protectedNode = properties.some(item => item?.name === 'protected'
      && [true,'true'].includes(item?.value?.value));
    if (['textbox','searchbox','combobox','password','passwordtext','spinbutton'].includes(role)
      || editable || protectedNode) {
      secret.add(node.nodeId);
      for (const id of node.childIds || []) queue.push(id);
    }
  }
  while (queue.length) {
    const id = queue.pop();
    if (secret.has(id)) continue;
    secret.add(id);
    for (const child of indexed.get(id)?.childIds || []) queue.push(child);
  }
  return secret;
}

// One viewport evaluation is enough for both dimensions, and may run while
// Chrome captures the screenshot. Selector capture already returned the viewport
// dimensions with the element bounds, so it needs no further CDP evaluation.
export async function captureViewportScreenshot(session, screenshotTarget = null) {
  const dimensions = screenshotTarget
    ? Promise.resolve({width:screenshotTarget.viewport_width, height:screenshotTarget.viewport_height})
    : evaluate(session, '({width:innerWidth,height:innerHeight})').catch(() => null);
  const image = session.send('Page.captureScreenshot', {
    format:'png',fromSurface:true,captureBeyondViewport:false,
  });
  const [size,captured] = await Promise.all([dimensions,image]);
  return {
    captured,
    viewport:{scope:'viewport',width:size?.width ?? null,height:size?.height ?? null},
  };
}

// Enabling Accessibility is a per-CDP-socket state. Reuse the successful
// handshake for retained guarded sockets; a new socket always enables afresh.
const accessibilityReady = new WeakMap();
export async function ensureAccessibilityReady(session) {
  let pending = accessibilityReady.get(session);
  if (!pending) {
    pending = Promise.resolve().then(() => session.send('Accessibility.enable'));
    accessibilityReady.set(session,pending);
    try { await pending; }
    catch (error) {
      if (accessibilityReady.get(session)===pending) accessibilityReady.delete(session);
      throw error;
    }
  } else await pending;
}

export async function browserSnapshot(args) {
  return withTarget(args, async (session, target) => {
    await ensureAccessibilityReady(session);
    const { nodes = [] } = await session.send('Accessibility.getFullAXTree');
    const limit = clamp(args.max_nodes, 1500, 1, 10_000);
    const redacted = sensitiveAccessibilityDescendants(nodes);
    const simplified = nodes.slice(0, limit).map(node => ({
      node_id: boundedText(node.nodeId, 256),
      ignored: Boolean(node.ignored),
      role: boundedText(node.role?.value, 256),
      name: redacted.has(node.nodeId) && !['textbox','searchbox','combobox','spinbutton'].includes(
        String(node.role?.value||'').toLowerCase()
      ) ? '' : boundedText(node.name?.value, 1000),
      value: redacted.has(node.nodeId) ? '' : safeAccessibilityValue(node),
      description: redacted.has(node.nodeId) ? '' : boundedText(node.description?.value, 1000),
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
    let screenshot;
    try {
      screenshot = await captureViewportScreenshot(session, payload.screenshot_target);
    } finally {
      if (restoreScroll) {
        await evaluate(session, `window.scrollTo({left:${restoreScroll.x},top:${restoreScroll.y},behavior:'instant'})`).catch(() => {});
      }
    }
    const data = String(screenshot.captured?.data || '');
    if (!data) throw new Error('CDP returned no screenshot data');
    if (Buffer.byteLength(data, 'base64') > 8 * 1024 * 1024) throw new Error('Browser screenshot exceeds the 8 MiB inline image limit');
    payload.screenshot = screenshot.viewport;
    const result = jsonResult(payload);
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
    const wanted = needle ? needle.toLowerCase() : '';
    const compactWanted = wanted.replace(/\\s+/g, '');
    const wantedRole = role ? role.toLowerCase() : '';
    // Native roles have a bounded set of possible tags. Include all explicit
    // ARIA roles too, so role='button' on a custom element remains discoverable.
    // Unknown roles deliberately retain the full-document fallback.
    const nativeRoleSelectors = {
      button:'button,summary,input', link:'a[href]',
      heading:'h1,h2,h3,h4,h5,h6', textbox:'textarea,input',
      searchbox:'input', combobox:'select,input', listbox:'select',
      checkbox:'input', radio:'input', slider:'input', spinbutton:'input',
      option:'option', img:'img', progressbar:'progress', meter:'meter',
    };
    const sourceSelector = selector || (Object.hasOwn(nativeRoleSelectors,wantedRole)
      ? nativeRoleSelectors[wantedRole] + ',[role]' : '*');
    const source = document.querySelectorAll(sourceSelector);
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
      if (!wanted) return 0;
      const hay = value.toLowerCase();
      if (hay === wanted) return 0;
      if (hay.startsWith(wanted)) return 1;
      return 2;
    }
    function depthOf(el) {
      let depth = 0;
      for (let current = el.parentElement; current; current = current.parentElement) depth += 1;
      return depth;
    }
    const rankAll = Boolean(wanted && !selector);
    const candidates = [];
    for (const el of source) {
      const r = semanticRole(el);
      if (wantedRole && r !== wantedRole) continue;
      // Cheap raw text/label check before forcing layout via innerText,
      // computed styles or bounding boxes. The final visibleText match is
      // still required so hidden descendants do not become false positives.
      if (wanted) {
        const raw = String(el.textContent || '').toLowerCase();
        const aria = String(el.getAttribute('aria-label') || '').toLowerCase();
        // CSS layout can insert line breaks absent from textContent. Compare
        // whitespace-free forms as a fallback to avoid missing those matches.
        if (!raw.includes(wanted) && !aria.includes(wanted)
            && !raw.replace(/\\s+/g, '').includes(compactWanted)
            && !aria.replace(/\\s+/g, '').includes(compactWanted)) continue;
      }
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || !el.getClientRects().length) continue;
      const text = wanted ? visibleText(el) : '';
      if (wanted && !text.toLowerCase().includes(wanted)) continue;
      candidates.push({el,index:candidates.length,text,role:r,depth:rankAll ? depthOf(el) : 0});
      // Text-only searches rank all matches to prefer exact interactive
      // targets. Every other search uses DOM order and can stop at limit.
      if (!rankAll && candidates.length >= ${limit}) break;
    }
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
    // Credentials are never sent back in browser_find; even a normal
    // text input can carry an OTP or API token via its name/autocomplete.
    function isSensitiveControl(el) {
      const tag = el.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea') return false;
      if (tag === 'input' && String(el.type || '').toLowerCase() === 'password') return true;
      const description = ['id','name','autocomplete'].map(key => el.getAttribute(key) || '').join(' ');
      return /(?:password|passwd|passcode|one.time.code|otp|secret|api.?key|auth.?token|access.?token|recovery.?code)/i.test(description);
    }
    return selected.map(({ el }) => {
      const b = el.getBoundingClientRect();
      const sensitive = isSensitiveControl(el);
      return { selector: cssPath(el), tag: el.tagName.toLowerCase(), role: semanticRole(el), name: el.getAttribute('aria-label') || el.getAttribute('name') || '', text: sensitive ? '' : visibleText(el).slice(0, 500), value: !sensitive && 'value' in el ? String(el.value).slice(0, 500) : '', x: b.x, y: b.y, width: b.width, height: b.height, disabled: Boolean(el.disabled) };
    });
  })()`;
}
