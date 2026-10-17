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


import { explicitInputWindowSelector, targetAccessibilityFocus, windowMatch } from './desktop-linux-windows.mjs';
import { pyAtSpiPrelude, windowAction } from './desktop-linux-ui.mjs';
import { dragDrop, inputBackend, portalPermissionHint } from './desktop-linux-input.mjs';
import { displayInventory } from './desktop-linux-displays.mjs';

export async function focusExplicitWaylandInputTarget(args = {}) {
  const selector = explicitInputWindowSelector(args);
  if (!selector) return null;
  const row = await windowMatch(selector);
  await windowAction({ action:'focus', id:row.id, backend:inputBackend(args) });
  return row;
}

export function nativeWaylandGeometryMatches(row, expected = {}, tolerance = 24) {
  for (const key of ['x','y','width','height']) {
    if (expected[key] == null) continue;
    const actual = Number(row?.[key]);
    const wanted = Number(expected[key]);
    if (!Number.isFinite(actual) || !Number.isFinite(wanted) || Math.abs(actual - wanted) > tolerance) return false;
  }
  return true;
}

export async function verifyNativeWaylandGeometry(row, expected, label) {
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

export async function nativeWaylandAccessibilityAction(row, actionNames) {
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

export async function verifyNativeWaylandWindowClosed(row, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await windowMatch({ id:row.id }); }
    catch { return; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Could not verify native Wayland window close for ${row.title || row.app || row.id}`);
}

export async function focusNativeWaylandForAction(row, backend) {
  await windowAction({ action:'focus', id:row.id, backend });
  const focusState = await targetAccessibilityFocus(row);
  if (!focusState.exact) throw new Error(`Could not verify native Wayland focus for ${row.title || row.app || row.id}`);
}

export async function nativeWaylandWindowAction(row, action, args) {
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
