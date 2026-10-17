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


import { listWindows, targetAccessibilityFocus, windowMatch } from './desktop-linux-windows.mjs';
import { nativeWaylandWindowAction } from './desktop-linux-window-actions.mjs';
import { inputBackend, pointer, portalPermissionHint, scroll } from './desktop-linux-input.mjs';

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

export function pyAtSpiPrelude() {
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
 already_focused=False
 try: already_focused=bool(target.getState().contains(pyatspi.STATE_FOCUSED))
 except: pass
 if not already_focused:
  try:
   if target.queryComponent().grabFocus() is False: raise Exception("focus accessibility action returned false")
  except Exception as focus_error:
   try:
    if not target.getState().contains(pyatspi.STATE_FOCUSED): raise focus_error
   except Exception:
    raise focus_error
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
