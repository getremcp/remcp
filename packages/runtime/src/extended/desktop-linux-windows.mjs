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


import { uiSnapshot } from './desktop-linux-ui.mjs';

export function parseWindows(stdout) {
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

export async function x11PixelBounds(id) {
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

export function windowSelector(args = {}) {
  return {
    id: optionalString(args.id || args.window_id || args.windowId),
    pid: Number.isInteger(Number(args.pid)) ? Number(args.pid) : null,
    app: optionalString(args.app),
    title: optionalString(args.title || args.window_title || args.windowTitle),
  };
}

export function windowMatchesSelector(item, selector) {
  return (!selector.id || item.id === selector.id || item.wm_id === selector.id || item.ui_id === selector.id)
    && (selector.pid == null || Number(item.pid) === selector.pid)
    && (!selector.app || String(item.app || '').toLowerCase().includes(selector.app.toLowerCase()))
    && (!selector.title || String(item.title || '').toLowerCase().includes(selector.title.toLowerCase()));
}

export async function fastX11WindowMatch(args) {
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

export async function windowMatch(args) {
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

export async function focusedAccessibilityContext() {
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

export async function focusedAccessibilityPid() {
  return Number((await focusedAccessibilityContext())?.pid) || null;
}

export async function targetAccessibilityFocus(row) {
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

export async function inputWindowId(args = {}) {
  const explicit = Boolean(args.window_id || args.windowId || args.id || args.pid != null || args.app || args.title || args.window_title || args.windowTitle);
  if (explicit) return (await windowMatch(args)).wm_id || null;
  if (!isWaylandSession()) return null;
  const pid = await focusedAccessibilityPid();
  if (!pid) return null;
  try { return (await windowMatch({ pid })).wm_id || null; } catch { return null; }
}

export async function focusInputWindow(windowId) {
  if (!windowId || !commandExists('wmctrl')) return;
  const result = await runFile('wmctrl', ['-ia', windowId], { label:'input window focus', allowFailure:true, timeout:2000 });
  if (result.code === 0) await new Promise(resolve => setTimeout(resolve, 40));
}

export function explicitInputWindowSelector(args = {}) {
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
