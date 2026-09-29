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

function parseWindows(stdout) {
  const rows = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = line.match(/^(0x[0-9a-f]+)\s+\S+\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+\S+\s*(.*)$/i);
    if (!match) continue;
    rows.push({
      id: match[1],
      pid: Number(match[2]),
      x: Number(match[3]),
      y: Number(match[4]),
      width: Number(match[5]),
      height: Number(match[6]),
      app: match[7],
      title: match[8],
    });
  }
  return rows;
}

export function parseX11PixelBounds(stdout) {
  const x = Number(String(stdout).match(/Absolute upper-left X:\s*(-?\d+)/)?.[1]);
  const y = Number(String(stdout).match(/Absolute upper-left Y:\s*(-?\d+)/)?.[1]);
  const width = Number(String(stdout).match(/^\s*Width:\s*(\d+)/m)?.[1]);
  const height = Number(String(stdout).match(/^\s*Height:\s*(\d+)/m)?.[1]);
  if (![x,y,width,height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

async function x11PixelBounds(id) {
  if (!commandExists('xwininfo')) return null;
  const { stdout } = await runFile('xwininfo', ['-id', String(id)], { label:'X11 window geometry', allowFailure:true, timeout:1000 });
  return parseX11PixelBounds(stdout);
}

export async function listWindows() {
  let wmRows = commandExists('wmctrl')
    ? parseWindows((await runFile('wmctrl', ['-lpGx'], { label: 'window inventory', allowFailure:true, timeout:3000 })).stdout)
    : [];
  if (!isWaylandSession()) {
    if (!wmRows.length && !commandExists('wmctrl')) unavailable('Window inventory', 'install wmctrl');
    return jsonResult(wmRows.map(row => ({
      ...row,
      wm_id: row.id,
      ui_id: null,
      backend: 'x11',
      actions: ['focus','minimize','maximize','restore','move','resize','move_resize','close'],
    })));
  }

  let uiRows = [];
  try {
    const snapshot = await uiSnapshot({ max_nodes: 2500, max_depth: 1 });
    const payload = JSON.parse(snapshot.content?.[0]?.text || '{}');
    const nodes = Array.isArray(payload) ? payload : payload.nodes || [];
    uiRows = nodes.filter(node => {
      const role = String(node.role || '').toLowerCase();
      return ['frame','window','dialog'].includes(role)
        && String(node.name || node.window || '').trim()
        && Number(node.width) > 0
        && Number(node.height) > 0
        && Number(node.x) > -1000000
        && Number(node.y) > -1000000;
    });
  } catch {}

  // AT-SPI enumeration can take several seconds on a busy desktop. Refresh the cheap
  // X11 inventory afterwards so an XWayland window that appeared while AT-SPI was
  // walking the tree is merged with its semantic window instead of being misclassified
  // as native Wayland for the rest of this call.
  if (commandExists('wmctrl')) {
    const refreshedWmRows = parseWindows((await runFile('wmctrl', ['-lpGx'], { label:'window inventory refresh', allowFailure:true, timeout:3000 })).stdout);
    if (refreshedWmRows.length) wmRows = refreshedWmRows;
  }

  const pixelBounds = new Map();
  if (commandExists('xwininfo')) {
    // wmctrl geometry on Mutter/XWayland is decoration-shifted and cannot be used for pixel crops.
    // xwininfo reports the actual client-area coordinates in the compositor screenshot space.
    for (const row of wmRows) {
      try {
        const bounds = await x11PixelBounds(row.id);
        if (bounds) pixelBounds.set(row.id, bounds);
      } catch {}
    }
  }

  const usedUi = new Set();
  const rows = wmRows.map(row => {
    const matchIndex = uiRows.findIndex((node, index) => {
      if (usedUi.has(index)) return false;
      if (Number(node.pid) > 0 && Number(row.pid) > 0 && Number(node.pid) !== Number(row.pid)) return false;
      const nodeTitle = String(node.name || node.window || '').trim().toLowerCase();
      const rowTitle = String(row.title || '').trim().toLowerCase();
      return nodeTitle && rowTitle && (nodeTitle === rowTitle || nodeTitle.includes(rowTitle) || rowTitle.includes(nodeTitle));
    });
    const node = matchIndex >= 0 ? uiRows[matchIndex] : null;
    if (matchIndex >= 0) usedUi.add(matchIndex);
    const xBounds = pixelBounds.get(row.id) || null;
    return {
      ...row,
      ...(xBounds || {}),
      pid: Number(row.pid) > 0 ? Number(row.pid) : (Number(node?.pid) > 0 ? Number(node.pid) : null),
      wm_bounds: xBounds ? { x:row.x, y:row.y, width:row.width, height:row.height } : null,
      geometry_source: xBounds ? 'xwininfo' : 'wmctrl',
      wm_id: row.id,
      ui_id: node?.id || null,
      backend: node ? 'xwayland+atspi' : 'xwayland',
      actions: ['focus','minimize','maximize','restore','move','resize','move_resize','close'],
      action_backends: isWaylandSession()
        ? { focus:'xdg-desktop-portal', minimize:'wmctrl', maximize:'wmctrl', restore:'wmctrl', move:'wmctrl', resize:'wmctrl', move_resize:'wmctrl', close:'wmctrl' }
        : { focus:'wmctrl', minimize:'wmctrl', maximize:'wmctrl', restore:'wmctrl', move:'wmctrl', resize:'wmctrl', move_resize:'wmctrl', close:'wmctrl' },
      focus_requires_portal_permission: isWaylandSession(),
    };
  });

  for (let index = 0; index < uiRows.length; index += 1) {
    if (usedUi.has(index)) continue;
    const node = uiRows[index];
    rows.push({
      id: node.id,
      wm_id: null,
      ui_id: node.id,
      pid: Number(node.pid) || null,
      x: Number(node.x),
      y: Number(node.y),
      width: Number(node.width),
      height: Number(node.height),
      app: node.app || null,
      title: node.name || node.window || '',
      backend: 'wayland-atspi',
      actions: ['focus','minimize','maximize','restore','move','resize','move_resize','close'],
      action_backend: 'xdg-desktop-portal',
      requires_portal_permission: true,
    });
  }

  if (!rows.length) unavailable('Window inventory', 'wmctrl and AT-SPI exposed no top-level windows');
  return jsonResult(rows);
}

function windowSelector(args = {}) {
  return {
    id: optionalString(args.id || args.window_id || args.windowId),
    pid: Number.isInteger(Number(args.pid)) ? Number(args.pid) : null,
    app: optionalString(args.app),
    title: optionalString(args.title || args.window_title || args.windowTitle),
  };
}

function windowMatchesSelector(item, selector) {
  return (!selector.id || item.id === selector.id || item.wm_id === selector.id || item.ui_id === selector.id)
    && (selector.pid == null || Number(item.pid) === selector.pid)
    && (!selector.app || String(item.app || '').toLowerCase().includes(selector.app.toLowerCase()))
    && (!selector.title || String(item.title || '').toLowerCase().includes(selector.title.toLowerCase()));
}

async function fastX11WindowMatch(args) {
  if (!commandExists('wmctrl')) return null;
  const selector = windowSelector(args);
  const rows = parseWindows((await runFile('wmctrl', ['-lpGx'], {
    label:'window match',
    allowFailure:true,
    timeout:2000,
  })).stdout);
  const row = rows.find(item => windowMatchesSelector({ ...item, wm_id:item.id, ui_id:null }, selector));
  if (!row) return null;
  return {
    ...row,
    wm_id:row.id,
    ui_id:null,
    backend:isWaylandSession() ? 'xwayland' : 'x11',
  };
}

async function windowMatch(args) {
  // Most desktop actions target an X11/XWayland window. Resolve that cheap native id
  // first instead of rebuilding the entire AT-SPI inventory before every action.
  // Native Wayland windows have no wmctrl row and fall through to the semantic inventory.
  const fast = await fastX11WindowMatch(args);
  if (fast) return fast;

  const rows = JSON.parse((await listWindows()).content[0].text);
  const selector = windowSelector(args);
  const row = rows.find(item => windowMatchesSelector(item, selector));
  if (!row) throw new Error('No matching window found');
  return row;
}

async function focusedAccessibilityContext() {
  if (!commandExists('python3')) return null;
  const script = String.raw`import gi,json
gi.require_version("Atspi","2.0")
from gi.repository import Atspi
desktop=Atspi.get_desktop(0)
queue=[];out=[];seen=0
for i in range(desktop.get_child_count()):
 app=desktop.get_child_at_index(i)
 try:
  app_name=app.get_name() or ""
  pid=int(app.get_process_id())
  queue.append((app,app_name,pid,""))
 except Exception: pass
while queue and seen<12000:
 node,app_name,pid,window_name=queue.pop(0);seen+=1
 try:
  role=node.get_role_name() or ""
  name=node.get_name() or ""
  if role.lower() in ("frame","window","dialog") and name: window_name=name
  if node.get_state_set().contains(Atspi.StateType.FOCUSED) and pid>0:
   out.append({"pid":pid,"app":app_name,"window":window_name,"role":role,"name":name})
  for i in range(node.get_child_count()): queue.append((node.get_child_at_index(i),app_name,pid,window_name))
 except Exception: pass
print(json.dumps(out))`;
  const result = await runFile('python3', ['-c', script], { label:'focused accessibility context', allowFailure:true, timeout:2500 });
  let rows = [];
  try { rows = JSON.parse(result.stdout || '[]'); } catch {}
  if (!Array.isArray(rows) || !rows.length) return null;
  const score = row => {
    const app = String(row.app || '').toLowerCase();
    const windowName = String(row.window || '').trim();
    const role = String(row.role || '').toLowerCase();
    let value = windowName ? 100 : 0;
    if (app && app !== 'gnome-shell') value += 40;
    if (row.name) value += 15;
    if (!['window','filler','panel'].includes(role)) value += 15;
    if (/desktop icons/i.test(windowName)) value -= 80;
    if (app === 'gnome-shell' && !windowName) value -= 120;
    return value;
  };
  return rows.sort((a,b) => score(b)-score(a))[0] || null;
}

async function focusedAccessibilityPid() {
  return Number((await focusedAccessibilityContext())?.pid) || null;
}

async function targetAccessibilityFocus(row) {
  const pid = Number(row?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { focused:null, exact:null };
  try {
    const result = await uiSnapshot({ pid, max_nodes: 2200, max_depth: 24 });
    const payload = JSON.parse(result.content?.[0]?.text || '{}');
    const nodes = Array.isArray(payload) ? payload : payload.nodes || [];
    const topLevelActive = nodes.filter(node =>
      node.active === true
      && /frame|window|dialog/i.test(String(node.role || ''))
      && String(node.window || node.name || '').trim()
    );
    const active = topLevelActive[0] || null;
    const wanted = String(row.title || '').trim().toLowerCase();
    const exact = !wanted ? active : topLevelActive.find(node => {
      const current = String(node.window || node.name || '').trim().toLowerCase();
      return current && (wanted === current || wanted.includes(current) || current.includes(wanted));
    }) || null;
    return { active, exact };
  } catch {
    return { active:null, exact:null };
  }
}

async function inputWindowId(args = {}) {
  const explicit = Boolean(args.window_id || args.windowId || args.id || args.pid != null || args.app || args.title || args.window_title || args.windowTitle);
  if (explicit) return (await windowMatch(args)).wm_id || null;
  if (!isWaylandSession()) return null;
  const pid = await focusedAccessibilityPid();
  if (!pid) return null;
  try { return (await windowMatch({ pid })).wm_id || null; } catch { return null; }
}

async function focusInputWindow(windowId) {
  if (!windowId || !commandExists('wmctrl')) return;
  const result = await runFile('wmctrl', ['-ia', windowId], { label:'input window focus', allowFailure:true, timeout:2000 });
  if (result.code === 0) await new Promise(resolve => setTimeout(resolve, 40));
}

function explicitInputWindowSelector(args = {}) {
  const dedicatedWindowId = optionalString(args.window_id || args.windowId);
  const dedicatedTitle = optionalString(args.title);
  const hasSemanticElementTarget = Boolean(
    optionalString(args.id)
    || optionalString(args.name)
    || optionalString(args.role)
    || optionalString(args.automation_id || args.automationId)
  );
  if (!dedicatedWindowId && !dedicatedTitle && hasSemanticElementTarget) return null;
  const pid = Number.isInteger(Number(args.pid)) ? Number(args.pid) : null;
  const app = optionalString(args.app);
  const scopedTitle = optionalString(args.window_title || args.windowTitle);
  if (!dedicatedWindowId && !dedicatedTitle && pid == null && !app && !scopedTitle) return null;
  return {
    ...(dedicatedWindowId ? { id:dedicatedWindowId } : {}),
    ...(pid != null ? { pid } : {}),
    ...(app ? { app } : {}),
    ...((dedicatedTitle || scopedTitle) ? { title:dedicatedTitle || scopedTitle } : {}),
  };
}

async function focusExplicitWaylandInputTarget(args = {}) {
  const selector = explicitInputWindowSelector(args);
  if (!selector) return null;
  const row = await windowMatch(selector);
  await windowAction({ action:'focus', id:row.id, backend:inputBackend(args) });
  return row;
}

function nativeWaylandGeometryMatches(row, expected = {}, tolerance = 24) {
  for (const key of ['x','y','width','height']) {
    if (expected[key] == null) continue;
    const actual = Number(row?.[key]);
    const wanted = Number(expected[key]);
    if (!Number.isFinite(actual) || !Number.isFinite(wanted) || Math.abs(actual - wanted) > tolerance) return false;
  }
  return true;
}

async function verifyNativeWaylandGeometry(row, expected, label) {
  let latest = row;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 120));
    try {
      latest = await windowMatch({ id:row.id });
      if (nativeWaylandGeometryMatches(latest, expected)) return latest;
    } catch {}
  }
  const actual = ['x','y','width','height']
    .map(key => `${key}=${Number.isFinite(Number(latest?.[key])) ? Number(latest[key]) : 'unknown'}`)
    .join(' ');
  const wanted = Object.entries(expected)
    .map(([key,value]) => `${key}=${value}`)
    .join(' ');
  throw new Error(`Could not verify native Wayland window ${label} for ${row.title || row.app || row.id}: wanted ${wanted}; observed ${actual}`);
}

async function nativeWaylandAccessibilityAction(row, actionNames) {
  const pid = Number(row?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || !Array.isArray(actionNames) || !actionNames.length) {
    return { applied:false, available:[] };
  }
  const script = pyAtSpiPrelude() + `
want_pid=${pid};want_window=${JSON.stringify(String(row.title || ''))};wanted_actions=${JSON.stringify(actionNames)}
target=None
for root,app_name,pid,active in q:
 if pid!=want_pid: continue
 try:
  for child in root:
   try:
    role=(child.getRoleName() or "").lower();name=child.name or ""
    if role not in ("frame","window","dialog"): continue
    if want_window and want_window.strip().lower()!=name.strip().lower(): continue
    target=child;break
   except: pass
 except: pass
 if target is not None: break
if target is None:
 print(json.dumps({"applied":False,"available":[],"reason":"target window not found"}))
else:
 try:
  actions=target.queryAction();available=[];chosen=-1;chosen_name=""
  for i in range(actions.nActions):
   try: action_name=actions.getName(i) or ""
   except: action_name=""
   available.append(action_name)
   if chosen<0 and action_name in wanted_actions:
    chosen=i;chosen_name=action_name
  if chosen<0:
   print(json.dumps({"applied":False,"available":available,"reason":"requested accessibility action unavailable"}))
  else:
   applied=actions.doAction(chosen)
   if applied is False: raise Exception("accessibility window action returned false")
   print(json.dumps({"applied":True,"action":chosen_name,"available":available}))
 except Exception as exc:
  print(json.dumps({"applied":False,"available":[],"reason":str(exc)}))
`;
  const result = await runFile('python3', ['-c', script], { label:'AT-SPI window action', timeout:2000, allowFailure:true });
  try {
    const payload = JSON.parse(result.stdout || '{}');
    return payload && typeof payload === 'object' ? payload : { applied:false, available:[] };
  } catch {
    return { applied:false, available:[], reason:String(result.stderr || result.stdout || 'AT-SPI window action failed').trim() };
  }
}

async function verifyNativeWaylandWindowClosed(row, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await windowMatch({ id:row.id }); }
    catch { return; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Could not verify native Wayland window close for ${row.title || row.app || row.id}`);
}

async function focusNativeWaylandForAction(row, backend) {
  await windowAction({ action:'focus', id:row.id, backend });
  const focusState = await targetAccessibilityFocus(row);
  if (!focusState.exact) throw new Error(`Could not verify native Wayland focus for ${row.title || row.app || row.id}`);
}

async function nativeWaylandWindowAction(row, action, args) {
  const backend = inputBackend(args);
  if (backend === 'x11') unavailable('Native Wayland window action', 'use backend=portal for compositor-managed windows');
  if (!waylandPortalCandidate()) unavailable('Native Wayland window action', 'no XDG RemoteDesktop portal is available');
  if (backend === 'auto' && !hasWaylandRemoteDesktopGrant()) portalPermissionHint('Native Wayland window action');

  const portalBackend = backend === 'portal' ? 'portal' : 'auto';
  const timeoutMs = backend === 'portal' ? 120_000 : 2500;
  if (action === 'close') {
    const semantic = await nativeWaylandAccessibilityAction(row, ['window.close']);
    if (semantic.applied) {
      await verifyNativeWaylandWindowClosed(row);
      return jsonResult({ action, backend:'atspi-window-action', id:row.id, accessibility_action:semantic.action });
    }
    // Some GTK apps disconnect from AT-SPI while handling window.close, before the action
    // call can return a success payload. Trust the observed target state, not that race.
    try {
      await verifyNativeWaylandWindowClosed(row, 400);
      return jsonResult({ action, backend:'atspi-window-action', id:row.id, accessibility_action:'window.close', verified_after_disconnect:true });
    } catch {}
    await focusNativeWaylandForAction(row, portalBackend);
    await portalShortcut('ALT+F4', { timeoutMs });
    await verifyNativeWaylandWindowClosed(row);
    return jsonResult({ action, backend:'xdg-desktop-portal', id:row.id });
  }
  if (action === 'minimize') {
    await focusNativeWaylandForAction(row, portalBackend);
    await portalShortcut('ALT+F9', { timeoutMs });
  }
  else if (action === 'maximize' || action === 'restore') {
    let maximized = false;
    try {
      const displays = JSON.parse((await displayInventory()).content?.[0]?.text || '[]');
      const cx = Number(row.x) + Number(row.width) / 2;
      const cy = Number(row.y) + Number(row.height) / 2;
      const display = displays.find(item =>
        Number.isFinite(cx) && Number.isFinite(cy)
        && cx >= Number(item.x) && cx < Number(item.x) + Number(item.width)
        && cy >= Number(item.y) && cy < Number(item.y) + Number(item.height)
      ) || displays.find(item => item.primary) || displays[0];
      if (display) {
        const tolerance = 24;
        const widthClose = Math.abs(Number(row.width) - Number(display.width)) <= tolerance;
        const heightClose = Number(row.height) >= Number(display.height) - 100;
        const xClose = Math.abs(Number(row.x) - Number(display.x)) <= tolerance;
        const yClose = Number(row.y) >= Number(display.y) && Number(row.y) - Number(display.y) <= 100;
        maximized = widthClose && heightClose && xClose && yClose;
      }
    } catch {}
    if ((action === 'maximize' && !maximized) || (action === 'restore' && maximized)) {
      await focusNativeWaylandForAction(row, portalBackend);
      await portalShortcut('ALT+F10', { timeoutMs });
    }
  } else {
    await focusNativeWaylandForAction(row, portalBackend);
    let currentX = Number(row.x), currentY = Number(row.y), currentWidth = Number(row.width), currentHeight = Number(row.height);
    if (![currentX,currentY,currentWidth,currentHeight].every(Number.isFinite)) unavailable('Native Wayland window geometry', 'accessibility bounds are unavailable');

    if (action === 'move' || action === 'move_resize') {
      const x = Number(args.x), y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y are required for native Wayland window move');
      const titleOffset = Math.min(18, Math.max(10, currentHeight / 20));
      await dragDrop({
        from_x:currentX + currentWidth / 2,
        from_y:currentY + titleOffset,
        to_x:x + currentWidth / 2,
        to_y:y + titleOffset,
        backend:portalBackend,
        hold_ms:80,
        duration_ms:120,
      });
      const verified = await verifyNativeWaylandGeometry(row, { x, y }, 'move');
      currentX = Number(verified.x);
      currentY = Number(verified.y);
      currentWidth = Number(verified.width);
      currentHeight = Number(verified.height);
    }

    if (action === 'resize' || action === 'move_resize') {
      const width = Number(args.width), height = Number(args.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('width and height must be positive for native Wayland window resize');
      await dragDrop({
        from_x:currentX + currentWidth - 4,
        from_y:currentY + currentHeight - 4,
        to_x:currentX + width - 4,
        to_y:currentY + height - 4,
        backend:portalBackend,
        hold_ms:80,
        duration_ms:120,
      });
      const verified = await verifyNativeWaylandGeometry(row, { width, height }, 'resize');
      currentX = Number(verified.x);
      currentY = Number(verified.y);
      currentWidth = Number(verified.width);
      currentHeight = Number(verified.height);
    }
    return jsonResult({
      action,
      backend:'xdg-desktop-portal',
      id:row.id,
      x:currentX,
      y:currentY,
      width:currentWidth,
      height:currentHeight,
    });
  }
  return jsonResult({ action, backend:'xdg-desktop-portal', id:row.id });
}

export async function windowAction(args) {
  const action = requireEnum(args.action, 'action', ['focus','minimize','maximize','restore','move','resize','move_resize','close']);
  const row = await windowMatch(args);
  const id = row.wm_id || row.id;
  const nativeWayland = isWaylandSession() && !row.wm_id && !/^0x/i.test(String(id || ''));
  if (action === 'focus') {
    if (isWaylandSession()) {
      const backend = inputBackend(args);
      if (row.ui_id && backend !== 'portal') {
        try {
          await uiAction({ action:'focus', id:row.ui_id });
          await new Promise(resolve => setTimeout(resolve, 80));
          const focusState = await targetAccessibilityFocus(row);
          if (focusState.exact) return text('Window action focus completed via verified AT-SPI focus.');
        } catch {}
      }
      // XWayland windows have a real X11 wm_id even inside a Wayland session. Prefer
      // direct activation for those windows, verify the result through accessibility,
      // and only fall back to compositor-level cycling if direct activation did not take.
      // This avoids dozens of Alt+Esc/AT-SPI round trips on busy desktops.
      if (row.wm_id && backend !== 'portal' && commandExists('wmctrl')) {
        const activated = await runFile('wmctrl', ['-ia', row.wm_id], { label:'XWayland window focus', allowFailure:true, timeout:2000 });
        if (activated.code === 0) {
          if (commandExists('xdotool')) {
            await runFile('xdotool', ['windowactivate','--sync',row.wm_id], { label:'XWayland window focus sync', allowFailure:true, timeout:3000 });
          }
          await new Promise(resolve => setTimeout(resolve, 80));
          const focusState = await targetAccessibilityFocus(row);
          if (focusState.exact) return text('Window action focus completed via verified XWayland activation.');
        }
      }
      if (backend === 'x11') unavailable('Wayland window focus', row.wm_id
        ? 'direct XWayland activation did not produce verifiable focus'
        : 'the target is native Wayland and has no X11 window id; use backend=portal');
      if (!waylandPortalCandidate()) unavailable('Wayland window focus', 'no XDG RemoteDesktop portal is available');
      if (backend === 'auto' && !hasWaylandRemoteDesktopGrant()) portalPermissionHint('Wayland window focus');
      const portalOptions = { timeoutMs: backend === 'portal' ? 120_000 : 2500 };
      let focusState = await targetAccessibilityFocus(row);
      if (focusState.exact) return text('Window action focus already matched the target window.');

      const rows = JSON.parse((await listWindows()).content?.[0]?.text || '[]');
      const windowCycles = Math.min(60, Math.max(8, rows.length + 4));
      for (let index = 0; index < windowCycles; index += 1) {
        await portalShortcut('ALT+ESC', portalOptions);
        await new Promise(resolve => setTimeout(resolve, 140));
        focusState = await targetAccessibilityFocus(row);
        if (focusState.exact) return text('Window action focus completed via verified Wayland Alt+Esc.');
      }

      const appCycles = Math.min(12, Math.max(3, new Set(rows.map(item => Number(item.pid) || String(item.app || ''))).size + 1));
      for (let index = 0; index < appCycles; index += 1) {
        await portalShortcut('ALT+TAB', portalOptions);
        await new Promise(resolve => setTimeout(resolve, 160));
        focusState = await targetAccessibilityFocus(row);
        if (focusState.exact) return text('Window action focus completed via verified Wayland Alt+Tab fallback.');
        if (focusState.active) {
          const sameAppWindows = rows.filter(item => Number(item.pid) === Number(row.pid)).length;
          for (let windowIndex = 0; windowIndex < Math.min(8, Math.max(2, sameAppWindows + 1)); windowIndex += 1) {
            await portalShortcut('ALT+`', portalOptions);
            await new Promise(resolve => setTimeout(resolve, 120));
            focusState = await targetAccessibilityFocus(row);
            if (focusState.exact) return text('Window action focus completed via verified Wayland same-app fallback.');
          }
        }
      }
      throw new Error(`Could not verify focus for ${row.title || row.app || row.id} after bounded Wayland window cycling`);
    }
    if (!commandExists('wmctrl')) unavailable('Window focus', 'install wmctrl');
    await runFile('wmctrl', ['-ia', id], { label: 'window focus' });
    if (commandExists('xdotool')) {
      const activated = await runFile('xdotool', ['windowactivate','--sync',id], { label:'window focus sync', allowFailure:true, timeout:3000 });
      if (activated.code !== 0) await new Promise(resolve => setTimeout(resolve, 80));
    }
  }
  else if (nativeWayland) return nativeWaylandWindowAction(row, action, args);
  else if (!commandExists('wmctrl')) unavailable('Window action', 'install wmctrl');
  else if (action === 'close') await runFile('wmctrl', ['-ic', id], { label: 'window close' });
  else if (action === 'minimize') await runFile('wmctrl', ['-ir', id, '-b', 'add,hidden'], { label: 'window minimize' });
  else if (action === 'maximize') await runFile('wmctrl', ['-ir', id, '-b', 'add,maximized_vert,maximized_horz'], { label: 'window maximize' });
  else if (action === 'restore') await runFile('wmctrl', ['-ir', id, '-b', 'remove,hidden,maximized_vert,maximized_horz'], { label: 'window restore' });
  else {
    const x = Number(args.x), y = Number(args.y), width = Number(args.width), height = Number(args.height);
    const geometry = `0,${Number.isFinite(x) ? Math.trunc(x) : -1},${Number.isFinite(y) ? Math.trunc(y) : -1},${Number.isFinite(width) ? Math.trunc(width) : -1},${Number.isFinite(height) ? Math.trunc(height) : -1}`;
    await runFile('wmctrl', ['-ir', id, '-e', geometry], { label: 'window geometry' });
  }
  return text(`Window action ${action} completed.`);
}

function pyAtSpiPrelude() {
  return `import json,sys,math
try:
 import pyatspi
except Exception:
 try:
  import gi
  gi.require_version("Atspi","2.0")
  from gi.repository import Atspi
  class _Component:
   def __init__(self,a): self.a=a
   def getExtents(self,coords): return self.a.get_extents(coords)
   def grabFocus(self): return self.a.grab_focus()
  class _Value:
   def __init__(self,a): self.a=a
   @property
   def currentValue(self): return self.a.get_current_value()
   @currentValue.setter
   def currentValue(self,v): self.a.set_current_value(float(v))
  class _Action:
   def __init__(self,a): self.a=a
   @property
   def nActions(self): return self.a.get_n_actions()
   def getName(self,i): return self.a.get_action_name(i)
   def doAction(self,i): return self.a.do_action(i)
  class _Editable:
   def __init__(self,a): self.a=a
   def setTextContents(self,v): return self.a.set_text_contents(v)
  class _Accessible:
   def __init__(self,a): self.a=a
   @property
   def name(self): return self.a.get_name()
   @property
   def childCount(self): return self.a.get_child_count()
   def getState(self): return self.a.get_state_set()
   def getRoleName(self): return self.a.get_role_name()
   def getChildAtIndex(self,i): return _Accessible(self.a.get_child_at_index(i))
   def queryComponent(self): return _Component(self.a)
   def queryValue(self):
    iface=self.a.get_value_iface()
    if iface is None: raise Exception("Value interface unavailable")
    return _Value(self.a)
   def queryAction(self): return _Action(self.a)
   def queryEditableText(self): return _Editable(self.a)
   def getProcessId(self):
    try: return int(self.a.get_process_id())
    except: return 0
   def __iter__(self):
    for i in range(self.childCount): yield self.getChildAtIndex(i)
  class _Registry:
   @staticmethod
   def getDesktop(i): return _Accessible(Atspi.get_desktop(i))
  class _Compat:
   Registry=_Registry
   STATE_ACTIVE=Atspi.StateType.ACTIVE
   STATE_SHOWING=Atspi.StateType.SHOWING
   STATE_FOCUSED=Atspi.StateType.FOCUSED
   DESKTOP_COORDS=Atspi.CoordType.SCREEN
  pyatspi=_Compat()
 except Exception as exc:
  print(json.dumps({"error":"AT-SPI unavailable: %s"%exc}));sys.exit(3)
desktop=pyatspi.Registry.getDesktop(0)
def _proc(e):
 for attr in ("getProcessId","get_process_id"):
  try:
   return int(getattr(e,attr)())
  except: pass
 try:
  app=e.getApplication()
  for attr in ("getProcessId","get_process_id"):
   try: return int(getattr(app,attr)())
   except: pass
 except: pass
 return 0
q=[]
for app in desktop:
 try:
  app_name=app.name or ""
  pid=_proc(app)
  active=False
  try:
   active=bool(app.getState().contains(pyatspi.STATE_ACTIVE))
   if not active:
    for child_i in range(min(app.childCount,64)):
     try:
      child=app.getChildAtIndex(child_i)
      if child.getState().contains(pyatspi.STATE_ACTIVE):
       active=True;break
     except: pass
  except: pass
  if app.childCount>0 or pid>0:q.append((app,app_name,pid,active))
 except:pass
`;
}

export async function uiSnapshot(args = {}) {
  if (!commandExists('python3')) unavailable('Linux accessibility', 'python3 with python3-pyatspi is required');
  const maxNodes = clamp(args.max_nodes, 500, 1, 5000);
  const maxDepth = clamp(args.max_depth, 8, 1, 32);
  const wantedApp = JSON.stringify(optionalString(args.app) || '');
  const wantedPid = Number.isInteger(Number(args.pid)) ? Number(args.pid) : 0;
  const wantedWindow = JSON.stringify(optionalString(args.window_title || args.windowTitle) || '');
  const activeOnly = args.active_only === true;
  const script = pyAtSpiPrelude() + `
want_app=${wantedApp};want_pid=${wantedPid};want_window=${wantedWindow};want_active=${activeOnly ? 'True' : 'False'}
roots=[]
for root,app_name,pid,active in q:
 if want_pid and pid!=want_pid: continue
 if want_app and want_app.lower() not in app_name.lower(): continue
 if want_active and not active: continue
 roots.append((root,app_name,pid,active))
out=[];queue=[];seen=0
for root_index,(e,app_name,pid,active) in enumerate(roots):
 if want_window:
  top_match=False
  try:
   for child in e:
    try:
     child_name=child.name or ""
     child_role=child.getRoleName().lower()
     if child_role in ("frame","dialog","window") and want_window.lower() in child_name.lower():
      top_match=True;break
    except: pass
  except: pass
  if not top_match: continue
 root_path="r" if pid else "a%d"%root_index
 queue.append((e,0,app_name,pid,active,"",root_path))
while queue and len(out)<${maxNodes}:
 e,d,app_name,pid,active,window_name,node_path=queue.pop(0);current_index=seen;seen+=1
 try: role=e.getRoleName()
 except: role=""
 try: name=e.name or ""
 except: name=""
 if role.lower() in ("frame","dialog","window") and name: window_name=name
 try:
  ext=e.queryComponent().getExtents(pyatspi.DESKTOP_COORDS);box={"x":ext.x,"y":ext.y,"width":ext.width,"height":ext.height}
 except: box={"x":0,"y":0,"width":0,"height":0}
 try:
  value=e.queryValue().currentValue
  if isinstance(value,float) and not math.isfinite(value): value=""
 except: value=""
 focused=False;node_active=active
 try:
  states=e.getState();focused=bool(states.contains(pyatspi.STATE_FOCUSED));node_active=bool(node_active or states.contains(pyatspi.STATE_ACTIVE))
 except: pass
 if not want_window or want_window.lower() in window_name.lower():
  out.append({"id":"linux:%d:%s"%(pid,node_path),"index":current_index,"depth":d,"pid":pid,"app":app_name,"active":node_active,"focused":focused,"window":window_name,"role":role,"name":name,"value":value,**box})
 if d<${maxDepth}:
  try:
   for i in range(e.childCount):queue.append((e.getChildAtIndex(i),d+1,app_name,pid,active,window_name,node_path+"."+str(i)))
  except:pass
print(json.dumps(out))`;
  const result = await runFile('python3', ['-c', script], { label: 'AT-SPI snapshot', timeout: 30_000, allowFailure: true });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout || ''); } catch {}
  if (Array.isArray(parsed)) return jsonResult({ platform: 'linux', count: parsed.length, nodes: parsed });
  if (parsed?.error) unavailable('Linux accessibility', parsed.error);
  if (result.code !== 0) unavailable('Linux accessibility', (result.stderr || result.stdout).trim());
  return jsonResult({ platform: 'linux', count: 0, nodes: [] });
}

export async function uiAction(args = {}) {
  const action = requireEnum(args.action, 'action', ['click','invoke','focus','set_value','select','toggle','expand','collapse','scroll_into_view','set_range_value','add_to_selection','remove_from_selection']);
  if (!commandExists('python3')) unavailable('Linux accessibility action', 'python3 with python3-pyatspi is required');
  const id = optionalString(args.id);
  const idParts = id?.split(':') || [];
  const legacyIndex = idParts.length === 2 && idParts[0] === 'linux' && /^\d+$/.test(idParts[1]) ? Number(idParts[1]) : -1;
  const stablePid = idParts.length >= 3 && idParts[0] === 'linux' && /^\d+$/.test(idParts[1]) ? Number(idParts[1]) : 0;
  const stablePath = idParts.length >= 3 && idParts[0] === 'linux' ? idParts.slice(2).join(':') : '';
  const wantedPid = Number.isInteger(Number(args.pid)) ? Number(args.pid) : stablePid;
  const wantedApp = JSON.stringify(optionalString(args.app) || '');
  const wantedWindow = JSON.stringify(optionalString(args.window_title || args.windowTitle) || '');
  const wantedName = JSON.stringify(optionalString(args.name) || '');
  const wantedRole = JSON.stringify(optionalString(args.role) || '');
  const value = JSON.stringify(String(args.value ?? ''));
  const script = pyAtSpiPrelude() + `
want_index=${legacyIndex};want_pid=${wantedPid};want_path=${JSON.stringify(stablePath)}
want_app=${wantedApp};want_window=${wantedWindow};want_name=${wantedName};want_role=${wantedRole};action=${JSON.stringify(action)};value=${value}
queue=[];seen=0;target=None;target_meta={}
for root_index,(root,app_name,pid,active) in enumerate(q):
 if want_pid and pid!=want_pid: continue
 if want_app and want_app.lower() not in app_name.lower(): continue
 root_path="r" if pid else "a%d"%root_index
 queue.append((root,app_name,pid,"",root_path))
while queue:
 e,app_name,pid,window_name,node_path=queue.pop(0);current_index=seen;seen+=1
 try: role=e.getRoleName();name=e.name or ""
 except: role="";name=""
 if role.lower() in ("frame","dialog","window") and name: window_name=name
 id_match=(not want_path or (pid==want_pid and node_path==want_path)) and (want_index<0 or current_index==want_index)
 selector_match=(not want_name or want_name.lower() in name.lower()) and (not want_role or want_role.lower() in role.lower()) and (not want_window or want_window.lower() in window_name.lower())
 if id_match and selector_match:
  target=e;target_meta={"pid":pid,"app":app_name,"window":window_name,"path":node_path};break
 try:
  for i in range(e.childCount):queue.append((e.getChildAtIndex(i),app_name,pid,window_name,node_path+"."+str(i)))
 except:pass
if target is None:raise Exception("UI element not found")
pointer_fallback=None
if action in ("click","invoke"):
 try:
  applied=target.queryAction().doAction(0)
  if applied is False: raise Exception("accessibility action returned false")
 except Exception as action_error:
  try:
   extents=target.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
   def _rect_value(rect,name,index):
    try: return int(getattr(rect,name))
    except:
     try: return int(rect[index])
     except: return 0
   px=_rect_value(extents,"x",0);py=_rect_value(extents,"y",1)
   pw=_rect_value(extents,"width",2);ph=_rect_value(extents,"height",3)
   if pw<=0 or ph<=0: raise Exception("target has no usable screen bounds")
   pointer_fallback={"x":px+pw//2,"y":py+ph//2,"width":pw,"height":ph,"reason":str(action_error)}
  except Exception as bounds_error:
   raise Exception("accessibility action failed: %s; coordinate fallback unavailable: %s"%(action_error,bounds_error))
elif action in ("select","toggle"):
 applied=target.queryAction().doAction(0)
 if applied is False: raise Exception(action+" accessibility action returned false")
elif action=="focus":
 if target.queryComponent().grabFocus() is False: raise Exception("focus accessibility action returned false")
elif action=="set_value":
 try:
  applied=target.queryEditableText().setTextContents(value)
  if applied is False: raise Exception("editable text write returned false")
 except Exception as editable_error:
  try: target.queryValue().currentValue=value
  except Exception as value_error: raise Exception("set_value failed: editable=%s; value=%s"%(editable_error,value_error))
elif action=="set_range_value":
 target.queryValue().currentValue=float(value)
elif action in ("expand","collapse"):
 actions=target.queryAction();chosen=-1
 for i in range(actions.nActions):
  try:
   action_name=(actions.getName(i) or "").lower()
   if action in action_name: chosen=i;break
  except: pass
 if chosen<0: raise Exception(action+" accessibility action unavailable")
 actions.doAction(chosen)
elif action=="scroll_into_view":
 component=target.queryComponent()
 try: component.scrollTo(pyatspi.SCROLL_ANYWHERE)
 except:
  if not component.grabFocus(): raise Exception("scroll-to-view unavailable")
elif action in ("add_to_selection","remove_from_selection"):
 parent=target.parent
 if parent is None: raise Exception("selection parent unavailable")
 selection=parent.querySelection();idx=target.getIndexInParent()
 if action=="add_to_selection":
  if not selection.selectChild(idx): raise Exception("could not add item to selection")
 else:
  if not selection.deselectChild(idx): raise Exception("could not remove item from selection")
out={"action":action,"name":target.name or "","role":target.getRoleName(),**target_meta}
if pointer_fallback is not None: out["pointer_fallback"]=pointer_fallback
print(json.dumps(out))`;
  const result = await runFile('python3', ['-c', script], { label: 'AT-SPI action', timeout: 30_000, allowFailure: true });
  let payload = null;
  try { payload = JSON.parse(result.stdout || ''); } catch {}
  if (payload?.pointer_fallback) {
    const fallback = payload.pointer_fallback;
    const x = Number(fallback.x), y = Number(fallback.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) unavailable('Linux accessibility action', 'coordinate fallback returned invalid screen bounds');
    await pointer({ action:'click', x, y, ...(args.backend ? { backend:args.backend } : {}) });
    return jsonResult({
      action,
      id:id || null,
      name:payload.name || '',
      role:payload.role || '',
      backend:'pointer_fallback',
      x,
      y,
      fallback_reason:String(fallback.reason || 'accessibility action unavailable').slice(0, 500),
    });
  }
  if (payload && !payload.error) return text(JSON.stringify(payload));
  if (payload?.error) unavailable('Linux accessibility action', payload.error);
  if (result.code !== 0) {
    const detail = String(result.stderr || result.stdout || 'AT-SPI action failed').trim().split(/\r?\n/).filter(Boolean).at(-1) || 'AT-SPI action failed';
    unavailable('Linux accessibility action', detail);
  }
  return text(result.stdout.trim());
}

async function confirmClipboard(expected, backend, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = backend === 'wl-copy'
      ? await runFile('wl-paste', ['--no-newline'], { label: 'clipboard verify', allowFailure: true, timeout: 500 })
      : await runFile('xclip', ['-selection','clipboard','-o'], { label: 'clipboard verify', allowFailure: true, timeout: 500 });
    if (result.code === 0 && result.stdout === expected) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`${backend} did not publish the requested clipboard text within ${timeoutMs} ms`);
}

export async function clipboard(args = {}) {
  const action = requireEnum(args.action, 'action', ['read','write','clear']);
  if (action !== 'read') {
    const value = action === 'clear' ? '' : String(args.text ?? args.value ?? '');
    const failures = [];
    if (commandExists('wl-copy')) {
      try {
        if (action === 'clear') await runFile('wl-copy', ['--clear'], { label: 'clipboard clear', timeout: 3000 });
        else {
          await spawnDetachedWithInput('wl-copy', [], value, { label: 'clipboard write', timeout: 3000 });
          if (commandExists('wl-paste')) await confirmClipboard(value, 'wl-copy');
        }
        return jsonResult({ action, length: value.length, backend: 'wl-copy' });
      } catch (error) { failures.push(`wl-copy: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (commandExists('xclip')) {
      try {
        await spawnDetachedWithInput('xclip', ['-selection','clipboard','-loops','0'], value, { label: 'clipboard write', timeout: 3000 });
        await confirmClipboard(value, 'xclip');
        return jsonResult({ action, length: value.length, backend: 'xclip' });
      } catch (error) { failures.push(`xclip: ${error instanceof Error ? error.message : String(error)}`); }
    }
    unavailable('Clipboard write', `${failures.join('; ') || 'install wl-clipboard or xclip'}`);
  }
  const failures = [];
  if (commandExists('wl-paste')) {
    const result = await runFile('wl-paste', ['--no-newline'], { label: 'clipboard read', allowFailure: true, timeout: 3000 });
    if (result.code === 0) return text(result.stdout);
    failures.push(`wl-paste: ${(result.stderr || result.stdout || `exit ${result.code}`).trim()}`);
  }
  if (commandExists('xclip')) {
    const result = await runFile('xclip', ['-selection','clipboard','-o'], { label: 'clipboard read', allowFailure: true, timeout: 3000 });
    if (result.code === 0) return text(result.stdout);
    failures.push(`xclip: ${(result.stderr || result.stdout || `exit ${result.code}`).trim()}`);
  }
  unavailable('Clipboard read', `${failures.join('; ') || 'install wl-clipboard or xclip'}`);
}

export async function typeTextWindowTarget(value, args = {}) {
  const row = await windowMatch(args);
  if (!row?.pid) return null;
  const snapshot = await uiSnapshot({
    pid:row.pid,
    window_title:row.title || undefined,
    max_nodes:2200,
    max_depth:24,
  });
  let payload = null;
  try { payload = JSON.parse(snapshot.content?.[0]?.text || '{}'); } catch {}
  const nodes = Array.isArray(payload) ? payload : payload?.nodes || [];
  const editableRoles = /(^|\b)(text|entry|textbox|edit|text field|search box|password text)(\b|$)/i;
  const candidates = nodes.filter(node => node?.id && editableRoles.test(String(node.role || '')));
  if (candidates.length !== 1) return null;

  const target = candidates[0];
  const result = await uiAction({ action:'set_value', id:target.id, value:String(value) });
  let action = result.content?.[0]?.text || '';
  try { action = JSON.parse(action); } catch {}
  return {
    id:target.id,
    pid:row.pid,
    app:row.app || target.app || '',
    window:row.title || target.window || '',
    role:target.role || '',
    name:target.name || '',
    action,
  };
}

export async function typeTextFocused(value) {
  if (!commandExists('python3')) return null;
  const script = String.raw`import gi,json,sys
gi.require_version("Atspi","2.0")
from gi.repository import Atspi
value=sys.argv[1]
desktop=Atspi.get_desktop(0)
active=[];showing=[]
for i in range(desktop.get_child_count()):
 app=desktop.get_child_at_index(i)
 try:
  states=app.get_state_set()
  if states.contains(Atspi.StateType.ACTIVE): active.append(app);continue
  visible=states.contains(Atspi.StateType.SHOWING)
  if not visible:
   for j in range(app.get_child_count()):
    child=app.get_child_at_index(j);child_states=child.get_state_set()
    if child_states.contains(Atspi.StateType.ACTIVE):
     active.append(app);visible=False;break
    if child_states.contains(Atspi.StateType.SHOWING):visible=True
  if visible:showing.append(app)
 except Exception: pass
queue=list(active or showing)
seen=0;target=None
while queue and seen<12000:
 a=queue.pop(0);seen+=1
 try:
  states=a.get_state_set()
  if states.contains(Atspi.StateType.FOCUSED) and states.contains(Atspi.StateType.EDITABLE) and a.get_editable_text_iface() is not None:
   target=a;break
  for i in range(a.get_child_count()): queue.append(a.get_child_at_index(i))
 except Exception: pass
if target is None:
 print(json.dumps({"ok":False,"reason":"no focused editable accessibility element"}));sys.exit(3)
try:
 pos=max(0,int(target.get_caret_offset()))
 selections=target.get_text_selections() or []
 if selections:
  selection=selections[0]
  if selection.start_object==target and selection.end_object==target and selection.end_offset>selection.start_offset:
   if not target.delete_text(selection.start_offset,selection.end_offset): raise RuntimeError("could not replace current selection")
   pos=int(selection.start_offset)
 ok=bool(target.insert_text(pos,value,len(value)))
 print(json.dumps({"ok":ok,"role":target.get_role_name(),"name":target.get_name() or "","pid":target.get_process_id(),"inserted":len(value)}))
 sys.exit(0 if ok else 4)
except Exception as exc:
 print(json.dumps({"ok":False,"reason":str(exc)}));sys.exit(5)`;
  const result = await runFile('python3', ['-c', script, String(value)], {
    label: 'AT-SPI focused text input',
    allowFailure: true,
    timeout: 5000,
  });
  if (result.code !== 0) return null;
  try {
    const payload = JSON.parse(result.stdout || '{}');
    return payload.ok ? payload : null;
  } catch { return null; }
}

function normalizeShortcut(shortcut) {
  return shortcut.toLowerCase().replace(/cmd|command|meta/g, 'super').replace(/control/g, 'ctrl');
}

function inputBackend(args = {}) {
  return requireEnum(args.backend || 'auto', 'backend', ['auto','x11','portal']);
}

function portalPermissionHint(feature) {
  unavailable(feature, 'one-time XDG RemoteDesktop permission has not been granted; retry with backend=portal to request it');
}

export async function keyboard(args = {}) {
  const shortcut = optionalString(args.shortcut) || (Array.isArray(args.keys) ? args.keys.join('+') : optionalString(args.key));
  if (!shortcut) throw new Error('shortcut or key is required');
  const backend = inputBackend(args);
  const wtypeArgs = () => {
    const tokens = normalizeShortcut(shortcut).split('+').filter(Boolean);
    const modifiers = tokens.slice(0,-1).map(v => ({ctrl:'ctrl',alt:'alt',shift:'shift',super:'logo'}[v])).filter(Boolean);
    const key = tokens.at(-1);
    const argv = [];
    for (const mod of modifiers) argv.push('-M', mod);
    argv.push('-P', key, '-p', key);
    for (const mod of [...modifiers].reverse()) argv.push('-m', mod);
    return argv;
  };
  if (isWaylandSession()) {
    await focusExplicitWaylandInputTarget(args);
    if (backend !== 'portal' && commandExists('wtype')) {
      const result = await runFile('wtype', wtypeArgs(), { label: 'keyboard', allowFailure: true, timeout: 5000 });
      if (result.code === 0) return text(`Sent ${shortcut} via wtype.`);
    }
    if (backend === 'portal') {
      if (!waylandPortalCandidate()) unavailable('Wayland keyboard input', 'no XDG RemoteDesktop portal is available');
      await portalShortcut(shortcut, { timeoutMs: 120_000 });
      return text(`Sent ${shortcut} via the Wayland Remote Desktop portal.`);
    }
    if (backend === 'auto' && hasWaylandRemoteDesktopGrant()) {
      try {
        await portalShortcut(shortcut, { timeoutMs: 2500 });
        return text(`Sent ${shortcut} via the Wayland Remote Desktop portal.`);
      } catch {}
    }
    if (backend === 'auto' && waylandPortalCandidate()) portalPermissionHint('Wayland keyboard input');
    unavailable('Wayland keyboard input', backend === 'x11'
      ? 'XTEST/xdotool keyboard events are not reliably delivered through GNOME Wayland; use backend=portal or semantic accessibility input'
      : 'no working keyboard backend is available');
  }
  if (commandExists('xdotool')) {
    const windowId = await inputWindowId(args);
    if (windowId) await focusInputWindow(windowId);
    await runFile('xdotool', ['key','--clearmodifiers',...(windowId ? ['--window',windowId] : []),normalizeShortcut(shortcut)], { label: 'keyboard' });
    return text(`Sent ${shortcut}${windowId ? ` to ${windowId}` : ''}.`);
  }
  if (commandExists('wtype')) {
    await runFile('wtype', wtypeArgs(), { label: 'keyboard' });
    return text(`Sent ${shortcut}.`);
  }
  unavailable('Keyboard input', 'install xdotool or wtype');
}

export async function typeTextKeys(value, args = {}) {
  const delay = clamp(args.delay_ms, 1, 0, 1000);
  const backend = inputBackend(args);
  if (isWaylandSession()) {
    await focusExplicitWaylandInputTarget(args);
    if (backend !== 'portal' && commandExists('wtype')) {
      const result = await runFile('wtype', ['-d', String(delay), '--', String(value)], { label: 'type text', timeout: 30_000, allowFailure: true });
      if (result.code === 0) return { ...result, backend: 'wtype' };
    }
    if (backend === 'portal') {
      if (!waylandPortalCandidate()) unavailable('Wayland text input', 'no XDG RemoteDesktop portal is available');
      await portalTypeText(String(value), { delayMs: delay, timeoutMs: 120_000 });
      return { stdout: '', stderr: '', code: 0, backend: 'xdg-desktop-portal' };
    }
    if (backend === 'auto' && hasWaylandRemoteDesktopGrant()) {
      try {
        await portalTypeText(String(value), { delayMs: delay, timeoutMs: 2500 });
        return { stdout: '', stderr: '', code: 0, backend: 'xdg-desktop-portal' };
      } catch {}
    }
    if (backend === 'auto' && waylandPortalCandidate()) portalPermissionHint('Wayland text input');
    unavailable('Wayland text input', backend === 'x11'
      ? 'XTEST/xdotool text input is not reliably delivered through GNOME Wayland; use semantic accessibility typing or backend=portal'
      : 'no working text input backend is available');
  }
  if (commandExists('xdotool')) {
    const windowId = await inputWindowId(args);
    if (windowId) await focusInputWindow(windowId);
    const result = await runFile('xdotool', ['type','--clearmodifiers','--delay',String(delay),...(windowId ? ['--window',windowId] : []),String(value)], { label: 'type text', timeout: 30_000 });
    return { ...result, backend: windowId ? 'xdotool-targeted' : 'xdotool' };
  }
  if (commandExists('wtype')) return runFile('wtype', ['-d', String(delay), '--', String(value)], { label: 'type text', timeout: 30_000 });
  unavailable('Text input', 'install wtype or xdotool');
}

function buttonNumber(button) {
  return String(button || 'left').toLowerCase() === 'right' ? '3' : String(button || 'left').toLowerCase() === 'middle' ? '2' : '1';
}

let portalPointerState = null;

async function portalDesktopAnchor() {
  const rows = JSON.parse((await displayInventory()).content?.[0]?.text || '[]');
  const displays = Array.isArray(rows) ? rows.filter(row =>
    Number.isFinite(Number(row.x)) && Number.isFinite(Number(row.y))
    && Number.isFinite(Number(row.width)) && Number.isFinite(Number(row.height))
  ) : [];
  if (!displays.length) return { x:0, y:0 };
  const left = Math.min(...displays.map(row => Number(row.x)));
  const top = Math.min(...displays.map(row => Number(row.y)));
  return { x:left, y:top };
}

async function calibratePortalPointer(options = {}) {
  const motionOptions = { ...options };
  delete motionOptions.recalibrate;
  await portalPointerMotion(-100000, -100000, motionOptions);
  portalPointerState = await portalDesktopAnchor();
}

async function portalMoveTo(x, y, options = {}) {
  const targetX = Math.trunc(Number(x));
  const targetY = Math.trunc(Number(y));
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) throw new Error('x and y must be finite coordinates');
  const motionOptions = { ...options };
  delete motionOptions.recalibrate;
  try {
    await portalPointerMotionAbsolute(targetX, targetY, motionOptions);
    portalPointerState = { x:targetX, y:targetY };
    return;
  } catch (error) {
    if (!/requires the EIS Remote Desktop backend/i.test(String(error?.message || error))) throw error;
  }
  // Legacy portal fallback: relative motion has no absolute position feedback,
  // so recalibrate on every move instead of trusting cached coordinates.
  await calibratePortalPointer(motionOptions);
  await portalPointerMotion(targetX - portalPointerState.x, targetY - portalPointerState.y, motionOptions);
  portalPointerState = { x:targetX, y:targetY };
}

export async function pointer(args = {}) {
  const action = requireEnum(args.action, 'action', ['move','click','double_click','right_click','down','up']);
  const x = Number(args.x), y = Number(args.y);
  const buttonName = action === 'right_click' ? 'right' : String(args.button || 'left').toLowerCase();
  const backend = inputBackend(args);

  const runXdotool = async () => {
    if (!commandExists('xdotool')) return false;
    const argv = [];
    if (Number.isFinite(x) && Number.isFinite(y)) argv.push('mousemove', String(Math.trunc(x)), String(Math.trunc(y)));
    else if (action === 'move') throw new Error('x and y are required for pointer move');
    const button = buttonNumber(buttonName);
    if (action === 'click' || action === 'right_click') argv.push('click', button);
    else if (action === 'double_click') argv.push('click','--repeat','2','--delay','70',button);
    else if (action === 'down') argv.push('mousedown', button);
    else if (action === 'up') argv.push('mouseup', button);
    await runFile('xdotool', argv, { label: 'pointer' });
    return true;
  };

  const runPortal = async timeoutMs => {
    const portalOptions = { timeoutMs };
    if (Number.isFinite(x) && Number.isFinite(y)) await portalMoveTo(x, y, portalOptions);
    else if (action === 'move') throw new Error('x and y are required for pointer move');
    const click = async () => {
      await portalPointerButton(buttonName, true, portalOptions);
      // A zero-duration press/release can be accepted by the portal transport but
      // coalesced before the target toolkit observes a real click. Keep a short,
      // human-scale hold so successful return means a deliverable button gesture.
      await new Promise(resolve => setTimeout(resolve, 60));
      await portalPointerButton(buttonName, false, portalOptions);
      await new Promise(resolve => setTimeout(resolve, 40));
    };
    if (action === 'click' || action === 'right_click') await click();
    else if (action === 'double_click') {
      await click();
      await new Promise(resolve => setTimeout(resolve, 70));
      await click();
    } else if (action === 'down') await portalPointerButton(buttonName, true, portalOptions);
    else if (action === 'up') {
      await portalPointerButton(buttonName, false, portalOptions);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  };

  if (isWaylandSession()) {
    if (backend === 'portal') {
      if (!waylandPortalCandidate()) unavailable('Wayland pointer control', 'no XDG RemoteDesktop portal is available');
      await runPortal(120_000);
      return text(`Pointer ${action} completed via the Wayland Remote Desktop portal.`);
    }
    if (backend === 'auto' && hasWaylandRemoteDesktopGrant()) {
      try {
        await runPortal(2500);
        return text(`Pointer ${action} completed via the Wayland Remote Desktop portal.`);
      } catch {}
    }
    if (backend !== 'portal' && await runXdotool()) return text(`Pointer ${action} completed via XWayland xdotool.`);
    if (backend === 'auto' && waylandPortalCandidate()) portalPermissionHint('Wayland pointer control');
    unavailable('Wayland pointer control', backend === 'x11' ? 'xdotool is unavailable' : 'no working pointer backend is available');
  }

  if (await runXdotool()) return text(`Pointer ${action} completed.`);
  unavailable('Pointer control', 'install xdotool');
}

export async function dragDrop(args = {}) {
  const backend = inputBackend(args);
  const runXdotool = async () => {
    if (!commandExists('xdotool')) return false;
    const button = buttonNumber(args.button);
    await runFile('xdotool', [
      'mousemove',String(Math.trunc(args.from_x)),String(Math.trunc(args.from_y)),
      'mousedown',button,
      'mousemove','--sync',String(Math.trunc(args.to_x)),String(Math.trunc(args.to_y)),
      'mouseup',button,
    ], { label: 'drag and drop' });
    return true;
  };
  const runPortal = async timeoutMs => {
    const button = String(args.button || 'left').toLowerCase();
    const portalOptions = { timeoutMs };
    const fromX = Number(args.from_x), fromY = Number(args.from_y);
    const toX = Number(args.to_x), toY = Number(args.to_y);
    await portalMoveTo(fromX, fromY, portalOptions);
    // Give the compositor/toolkit one frame to observe the source position before
    // button-down. A transport ACK only proves that the portal accepted the event.
    await new Promise(resolve => setTimeout(resolve, 60));
    await portalPointerButton(button, true, portalOptions);
    await new Promise(resolve => setTimeout(resolve, clamp(args.hold_ms, 120, 60, 5000)));

    // Keep the pressed pointer on a single absolute-motion transition. Repeated
    // absolute moves can cross EIS region/device contexts and lose the logical
    // pressed state. The EIS helper converts the desktop target into region-local
    // coordinates, so one target move is sufficient and preserves buttons=1.
    await portalMoveTo(toX, toY, portalOptions);
    await new Promise(resolve => setTimeout(resolve, clamp(args.duration_ms, 160, 80, 5000)));
    // Reassert the final target immediately before release. On Mutter/XWayland this
    // mirrors a real pointer-up gesture and ensures the release is delivered as a
    // pointerup/mouseup at the dragged target instead of only clearing button state.
    await portalMoveTo(toX, toY, portalOptions);
    await new Promise(resolve => setTimeout(resolve, 40));
    await portalPointerButton(button, false, portalOptions);
    await new Promise(resolve => setTimeout(resolve, 80));
  };
  if (isWaylandSession()) {
    if (backend === 'portal') {
      if (!waylandPortalCandidate()) unavailable('Wayland drag and drop', 'no XDG RemoteDesktop portal is available');
      await runPortal(120_000);
      return jsonResult({ from:[args.from_x,args.from_y], to:[args.to_x,args.to_y], backend:'xdg-desktop-portal' });
    }
    if (backend === 'auto' && hasWaylandRemoteDesktopGrant()) {
      try {
        await runPortal(2500);
        return jsonResult({ from:[args.from_x,args.from_y], to:[args.to_x,args.to_y], backend:'xdg-desktop-portal' });
      } catch {}
    }
    if (backend === 'x11') {
      unavailable('Wayland drag and drop', 'XTEST/xdotool drag events are not reliably delivered through GNOME Wayland; use backend=portal');
    }
    if (backend === 'auto' && waylandPortalCandidate()) portalPermissionHint('Wayland drag and drop');
    unavailable('Wayland drag and drop', 'no working consent-backed drag backend is available');
  }
  if (await runXdotool()) return jsonResult({ from:[args.from_x,args.from_y], to:[args.to_x,args.to_y], backend:'xdotool' });
  unavailable('Drag and drop', 'install xdotool');
}

export async function scroll(args = {}) {
  const dx = Number(args.delta_x || 0), dy = Number(args.delta_y ?? args.delta ?? 0);
  const backend = inputBackend(args);
  const runXdotool = async () => {
    if (!commandExists('xdotool')) return false;
    if (dy) {
      const button = dy < 0 ? '4' : '5';
      const repeats = Math.max(1, Math.min(50, Math.ceil(Math.abs(dy) / 120)));
      await runFile('xdotool', ['click','--repeat',String(repeats),button], { label: 'vertical scroll' });
    }
    if (dx) {
      const button = dx < 0 ? '6' : '7';
      const repeats = Math.max(1, Math.min(50, Math.ceil(Math.abs(dx) / 120)));
      await runFile('xdotool', ['click','--repeat',String(repeats),button], { label: 'horizontal scroll' });
    }
    return true;
  };
  if (isWaylandSession()) {
    if (backend === 'portal') {
      if (!waylandPortalCandidate()) unavailable('Wayland scroll', 'no XDG RemoteDesktop portal is available');
      await portalScroll(dx, dy, { timeoutMs: 120_000 });
      return jsonResult({ delta_x: dx, delta_y: dy, backend:'xdg-desktop-portal' });
    }
    if (backend === 'auto' && hasWaylandRemoteDesktopGrant()) {
      try {
        await portalScroll(dx, dy, { timeoutMs: 2500 });
        return jsonResult({ delta_x: dx, delta_y: dy, backend:'xdg-desktop-portal' });
      } catch {}
    }
    if (backend !== 'portal' && await runXdotool()) return jsonResult({ delta_x: dx, delta_y: dy, backend:'xwayland-xdotool' });
    if (backend === 'auto' && waylandPortalCandidate()) portalPermissionHint('Wayland scroll');
    unavailable('Wayland scroll', backend === 'x11' ? 'xdotool is unavailable' : 'no working scroll backend is available');
  }
  if (await runXdotool()) return jsonResult({ delta_x: dx, delta_y: dy, backend:'xdotool' });
  unavailable('Scroll', 'install xdotool');
}

export async function cursorPosition() {
  if (isWaylandSession()) {
    unavailable('Cursor position', 'native Wayland does not expose an authoritative global cursor position; XWayland xdotool coordinates may be stale');
  }
  if (!commandExists('xdotool')) unavailable('Cursor position', 'install xdotool');
  const result = await runFile('xdotool', ['getmouselocation','--shell'], { label:'cursor position', allowFailure:true, timeout:2000 });
  const x = Number(result.stdout.match(/^X=(-?\d+)$/m)?.[1]);
  const y = Number(result.stdout.match(/^Y=(-?\d+)$/m)?.[1]);
  const screen = Number(result.stdout.match(/^SCREEN=(-?\d+)$/m)?.[1]);
  if (result.code !== 0 || !Number.isFinite(x) || !Number.isFinite(y)) unavailable('Cursor position', (result.stderr || result.stdout || 'xdotool failed').trim());
  return jsonResult({ x, y, screen: Number.isFinite(screen) ? screen : null });
}

function unwrapDbus(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'value')) return unwrapDbus(value.value);
  if (Array.isArray(value)) return value.map(unwrapDbus);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrapDbus(item)]));
  return value;
}

async function mutterDisplayInventory() {
  if (!isWaylandSession()) return null;
  let dbus;
  try { dbus = await import('@jellybrick/dbus-next'); } catch { return null; }
  const bus = dbus.sessionBus();
  try {
    const object = await bus.getProxyObject('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig');
    const iface = object.getInterface('org.gnome.Mutter.DisplayConfig');
    const state = unwrapDbus(await iface.GetCurrentState());
    if (!Array.isArray(state) || state.length < 3) return null;
    const monitors = Array.isArray(state[1]) ? state[1] : [];
    const logical = Array.isArray(state[2]) ? state[2] : [];
    const monitorByKey = new Map();
    for (const monitor of monitors) {
      const spec = Array.isArray(monitor?.[0]) ? monitor[0] : [];
      const modes = Array.isArray(monitor?.[1]) ? monitor[1] : [];
      const props = monitor?.[2] && typeof monitor[2] === 'object' ? monitor[2] : {};
      const current = modes.find(mode => mode?.[6]?.['is-current'] === true)
        || modes.find(mode => mode?.[6]?.['is-preferred'] === true)
        || modes[0];
      monitorByKey.set(JSON.stringify(spec), {
        connector: String(spec[0] || ''),
        vendor: String(spec[1] || ''),
        product: String(spec[2] || ''),
        serial: String(spec[3] || ''),
        display_name: String(props['display-name'] || spec[0] || 'Display'),
        builtin: Boolean(props['is-builtin']),
        mode: current ? {
          width: Number(current[1]) || null,
          height: Number(current[2]) || null,
          refresh_hz: Number(current[3]) || null,
        } : null,
      });
    }
    const rows = [];
    for (const item of logical) {
      if (!Array.isArray(item) || item.length < 6) continue;
      const x = Number(item[0]), y = Number(item[1]), scale = Number(item[2]) || 1;
      const transform = Number(item[3]) || 0;
      const primary = Boolean(item[4]);
      const specs = Array.isArray(item[5]) ? item[5] : [];
      for (const spec of specs) {
        const details = monitorByKey.get(JSON.stringify(spec)) || {
          connector: String(spec?.[0] || ''),
          vendor: String(spec?.[1] || ''),
          product: String(spec?.[2] || ''),
          serial: String(spec?.[3] || ''),
          display_name: String(spec?.[0] || 'Display'),
          mode: null,
        };
        const pixelWidth = Number(details.mode?.width) || null;
        const pixelHeight = Number(details.mode?.height) || null;
        const rotated = [1,3,5,7].includes(transform);
        rows.push({
          name: details.connector || details.display_name,
          display_name: details.display_name,
          primary,
          x: Number.isFinite(x) ? x : null,
          y: Number.isFinite(y) ? y : null,
          width: pixelWidth == null ? null : Math.round((rotated ? pixelHeight : pixelWidth) / scale),
          height: pixelHeight == null ? null : Math.round((rotated ? pixelWidth : pixelHeight) / scale),
          pixel_width: pixelWidth,
          pixel_height: pixelHeight,
          scale,
          refresh_hz: details.mode?.refresh_hz ?? null,
          transform,
          builtin: Boolean(details.builtin),
          vendor: details.vendor || null,
          product: details.product || null,
          serial: details.serial || null,
          backend: 'mutter',
        });
      }
    }
    return rows.length ? rows : null;
  } catch {
    return null;
  } finally {
    try { bus.disconnect(); } catch {}
  }
}

export async function displayInventory() {
  const mutter = await mutterDisplayInventory();
  if (mutter) return jsonResult(mutter);
  if (!commandExists('xrandr')) unavailable('Display inventory', 'GNOME Mutter DisplayConfig or xrandr is required');
  const { stdout } = await runFile('xrandr', ['--query'], { label: 'display inventory' });
  let scale = Number(process.env.GDK_SCALE || process.env.QT_SCALE_FACTOR || 0);
  if (!Number.isFinite(scale) || scale <= 0) scale = 0;
  if (!scale && commandExists('gsettings')) {
    const probe = await runFile('gsettings', ['get','org.gnome.desktop.interface','scaling-factor'], { label:'display scale', allowFailure:true, timeout:1500 });
    const parsed = Number(String(probe.stdout || '').match(/(\d+(?:\.\d+)?)/)?.[1]);
    if (Number.isFinite(parsed) && parsed > 0) scale = parsed;
  }
  if (!scale) scale = 1;
  const rows = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/^(\S+) connected( primary)?(?: (\d+)x(\d+)\+(-?\d+)\+(-?\d+))?/);
    if (match) rows.push({ name:match[1], display_name:match[1], primary:Boolean(match[2]), width:match[3]?Number(match[3]):null, height:match[4]?Number(match[4]):null, pixel_width:match[3]?Number(match[3]):null, pixel_height:match[4]?Number(match[4]):null, x:match[5]?Number(match[5]):null, y:match[6]?Number(match[6]):null, scale, backend:'xrandr' });
  }
  return jsonResult(rows);
}

async function pngDimensions(file) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(24);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead < buffer.length || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (!width || !height) return null;
    return { width, height };
  } finally {
    await handle.close();
  }
}

export function regionScreenshotBackends({
  wayland = isWaylandSession(),
  grim = commandExists('grim'),
  gnomeScreenshot = commandExists('gnome-screenshot'),
  ffmpeg = commandExists('ffmpeg'),
  imagemagick = commandExists('import'),
} = {}) {
  const backends = [];
  if (grim) backends.push('grim');
  if (wayland) {
    if (gnomeScreenshot && ffmpeg) backends.push('gnome-screenshot');
    if (ffmpeg) backends.push('portal');
  } else if (imagemagick) {
    backends.push('imagemagick');
  }
  return backends;
}

export function portalCropGeometry(rect, displays = [], bitmap = null) {
  const requested = {
    x: Math.trunc(Number(rect?.x)),
    y: Math.trunc(Number(rect?.y)),
    width: Math.trunc(Number(rect?.width)),
    height: Math.trunc(Number(rect?.height)),
  };
  if (![requested.x,requested.y,requested.width,requested.height].every(Number.isFinite)
      || requested.width <= 0 || requested.height <= 0) {
    throw new Error('portal crop requires a finite positive rectangle');
  }
  const visibleDisplays = Array.isArray(displays) ? displays.filter(item => {
    const x = Number(item?.x), y = Number(item?.y), width = Number(item?.width), height = Number(item?.height);
    return [x,y,width,height].every(Number.isFinite) && width > 0 && height > 0;
  }) : [];
  const bitmapWidth = Math.trunc(Number(bitmap?.width));
  const bitmapHeight = Math.trunc(Number(bitmap?.height));
  const hasBitmap = Number.isFinite(bitmapWidth) && bitmapWidth > 0 && Number.isFinite(bitmapHeight) && bitmapHeight > 0;

  let minX = 0, minY = 0;
  let maxX = hasBitmap ? bitmapWidth : requested.x + requested.width;
  let maxY = hasBitmap ? bitmapHeight : requested.y + requested.height;
  if (visibleDisplays.length) {
    minX = Math.min(...visibleDisplays.map(item => Number(item.x)));
    minY = Math.min(...visibleDisplays.map(item => Number(item.y)));
    maxX = Math.max(...visibleDisplays.map(item => Number(item.x) + Number(item.width)));
    maxY = Math.max(...visibleDisplays.map(item => Number(item.y) + Number(item.height)));
  }
  const left = Math.max(requested.x, minX);
  const top = Math.max(requested.y, minY);
  const right = Math.min(requested.x + requested.width, maxX);
  const bottom = Math.min(requested.y + requested.height, maxY);
  if (right <= left || bottom <= top) throw new Error('screenshot region is outside visible desktop bounds');

  const virtualWidth = maxX - minX;
  const virtualHeight = maxY - minY;
  const scaleX = hasBitmap && virtualWidth > 0 ? bitmapWidth / virtualWidth : 1;
  const scaleY = hasBitmap && virtualHeight > 0 ? bitmapHeight / virtualHeight : 1;
  const x = Math.max(0, Math.floor((left - minX) * scaleX));
  const y = Math.max(0, Math.floor((top - minY) * scaleY));
  const sourceRight = hasBitmap
    ? Math.min(bitmapWidth, Math.ceil((right - minX) * scaleX))
    : Math.ceil((right - minX) * scaleX);
  const sourceBottom = hasBitmap
    ? Math.min(bitmapHeight, Math.ceil((bottom - minY) * scaleY))
    : Math.ceil((bottom - minY) * scaleY);
  const width = sourceRight - x;
  const height = sourceBottom - y;
  if (width <= 0 || height <= 0) throw new Error('screenshot region has no visible portal pixels');

  return {
    x, y, width, height,
    visible: { x:left, y:top, width:right-left, height:bottom-top },
    clipped: left !== requested.x || top !== requested.y
      || right !== requested.x + requested.width || bottom !== requested.y + requested.height,
  };
}

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
