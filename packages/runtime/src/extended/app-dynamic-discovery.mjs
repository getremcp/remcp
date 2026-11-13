// Read-only discovery of software installed now or later. Installation is
// never evidence of an approved automation API, executable or GUI window.
import {createHash} from 'node:crypto';
import {installedApps} from './diagnostics-platform.mjs';
import {linuxGuiInventory} from './app-gui-inventory.mjs';
import {windowsGuiInventory,windowsShortcutPidVerified} from './app-windows-startmenu.mjs';
import {macBundlePidVerified} from './app-macos-bundle-process.mjs';
import {listWindows,uiSnapshot,uiAction,resultValue} from './desktop-core.mjs';
import {findAppProfile} from './app-launch-registry.mjs';
import {findWebAppProfile} from './app-web-profiles.mjs';
import {assertWindowsInteractiveDesktop} from './desktop-windows-session.mjs';
import {linuxRegisteredProcessState} from './app-process-preflight.mjs';
import {requireInteractiveGuiSession} from './app-session-guard.mjs';
import {issueControlValueToken,verifyControlValueToken} from './app-control-value-token.mjs';

const normalize=name=>String(name||'').normalize('NFKC').toLowerCase()
  .replace(/\.exe$/,'').replace(/[^\p{L}\p{N}]+/gu,'');
// Avoid collapsing punctuation when verifying process identity.
const sameRunningApp=(installed,running)=>String(installed||'').trim().toLowerCase()===
  String(running||'').trim().toLowerCase().replace(/\.exe$/,'');
const opaqueId=value=>'local-'+createHash('sha256').update(value)
  .digest('hex').slice(0,20);
const identifier=name=>opaqueId(name.trim().toLowerCase());
const safeName=name=>typeof name==='string' && name.length<=180 &&
  !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(name);
const macBundle=row=>typeof row?.path==='string'&&row.path.startsWith('/')&&
  row.path.length<1024&&row.path.endsWith('.app')&&
  !/[\u0000-\u001f\u007f]/u.test(row.path);
function inventoryIdentity(row,{backend}={}){
  if(row?.source==='xdg_desktop_entry'&&safeName(row.desktop_id)&&
    row.desktop_id?.endsWith('.desktop'))
    return opaqueId('xdg:'+row.desktop_id);
  if(backend==='system_profiler'&&macBundle(row))
    return opaqueId('macos:'+row.path);
  if(backend==='windows_startmenu_shortcuts'&&typeof row?.shortcut_id==='string')
    return opaqueId('winlink:'+row.shortcut_id.toLowerCase());
  return identifier(row.name||'');
}

const sensitive=/password|passphrase|passcode|private.?key|secret|api.?key|token|recovery.?code|one.?time.?code|otp|2fa|cvv|credit.?card|secure.?text|security.?code|\bpin\b/i;
const editable=/^(textbox|text field|textfield|entry|edit|search field|searchfield|searchbox)$/i;
const ordinaryText=value=>typeof value==='string'&&value.length<=256&&
  !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
const safeControl=node=>{
  const role=String(node?.role||'').slice(0,70);
  const name=String(node?.name||'').slice(0,180);
  if(!name.trim()||sensitive.test(role)||sensitive.test(name)||
    node?.password===true||node?.protected===true||
    node?.is_password===true||node?.isPassword===true||
    /secure|password/i.test(String(node?.subrole||''))||
    node?.readOnly===true||node?.readonly===true)return null;
  return {role,name,enabled:node.enabled===true,
    ...(typeof node.id==='string'&&node.id.length<=180&&
      !/[\u0000-\u001f\u007f]/u.test(node.id)?{id:node.id}:{})};
};
function previewControl(node,context){
  const safe=safeControl(node);
  if(!safe)return null;
  if(!context||!safe.id||safe.enabled!==true||!editable.test(safe.role)||
    !ordinaryText(node.value))return safe;
  const value_token=issueControlValueToken({...context,
    control_id:safe.id,name:safe.name,role:safe.role,text:node.value});
  return value_token?{...safe,value_token}:safe;
}
export function visibleControlMatches(nodes,query,{pid,app,tokenContext}={}){
  if(typeof query!=='string'||!query.trim()||query.length>256||
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(query))
    throw Error('Visible control lookup requires a safe single-line query');
  const wanted=query.trim().toLocaleLowerCase();
  const matched=[];
  for(const node of Array.isArray(nodes)?nodes:[]){
    if(Number(node?.pid)!==pid||!sameRunningApp(app,node?.app))continue;
    const control=previewControl(node,tokenContext);
    if(control&&control.name.toLocaleLowerCase().includes(wanted))
      matched.push(control);
  }
  return {results:matched.slice(0,20),matches:matched.length,
    truncated:matched.length>20};
}

export function detectedAppRows(records,{filter='',limit=60,backend}={}){
  const search=String(filter).trim().toLowerCase();
  const rows=[],seen=new Set();
  for(const item of records||[]){
    const name=item?.name;
    if(!safeName(name)||!name.trim()||!normalize(name))continue;
    if(search&&!name.toLowerCase().includes(search))continue;
    // A curated profile is already present in the standard catalog.
    if(findAppProfile(name)||findWebAppProfile(name))continue;
    const id=inventoryIdentity(item,{backend});
    if(seen.has(id))continue;
    seen.add(id);
    const gui=item?.source==='xdg_desktop_entry';
    const bundle=backend==='system_profiler'&&macBundle(item);
    const shortcut=backend==='windows_startmenu_shortcuts'&&
      item?.source==='windows_startmenu_shortcut';
    rows.push({id,name,category:'detected',
      installation:gui?'gui_launcher_entry':bundle?'application_bundle':
        shortcut?'start_menu_shortcut':'inventory_record',
      source:gui?'xdg_desktop_entry':bundle?'macos_app_bundle':
        shortcut?'windows_startmenu_shortcut':'native_installed_apps',
      ...(bundle&&safeName(item.version)?{version:item.version}:{}),
      ...(gui&&safeName(item.startup_wm_class)?
        {startup_wm_class:item.startup_wm_class}:{}),
      destinations:[],guide_ids:[],guide_count:0,
      control:'inspect_find_verified_focus_or_single_text_cas',
      note:gui?'An XDG GUI launcher entry; actions still require a verified running window.':
        bundle?'A macOS app bundle; native process executable provenance is mandatory before UI access.':
        shortcut?'A Windows Start Menu shortcut; exact PID executable and interactive UIA provenance required.':
        'An installed software/package record, not verified GUI capabilities.'});
  }
  rows.sort((a,b)=>a.name.localeCompare(b.name));
  return {apps:rows.slice(0,Math.max(1,Math.min(100,limit))),
    total:rows.length,truncated:rows.length>limit};
}

async function nativeInventory(get,options={}){
  const response=await get({limit:10000,refresh:options.refresh===true});
  let raw=resultValue(response);
  // The common output layer deliberately bounds structuredContent on large
  // inventories. The trusted local result still includes its complete JSON
  // text; recover it here instead of exposing a multi-MB MCP response.
  if(!Array.isArray(raw?.data)&&raw?.truncated===true){
    const text=response?.content?.find(item=>item.type==='text')?.text;
    if(typeof text==='string'&&Buffer.byteLength(text)<=2*1024*1024){
      try{raw=JSON.parse(text)}catch{}
    }
  }
  if(!raw||!Array.isArray(raw.data))throw Error('Native app inventory unavailable');
  return raw;
}
const discoverySource=adapters=>adapters.installedApps||
  ((adapters.platform||process.platform)==='linux'?
    (adapters.guiApps||linuxGuiInventory):
    (adapters.platform||process.platform)==='win32'?
      (adapters.guiApps||windowsGuiInventory):installedApps);
export async function detectedApps(options={},adapters={}){
  const get=discoverySource(adapters);
  let raw;
  try{raw=await nativeInventory(get,options)}
  catch{
    // The optional Windows COM inventory may be unavailable in a locked
    // session. Keep the curated app catalog usable, never fall back to
    // unsafe registry-only native GUI authorizations.
    if((adapters.platform||process.platform)==='win32'&&!adapters.installedApps)
      return {apps:[],total:0,truncated:false,
        backend:'windows_startmenu_shortcuts',inventory_status:'unavailable',
        inventory_truncated:false};
    throw Error('Native GUI inventory unavailable');
  }
  return {...detectedAppRows(raw.data,{...options,backend:raw.backend}),
    backend:raw.backend||'unknown',inventory_status:'ok',
    inventory_truncated:raw.inventory_truncated===true||raw.returned<raw.count};
}

export async function inspectDetectedApp(args={},adapters={}){
  const intent=['find','focus_control','set_control_text'].includes(args.intent)?args.intent:'inspect';
  const result={app:args.app,intent,executed:false,
    screenshot_used:false,verified:false};
  if(!/^local-[a-f0-9]{20}$/.test(args.app))
    return {...result,status:'blocked',reason:'invalid_detected_app_id'};
  // Resolution uses the complete native inventory, not a cached guess from
  // an earlier catalog result, so uninstall/reinstall invalidates stale IDs.
  const get=discoverySource(adapters);
  let native;
  try{native=await nativeInventory(get)}
  catch{return {...result,status:'unavailable',
    reason:'installed_app_inventory_unavailable'}}
  const matches=(native?.data||[]).filter(row=>safeName(row?.name)&&
    inventoryIdentity(row,{backend:native.backend})===args.app);
  if(!matches.length||new Set(matches.map(x=>x.name.toLowerCase())).size!==1)
    return {...result,status:'blocked',
    reason:'installed_app_identity_not_unique_or_missing'};
  const name=matches[0].name;
  const platform=adapters.platform||process.platform;
  // A Windows uninstall entry does not identify the executable that owns
  // the UI. Identically named registry records must never select one by
  // array order; defer until Windows executable provenance is supported.
  if(platform==='win32'&&native.backend==='windows-registry'&&matches.length>1)
    return {...result,status:'blocked',reason:'ambiguous_windows_installations'};
  if(platform==='win32'&&native.backend==='windows_startmenu_shortcuts'&&
    native.data.some(row=>row.source==='windows_startmenu_shortcut'&&
      String(row.name).toLowerCase()===name.toLowerCase()&&
      inventoryIdentity(row,{backend:native.backend})!==args.app))
    return {...result,status:'blocked',reason:'ambiguous_windows_shortcut_display_name'};

  // Two XDG launchers can display the same name while belonging to different
  // apps. A label alone cannot establish the native process provenance.
  if(platform==='linux'&&native.backend==='xdg_desktop_entries'&&
    native.data.some(row=>row.source==='xdg_desktop_entry'&&
      String(row.name).toLowerCase()===name.toLowerCase()&&
      inventoryIdentity(row,{backend:native.backend})!==args.app))
    return {...result,status:'blocked',reason:'ambiguous_gui_launcher_display_name'};
  // Exec and desktop ID are inventory metadata only. GUI launchers often
  // share a browser/wrapper binary; that name cannot authorize another UI.
  const permittedNames=[name,
    ...[matches[0].startup_wm_class,
      ...(platform==='win32'&&native.backend==='windows_startmenu_shortcuts'?
        [matches[0].process_hint]:[])].filter(safeName)];
  const matchesRunning=value=>permittedNames.some(n=>sameRunningApp(n,value));
  // A package database is not proof that its application process is running.
  // Avoid GNOME's expensive AT-SPI desktop scan for an absent process, but
  // only when local /proc access can prove absence. Host tests inject GUI.
  if(platform==='linux'&&!adapters.listWindows&&!adapters.uiSnapshot){
    const proc=(adapters.linuxRegisteredProcessState||
      linuxRegisteredProcessState)([name]);
    // GUI launchers can have a different process name (including D-Bus
    // activated helpers). A /proc miss must not hide a live XDG app window.
    if(proc?.state==='not_found'&&matches[0].source!=='xdg_desktop_entry')
      return {...result,status:'unavailable',
        reason:'application_process_not_running'};
  }
  if(!adapters.listWindows&&!adapters.uiSnapshot){
    try{await (adapters.requireInteractiveGuiSession||
      requireInteractiveGuiSession)(platform)}
    catch{return {...result,status:'unavailable',
      reason:'interactive_desktop_unavailable'}}
  }
  if(platform==='win32'){
    try{await (adapters.assertWindowsInteractiveDesktop||
      assertWindowsInteractiveDesktop)()}
    catch{return {...result,status:'blocked',
      reason:'interactive_windows_desktop_unavailable'}}
    if(native.backend!=='windows_startmenu_shortcuts')
      return {...result,status:'blocked',
        reason:'windows_process_installation_provenance_unverified'};
  }
  let windows;
  try{windows=resultValue(await (adapters.listWindows||listWindows)(
    {include_monitor:false}))}
  catch{return {...result,status:'unavailable',
    reason:'window_inventory_unavailable'}}
  if(!Array.isArray(windows))return {...result,status:'unavailable',
    reason:'window_inventory_unavailable'};
  const matching=windows.filter(w=>Number.isSafeInteger(Number(w.pid))&&
    Number(w.pid)>0 && matchesRunning(w.app) &&
    (!args.pid||Number(w.pid)===args.pid) &&
    (!args.window_id||String(w.id)===args.window_id));
  if(matching.length!==1)return {...result,status:'blocked',
    reason:matching.length?'ambiguous_app_windows':'verified_app_window_not_found',
    matching_windows:matching.length};
  const w=matching[0];
  if(platform==='win32'){
    const verify=adapters.windowsShortcutPidVerified||windowsShortcutPidVerified;
    if(!await verify(matches[0].target_path,Number(w.pid)))
      return {...result,status:'blocked',
        reason:'windows_shortcut_process_identity_unverified'};
  }
  if(platform==='darwin'&&native.backend==='system_profiler'&&
    !macBundle(matches[0]))
    return {...result,status:'blocked',reason:'macos_bundle_path_unavailable'};
  // System Profiler may report multiple .app copies with an identical name.
  // Verify the selected bundle via the PID's real executable, not AX name.
  if(platform==='darwin'&&native.backend==='system_profiler'&&macBundle(matches[0])){
    const verify=adapters.macBundlePidVerified||macBundlePidVerified;
    if(!await verify(matches[0].path,Number(w.pid)))
      return {...result,status:'blocked',reason:'macos_bundle_process_identity_unverified'};
  }
  if(['focus_control','set_control_text'].includes(intent)&&w.active===false)
    return {...result,status:'blocked',reason:'target_window_background'};
  const title=String(w.title||'').trim();
  const uiId=String(w.ui_id||'');
  // Window IDs from OS managers and accessibility providers are not
  // interchangeable (e.g. macOS WindowServer vs AX roots). If no exact
  // title or AX identity exists, do not read controls from another window
  // of the same process. Duplicate titles cannot disambiguate an AX root.
  if(!title&&!uiId)return {...result,status:'blocked',
    reason:'window_accessibility_identity_unavailable'};
  if(title&&windows.filter(x=>Number(x.pid)===Number(w.pid)&&
    sameRunningApp(w.app,x.app)&&String(x.title||'').trim()===title).length>1)
    return {...result,status:'blocked',
      reason:'indistinguishable_windows_same_title'};
  let snapshot;
  try{snapshot=resultValue(await (adapters.uiSnapshot||uiSnapshot)({
    pid:Number(w.pid),scope:'desktop',semantic_tree:false,
    ...(title?{window_title:title}:{}),
    max_nodes:120,max_depth:7,
  }))}
  catch{return {...result,status:'unavailable',
    reason:'accessibility_snapshot_unavailable'}}
  const nodes=Array.isArray(snapshot?.nodes)?snapshot.nodes:[];
  const exactWindow=node=>Number(node?.pid)===Number(w.pid)&&
    matchesRunning(node?.app)&&
    (title?String(node?.window||node?.name||'').trim()===title:
      String(node?.id||'')===uiId);
  const roots=nodes.filter(n=>exactWindow(n)&&
    ['window','frame','dialog'].includes(String(n.role||'').toLowerCase()));
  if(roots.length!==1)return {...result,status:'unavailable',
    reason:'accessible_window_identity_unverified'};
  const scoped=nodes.filter(n=>exactWindow(n));
  const tokenContext={app:args.app,pid:Number(w.pid),window_id:String(w.id)};
  if(intent==='set_control_text'){
    const candidates=scoped.filter(n=>n?.id===args.control_id);
    const current=candidates.length===1?candidates[0]:null;
    const safe=current&&safeControl(current);
    const expectedOk=typeof args.expected_value_token==='string'
      ? verifyControlValueToken(args.expected_value_token,{
        ...tokenContext,control_id:args.control_id,
        name:args.expected_name,role:args.expected_role,text:current?.value,
      })
      : current?.value===args.expected_text;
    if(!safe||!safe.id||safe.name!==args.expected_name||
      safe.role!==args.expected_role||!editable.test(safe.role)||
      safe.enabled!==true||!ordinaryText(current?.value)||
      !expectedOk||current.focusable===false)
      return {...result,status:'blocked',
        reason:'editable_control_or_expected_value_changed'};
    if(current.value===args.replacement_text)
      return {...result,status:'already_applied',executed:false,verified:true};
    // Cross-check precondition again inside the OS UIA/AX/AT-SPI action
    // immediately before SetValue, not just in this potentially stale tree.
    const action=adapters.uiAction||uiAction;
    try{
      const outcome=resultValue(await action({
        action:'set_value',id:safe.id,pid:Number(w.pid),
        app:w.app,window_title:title,window_id:w.id,name:safe.name,role:safe.role,
        strict_target_id:true,semantic_only:true,
        expected_value:current.value,value:args.replacement_text,
      }));
      if(outcome?.ok===false||outcome?.success===false)
        return {...result,status:'outcome_unknown',executed:null,
          reason:'native_text_write_not_confirmed'};
    }catch{return {...result,status:'outcome_unknown',executed:null,
      reason:'native_text_write_not_confirmed'}}
    let after;
    try{after=resultValue(await (adapters.uiSnapshot||uiSnapshot)({
      pid:Number(w.pid),scope:'desktop',semantic_tree:false,
      ...(title?{window_title:title}:{}),max_nodes:120,max_depth:7,
    }))}
    catch{return {...result,status:'dispatched_unverified',
      executed:true,reason:'text_readback_unavailable'}}
    const currentNodes=Array.isArray(after?.nodes)?after.nodes:[];
    const verified=currentNodes.filter(n=>exactWindow(n)&&n?.id===safe.id &&
      n.name===safe.name&&n.role===safe.role&&safeControl(n)&&
      n.value===args.replacement_text).length===1;
    return {...result,status:verified?'completed':'dispatched_unverified',
      verified,executed:true,pid:Number(w.pid),window_id:w.id,
      control_id:safe.id,verification:verified?'native_text_readback':null,
      ...(verified?{}:{reason:'text_readback_not_confirmed'})};
  }
  if(intent==='focus_control'){
    const candidates=scoped.filter(n=>n?.id===args.control_id);
    const selected=candidates.length===1?candidates[0]:null;
    const safe=selected&&safeControl(selected);
    const focusableRole=/^(button|tab|textbox|text field|textfield|edit|entry|search field|searchfield|searchbox|link|listitem|list item|radio button|radiobutton|checkbox|check box|combo box|combobox)$/i;
    if(!safe||safe.name!==args.expected_name||
      safe.role!==args.expected_role||safe.enabled!==true||
      !focusableRole.test(safe.role)||selected.focusable===false)
      return {...result,status:'blocked',reason:'control_identity_or_focus_capability_changed'};
    // Focus is the only permitted native action for an unknown app. Never
    // invoke, toggle, type, select or click, even if AX exposes those patterns.
    const action=adapters.uiAction||uiAction;
    try{
      const dispatched=resultValue(await action({
        action:'focus',id:safe.id,pid:Number(w.pid),
        app:w.app,window_title:title,window_id:w.id,name:safe.name,role:safe.role,
        strict_target_id:true,semantic_only:true,
      }));
      if(dispatched?.ok===false||dispatched?.success===false)
        return {...result,status:'dispatched_unverified',
          reason:'native_focus_rejected',executed:null};
    }catch{return {...result,status:'outcome_unknown',
      reason:'focus_dispatch_not_confirmed',executed:null}}
    const capture=adapters.uiSnapshot||uiSnapshot;
    let after;
    try{after=resultValue(await capture({
      pid:Number(w.pid),scope:'desktop',semantic_tree:false,
      ...(title?{window_title:title}:{}),max_nodes:120,max_depth:7,
    }))}
    catch{return {...result,status:'dispatched_unverified',executed:true,
      reason:'focus_readback_unavailable'}}
    const now=Array.isArray(after?.nodes)?after.nodes:[];
    const focused=now.some(n=>exactWindow(n)&&n.id===safe.id&&
      n.name===safe.name&&n.role===safe.role&&n.focused===true);
    return {...result,status:focused?'completed':'dispatched_unverified',
      executed:true,verified:focused,
      verification:focused?'native_accessibility_focus_readback':null,
      ...(focused?{}:{reason:'focus_readback_not_confirmed'}),
      window_id:w.id,pid:Number(w.pid),control_id:safe.id};
  }
  if(intent==='find'){
    const match=visibleControlMatches(scoped,args.query,
      {pid:Number(w.pid),app:w.app,tokenContext});
    return {...result,status:'completed',verified:true,
      via:'native_accessibility_scoped_pid',name,window_id:w.id,
      pid:Number(w.pid),...match,search_results_verified:false,
      note:'Read-only lookup of already visible accessibility names; no application search was submitted.'};
  }
  return {...result,status:'inspected',verified:true,
    via:'native_accessibility_scoped_pid',name,window_id:w.id,
    pid:Number(w.pid),node_count:scoped.length,
    controls:scoped.map(node=>previewControl(node,tokenContext))
      .filter(Boolean).slice(0,60)};
}
