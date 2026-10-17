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


import { focusInputWindow, inputWindowId, windowMatch } from './desktop-linux-windows.mjs';
import { focusExplicitWaylandInputTarget } from './desktop-linux-window-actions.mjs';
import { uiAction, uiSnapshot } from './desktop-linux-ui.mjs';
import { displayInventory } from './desktop-linux-displays.mjs';

export async function confirmClipboard(expected, backend, timeoutMs = 1500) {
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

export function normalizeShortcut(shortcut) {
  return shortcut.toLowerCase().replace(/cmd|command|meta/g, 'super').replace(/control/g, 'ctrl');
}

export function inputBackend(args = {}) {
  return requireEnum(args.backend || 'auto', 'backend', ['auto','x11','portal']);
}

export function portalPermissionHint(feature) {
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

export function buttonNumber(button) {
  return String(button || 'left').toLowerCase() === 'right' ? '3' : String(button || 'left').toLowerCase() === 'middle' ? '2' : '1';
}

let portalPointerState = null;

export async function portalDesktopAnchor() {
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

export async function calibratePortalPointer(options = {}) {
  const motionOptions = { ...options };
  delete motionOptions.recalibrate;
  await portalPointerMotion(-100000, -100000, motionOptions);
  portalPointerState = await portalDesktopAnchor();
}

export async function portalMoveTo(x, y, options = {}) {
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
