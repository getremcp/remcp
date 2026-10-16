import { macWindowTargets, MAC_WINDOW_TARGET_TTL_MS, rememberMacWindowTarget, macWindowId, normalizeMacWindowTarget } from './desktop-macos-windows.mjs';
export { macWindowId, normalizeMacWindowTarget };
import path from 'node:path';

import { image, multi, text } from '../util.mjs';
import {
  clamp,
  escapeAppleScript,
  jsonResult,
  optionalString,
  readPrivateTempFile,
  removeTemp,
  requireEnum,
  runFile,
  runOsa,
  runWithInput,
  spawnDetached,
  tempDir,
} from './common.mjs';

function parseTsv(value, fields) {
  return String(value || '').split(/\r?\n/).filter(Boolean).map(line => {
    const parts = line.split('\t');
    return Object.fromEntries(fields.map((field, index) => [field, parts[index] ?? '']));
  });
}

let macWindowGeneration = 0;

export async function listWindows() {
  const script = `
set output to ""
tell application "System Events"
 repeat with p in (application processes whose background only is false)
  try
   set appName to name of p
   set appPid to unix id of p
   set windowIndex to 0
   repeat with w in windows of p
    try
     set pos to position of w
     set sz to size of w
     set output to output & appPid & tab & windowIndex & tab & appName & tab & (name of w) & tab & (item 1 of pos) & tab & (item 2 of pos) & tab & (item 1 of sz) & tab & (item 2 of sz) & linefeed
    end try
    set windowIndex to windowIndex + 1
   end repeat
  end try
 end repeat
end tell
return output`;
  const { stdout } = await runOsa(script, { label: 'list windows' });
  macWindowGeneration += 1;
  const generation = macWindowGeneration;
  const rows = parseTsv(stdout, ['pid','window_index','app','title','x','y','width','height']).map(row=>({
    id:macWindowId(row.pid,row.window_index,generation),pid:Number(row.pid),app:row.app,title:row.title,
    x:Number(row.x),y:Number(row.y),width:Number(row.width),height:Number(row.height),
  }));
  for (const [id,cached] of macWindowTargets.entries()) {
    if ((Date.now() - cached.at) > MAC_WINDOW_TARGET_TTL_MS) macWindowTargets.delete(id);
  }
  for (const row of rows) rememberMacWindowTarget(row);
  return jsonResult(rows);
}

function processQuery(args) {
  if (Number.isInteger(Number(args.pid))) return `first application process whose unix id is ${Number(args.pid)}`;
  if (optionalString(args.app)) return `first application process whose name contains "${escapeAppleScript(args.app)}"`;
  return 'first application process whose frontmost is true';
}

function windowQuery(args) {
  const title = optionalString(args.window_title || args.windowTitle || args.title);
  return title ? `first window whose name contains "${escapeAppleScript(title)}"` : 'front window';
}

export async function windowAction(args = {}) {
  const action=requireEnum(args.action,'action',['focus','minimize','maximize','restore','move','resize','move_resize','close']);
  const x=Number(args.x),y=Number(args.y),width=Number(args.width),height=Number(args.height);
  if((action==='move'||action==='move_resize')&&(!Number.isFinite(x)||!Number.isFinite(y)))throw new Error('x and y are required for window move');
  if((action==='resize'||action==='move_resize')&&(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0))throw new Error('width and height must be positive for window resize');
  const script=`(function(){
${macJxaTargetPrelude(args,{useWindowId:true})}
function perform(e,wanted){let acts=[];try{acts=e.actions()}catch(_){};for(let i=0;i<acts.length;i++){let n='';try{n=String(acts[i].name())}catch(_){};if(n===wanted){acts[i].perform();return true}}return false}
function setAttr(e,n,v){try{e.attributes.byName(n).value=v;return true}catch(_){return false}}
const action=${JSON.stringify(action)};
if(action==='focus'){try{proc.frontmost=true}catch(_){};perform(win,'AXRaise')}
else if(action==='minimize'){if(!setAttr(win,'AXMinimized',true)){try{win.minimized=true}catch(_){throw new Error('Minimize unavailable')}}}
else if(action==='maximize'){if(!perform(win,'AXZoomWindow'))throw new Error('AXZoomWindow unavailable')}
else if(action==='restore'){setAttr(win,'AXMinimized',false);try{proc.frontmost=true}catch(_){};perform(win,'AXRaise')}
else if(action==='close'){if(!perform(win,'AXClose'))throw new Error('AXClose unavailable')}
else if(action==='move'){win.position=[${Number.isFinite(x)?Math.trunc(x):0},${Number.isFinite(y)?Math.trunc(y):0}]}
else if(action==='resize'){win.size=[${Number.isFinite(width)?Math.trunc(width):800},${Number.isFinite(height)?Math.trunc(height):600}]}
else if(action==='move_resize'){win.position=[${Number.isFinite(x)?Math.trunc(x):0},${Number.isFinite(y)?Math.trunc(y):0}];win.size=[${Number.isFinite(width)?Math.trunc(width):800},${Number.isFinite(height)?Math.trunc(height):600}]}
let p={};try{p=win.properties()}catch(_){};
return JSON.stringify({action,pid:Number(proc.unixId()),app:safeName(proc),window:safeName(win),x:Array.isArray(p.position)?Number(p.position[0]):null,y:Array.isArray(p.position)?Number(p.position[1]):null,width:Array.isArray(p.size)?Number(p.size[0]):null,height:Array.isArray(p.size)?Number(p.size[1]):null,backend:'macos-accessibility'});
})()`;
  const {stdout}=await runOsa(script,{javascript:true,label:'window action',timeout:30_000});
  let parsed;try{parsed=JSON.parse(stdout.trim())}catch{parsed={action,backend:'macos-accessibility'}}
  return jsonResult(parsed);
}
export async function resolveWindowTarget(args = {}) {
  const script=`(function(){
${macJxaTargetPrelude(args,{useWindowId:true})}
let p={};try{p=win.properties()}catch(_){};
return JSON.stringify({
  id:${JSON.stringify(optionalString(args.id || args.window_id || args.windowId) || '')},
  pid:Number(proc.unixId()),app:safeName(proc),title:safeName(win),
  x:Array.isArray(p.position)?Number(p.position[0]):null,
  y:Array.isArray(p.position)?Number(p.position[1]):null,
  width:Array.isArray(p.size)?Number(p.size[0]):null,
  height:Array.isArray(p.size)?Number(p.size[1]):null,
  backend:'macos-accessibility'
});
})()`;
  const {stdout}=await runOsa(script,{javascript:true,label:'resolve window target',timeout:30_000});
  let parsed;try{parsed=JSON.parse(stdout.trim())}catch{throw new Error('Could not resolve macOS window target')}
  return jsonResult(parsed);
}

function macJxaTargetPrelude(args = {}, options = {}) {
  const target = normalizeMacWindowTarget(args, options);
  if (options.useWindowId && target.id && !target.idCached) throw new Error('macOS window id is stale or unknown; call list_windows again');
  const app = JSON.stringify(target.app);
  const title = JSON.stringify(target.title);
  const expectedApp = JSON.stringify(target.expectedApp);
  const expectedTitle = JSON.stringify(target.expectedTitle);
  const expectedBounds = JSON.stringify(target.expectedBounds);
  return String.raw`
const se=Application('System Events');
const wantPid=${target.pid};
const wantWindowIndex=${target.windowIndex == null ? 'null' : target.windowIndex};
const wantApp=${app};
const wantTitle=${title};
const expectedApp=${expectedApp};
const expectedTitle=${expectedTitle};
const expectedBounds=${expectedBounds};
function safeWindows(p){try{return p.windows()}catch(e){return []}}
function safeName(spec){try{return String(spec.name()||'')}catch(e){return ''}}
function safeProps(spec){try{return spec.properties()}catch(e){return {}}}
function sameBounds(spec,bounds){
  if(!bounds)return false;
  const p=safeProps(spec),pos=Array.isArray(p.position)?p.position:[],size=Array.isArray(p.size)?p.size:[];
  return Number(pos[0])===Number(bounds[0])&&Number(pos[1])===Number(bounds[1])&&Number(size[0])===Number(bounds[2])&&Number(size[1])===Number(bounds[3]);
}
function chooseProcess(){
  if(wantPid){
    const rows=se.applicationProcesses.whose({unixId:wantPid})();
    if(rows.length){
      if(wantApp && !safeName(rows[0]).toLowerCase().includes(wantApp.toLowerCase()))throw new Error('macOS window target app does not match the requested id/pid');
      if(expectedApp && safeName(rows[0])!==expectedApp)throw new Error('macOS window id no longer belongs to the same application; call list_windows again');
      return rows[0];
    }
    throw new Error('No matching UI process found');
  }
  if(wantApp){
    const rows=se.applicationProcesses();
    for(let i=0;i<rows.length;i++){
      if(safeName(rows[i]).toLowerCase().includes(wantApp.toLowerCase()) && safeWindows(rows[i]).length)return rows[i];
    }
    throw new Error('No matching UI application found');
  }
  const front=se.applicationProcesses.whose({frontmost:true})();
  let p=front.length?front[0]:null;
  if(p && safeWindows(p).length)return p;
  const preferredName=p?safeName(p):'';
  const rows=se.applicationProcesses();
  if(preferredName){
    for(let i=0;i<rows.length;i++){
      if(safeName(rows[i])===preferredName && safeWindows(rows[i]).length)return rows[i];
    }
  }
  for(let i=0;i<rows.length;i++){
    let background=true;
    try{background=Boolean(rows[i].backgroundOnly())}catch(e){}
    if(!background && safeWindows(rows[i]).length)return rows[i];
  }
  throw new Error('No accessible application window is available');
}
function chooseWindow(p){
  const rows=safeWindows(p);
  if(!rows.length)throw new Error('The selected application has no accessible windows');
  if(wantWindowIndex!==null){
    const indexValid=Number.isInteger(wantWindowIndex)&&wantWindowIndex>=0&&wantWindowIndex<rows.length;
    const selected=indexValid?rows[wantWindowIndex]:null;
    if(expectedTitle){
      if(selected&&safeName(selected)===expectedTitle)return selected;
      const matches=[];
      for(let i=0;i<rows.length;i++)if(safeName(rows[i])===expectedTitle)matches.push(rows[i]);
      if(matches.length===1)return matches[0];
      if(matches.length>1&&expectedBounds){
        const bounded=matches.filter(row=>sameBounds(row,expectedBounds));
        if(bounded.length===1)return bounded[0];
      }
      throw new Error('macOS window id no longer identifies one unambiguous window; call list_windows again');
    }
    if(expectedBounds){
      if(selected&&sameBounds(selected,expectedBounds))return selected;
      const bounded=rows.filter(row=>sameBounds(row,expectedBounds));
      if(bounded.length===1)return bounded[0];
      throw new Error('macOS window id no longer identifies one unambiguous window; call list_windows again');
    }
    if(!indexValid)throw new Error('macOS window id is stale; call list_windows again');
    if(wantTitle && !safeName(selected).toLowerCase().includes(wantTitle.toLowerCase()))throw new Error('macOS window id no longer matches the requested title; call list_windows again');
    return selected;
  }
  if(wantTitle){
    for(let i=0;i<rows.length;i++){
      if(safeName(rows[i]).toLowerCase().includes(wantTitle.toLowerCase()))return rows[i];
    }
    throw new Error('No matching accessibility window found');
  }
  return rows[0];
}
const proc=chooseProcess();
const win=chooseWindow(proc);
`;
}

export async function uiSnapshot(args = {}) {
  const maxNodes=clamp(args.max_nodes,500,1,5000);
  const maxDepth=clamp(args.max_depth,8,1,32);
  const script=`(function(){
${macJxaTargetPrelude(args)}
function scalar(v){
  if(v===null||v===undefined)return '';
  if(typeof v==='string'||typeof v==='number'||typeof v==='boolean')return v;
  try{return String(v)}catch(e){return ''}
}
function vector(v){try{return Array.isArray(v)?v:(v==null?[]:[v])}catch(e){return []}}
function props(e){try{return e.properties()}catch(_){return {}}}
function children(e){try{return e.uiElements()}catch(_){return []}}
const appPid=Number(proc.unixId());
const appName=safeName(proc);
const windowName=safeName(win);
const out=[];
const winProps=props(win);
const winPos=vector(winProps.position),winSize=vector(winProps.size);
out.push({
  id:'mac:'+appPid+':r',parent_id:null,index:0,depth:0,pid:appPid,app:appName,window:windowName,active:true,
  role:'Window',localized_role:'window',name:windowName,value:'',focused:Boolean(winProps.focused),enabled:winProps.enabled!==false,
  selected:Boolean(winProps.selected),frameworkId:'AX',x:Number(winPos[0]||0),y:Number(winPos[1]||0),width:Number(winSize[0]||0),height:Number(winSize[1]||0)
});
const stack=[];
const roots=children(win);
for(let i=roots.length-1;i>=0;i--)stack.push({e:roots[i],depth:1,path:'r.'+i,parent:'mac:'+appPid+':r'});
let index=1;
while(stack.length && out.length<${maxNodes}){
  const item=stack.pop(),e=item.e,p=props(e),pos=vector(p.position),size=vector(p.size);
  const role=String(scalar(p.role)).replace(/^AX/,'');
  const subrole=String(scalar(p.subrole));
  const name=scalar(p.title)||scalar(p.name)||scalar(p.accessibilityDescription)||scalar(p.description);
  const rawValue=scalar(p.value);
  const id='mac:'+appPid+':'+item.path;
  out.push({
    id,parent_id:item.parent,index,depth:item.depth,pid:appPid,app:appName,window:windowName,active:true,
    role,localized_role:scalar(p.roleDescription),subrole,name,value:/secure/i.test(subrole)?'':rawValue,
    focused:Boolean(p.focused),enabled:p.enabled!==false,selected:Boolean(p.selected),password:/secure/i.test(subrole),
    help_text:scalar(p.help),range_min:scalar(p.minimumValue),range_max:scalar(p.maximumValue),frameworkId:'AX',
    x:Number(pos[0]||0),y:Number(pos[1]||0),width:Number(size[0]||0),height:Number(size[1]||0)
  });
  index+=1;
  if(item.depth<${maxDepth}){
    const cs=children(e);
    for(let i=cs.length-1;i>=0;i--)stack.push({e:cs[i],depth:item.depth+1,path:item.path+'.'+i,parent:id});
  }
}
return JSON.stringify({platform:'darwin',count:out.length,nodes:out,truncated:stack.length>0,max_nodes:${maxNodes},max_depth:${maxDepth}});
})()`;
  const {stdout}=await runOsa(script,{javascript:true,label:'UI snapshot',timeout:30_000});
  let parsed;
  try{parsed=stdout.trim()?JSON.parse(stdout.trim()):{platform:'darwin',count:0,nodes:[]};}
  catch{throw new Error('Could not normalize macOS accessibility snapshot');}
  return jsonResult(parsed);
}

export async function uiAction(args = {}) {
  const action=requireEnum(args.action,'action',['click','invoke','focus','set_value','select','toggle','expand','collapse','scroll_into_view','set_range_value','add_to_selection','remove_from_selection']);
  const id=optionalString(args.id);
  const idParts=id?.startsWith('mac:')?id.split(':'):null;
  const targetPid=idParts?.length>=3&&Number.isInteger(Number(idParts[1]))?Number(idParts[1]):null;
  const token=idParts?.length>=3?idParts.slice(2).join(':'):null;
  const pathToken=token?.startsWith('r')?token:null;
  const legacyIndex=token&&!pathToken&&Number.isInteger(Number(token))?Number(token):null;
  const targetArgs=targetPid?{...args,pid:targetPid}:args;
  const name=JSON.stringify(optionalString(args.name)||'');
  const role=JSON.stringify(optionalString(args.role)||'');
  const value=JSON.stringify(String(args.value??''));
  const numericValue=Number(args.value);
  if(action==='set_range_value'&&!Number.isFinite(numericValue))throw new Error('set_range_value requires a finite numeric value');
  const script=`(function(){
ObjC.import('ApplicationServices');
${macJxaTargetPrelude(targetArgs)}
const wantedPath=${JSON.stringify(pathToken||'')};
const legacyIndex=${legacyIndex==null?'null':legacyIndex};
const wantedName=${name};
const wantedRole=${role};
const action=${JSON.stringify(action)};
const inputValue=${value};
const numericValue=${Number.isFinite(numericValue)?numericValue:'null'};
function scalar(v){if(v===null||v===undefined)return '';if(typeof v==='string'||typeof v==='number'||typeof v==='boolean')return v;try{return String(v)}catch(e){return ''}}
function vector(v){try{return Array.isArray(v)?v:(v==null?[]:[v])}catch(e){return []}}
function props(e){try{return e.properties()}catch(_){return {}}}
function children(e){try{return e.uiElements()}catch(_){return []}}
function meta(e){
  const p=props(e),pos=vector(p.position),size=vector(p.size);
  return {name:scalar(p.title)||scalar(p.name)||scalar(p.accessibilityDescription)||scalar(p.description),role:String(scalar(p.role)).replace(/^AX/,''),x:Number(pos[0]||0),y:Number(pos[1]||0),width:Number(size[0]||0),height:Number(size[1]||0)};
}
function resolvePath(){
  if(!wantedPath)return null;
  if(wantedPath==='r')return win;
  const bits=wantedPath.split('.');
  if(bits[0]!=='r')return null;
  let current=win;
  for(let i=1;i<bits.length;i++){
    const index=Number(bits[i]),rows=children(current);
    if(!Number.isInteger(index)||index<0||index>=rows.length)return null;
    current=rows[index];
  }
  return current;
}
function findTarget(){
  const byPath=resolvePath();if(byPath)return byPath;
  const stack=[];const roots=children(win);for(let i=roots.length-1;i>=0;i--)stack.push(roots[i]);
  let seen=0;
  while(stack.length&&seen<5000){
    const e=stack.pop();seen+=1;
    const m=meta(e);
    if((legacyIndex!==null&&seen===legacyIndex)||(legacyIndex===null&&(!wantedName||m.name.toLowerCase().includes(wantedName.toLowerCase()))&&(!wantedRole||m.role.toLowerCase().includes(wantedRole.toLowerCase()))))return e;
    const cs=children(e);for(let i=cs.length-1;i>=0;i--)stack.push(cs[i]);
  }
  return null;
}
function perform(e,wanted){
  let acts=[];try{acts=e.actions()}catch(_){}
  for(let i=0;i<acts.length;i++){let n='';try{n=String(acts[i].name())}catch(_){}if(n===wanted){acts[i].perform();return true}}
  return false;
}
function setAttribute(e,n,v){try{e.attributes.byName(n).value=v;return true}catch(_){return false}}
function coordinateClick(e){
  const m=meta(e);if(!(m.width>0&&m.height>0))throw new Error('UI element has no clickable bounds');
  const p=$.CGPointMake(m.x+m.width/2,m.y+m.height/2);
  function post(t){const ev=$.CGEventCreateMouseEvent(null,t,p,$.kCGMouseButtonLeft);$.CGEventPost($.kCGHIDEventTap,ev)}
  post($.kCGEventLeftMouseDown);post($.kCGEventLeftMouseUp);return 'coordinate';
}
const target=findTarget();if(!target)throw new Error('UI element not found');
let backend='accessibility';
if(action==='focus'){target.focused=true}
else if(action==='set_value'){target.value=inputValue}
else if(action==='set_range_value'){target.value=numericValue}
else if(action==='select'){if(!perform(target,'AXPick')){try{target.selected=true}catch(_){if(!perform(target,'AXPress'))throw new Error('Selection action unavailable')}}}
else if(action==='add_to_selection'){try{target.selected=true}catch(_){throw new Error('Selection add unavailable')}}
else if(action==='remove_from_selection'){try{target.selected=false}catch(_){throw new Error('Selection remove unavailable')}}
else if(action==='expand'){if(!setAttribute(target,'AXExpanded',true)&&!perform(target,'AXExpand'))throw new Error('Expand action unavailable')}
else if(action==='collapse'){if(!setAttribute(target,'AXExpanded',false)&&!perform(target,'AXCollapse'))throw new Error('Collapse action unavailable')}
else if(action==='scroll_into_view'){if(!perform(target,'AXScrollToVisible')){try{target.focused=true}catch(_){throw new Error('Scroll-to-visible action unavailable')}}}
else if(action==='click'||action==='invoke'||action==='toggle'){
  if(!perform(target,'AXPress')){
    if(action==='invoke')throw new Error('AXPress action unavailable');
    backend=coordinateClick(target);
  }
}
const m=meta(target);
return JSON.stringify({id:${JSON.stringify(id||'')},action,backend,name:m.name,role:m.role,x:m.x,y:m.y,width:m.width,height:m.height,pid:Number(proc.unixId()),app:safeName(proc),window:safeName(win)});
})()`;
  const {stdout}=await runOsa(script,{javascript:true,label:'UI action',timeout:30_000});
  let parsed;
  try{parsed=JSON.parse(stdout.trim());}catch{parsed={action,backend:'accessibility'};}
  return jsonResult(parsed);
}

export async function clipboard(args = {}) {
  const action=requireEnum(args.action,'action',['read','write','clear']);
  if(action==='read') return text((await runFile('/usr/bin/pbpaste',[],{label:'clipboard read'})).stdout);
  const value=action==='clear'?'':String(args.text??args.value??'');
  await runWithInput('/usr/bin/pbcopy',[],value,{label:'clipboard write'});
  return jsonResult({action,length:value.length});
}

export async function keyboard(args = {}) {
  const shortcut=optionalString(args.shortcut)||(Array.isArray(args.keys)?args.keys.join('+'):optionalString(args.key));
  if(!shortcut)throw new Error('shortcut or key is required');
  const tokens=shortcut.split('+').map(value=>value.trim()).filter(Boolean);
  const key=tokens.at(-1);
  const modifiers={ctrl:'control down',control:'control down',alt:'option down',option:'option down',shift:'shift down',cmd:'command down',command:'command down',meta:'command down',super:'command down'};
  const mods=tokens.slice(0,-1).map(value=>modifiers[value.toLowerCase()]).filter(Boolean);
  const codes={enter:36,return:36,esc:53,escape:53,tab:48,backspace:51,delete:117,up:126,down:125,left:123,right:124,home:115,end:119,pageup:116,pagedown:121,space:49};
  const op=Number.isInteger(codes[key.toLowerCase()])?`key code ${codes[key.toLowerCase()]}`:`keystroke "${escapeAppleScript(key)}"`;
  await runOsa(`tell application "System Events" to ${op}${mods.length?` using {${mods.join(',')}}`:''}`,{label:'keyboard'});
  return text(`Sent ${shortcut}.`);
}

export async function typeTextKeys(value) {
  await runOsa(`tell application "System Events" to keystroke "${escapeAppleScript(value)}"`,{label:'type text',timeout:30_000});
}

function mouseInfo(button='left') {
  const b=String(button).toLowerCase();
  if(b==='right')return {button:'$.kCGMouseButtonRight',down:'$.kCGEventRightMouseDown',up:'$.kCGEventRightMouseUp',drag:'$.kCGEventRightMouseDragged'};
  if(b==='middle')return {button:'$.kCGMouseButtonCenter',down:'$.kCGEventOtherMouseDown',up:'$.kCGEventOtherMouseUp',drag:'$.kCGEventOtherMouseDragged'};
  return {button:'$.kCGMouseButtonLeft',down:'$.kCGEventLeftMouseDown',up:'$.kCGEventLeftMouseUp',drag:'$.kCGEventLeftMouseDragged'};
}

export async function pointer(args = {}) {
  const action=requireEnum(args.action,'action',['move','click','double_click','right_click','down','up']);
  const x=Number(args.x),y=Number(args.y);
  const info=mouseInfo(action==='right_click'?'right':args.button);
  const p=`$.CGPointMake(${Number.isFinite(x)?x:0},${Number.isFinite(y)?y:0})`;
  const op=action==='move'?'post($.kCGEventMouseMoved,0);'
    :action==='down'?`post(${info.down},1);`
    :action==='up'?`post(${info.up},1);`
    :action==='double_click'?`post(${info.down},1);post(${info.up},1);post(${info.down},2);post(${info.up},2);`
    :`post(${info.down},1);post(${info.up},1);`;
  const script=`ObjC.import('ApplicationServices');var p=${p};function post(t,c){var e=$.CGEventCreateMouseEvent(null,t,p,${info.button});if(c)$.CGEventSetIntegerValueField(e,$.kCGMouseEventClickState,c);$.CGEventPost($.kCGHIDEventTap,e);}${op}`;
  await runOsa(script,{javascript:true,label:'pointer'});
  return text(`Pointer ${action} completed.`);
}

export async function dragDrop(args = {}) {
  const info=mouseInfo(args.button);
  const script=`ObjC.import('ApplicationServices');function post(t,x,y){var p=$.CGPointMake(x,y);var e=$.CGEventCreateMouseEvent(null,t,p,${info.button});$.CGEventPost($.kCGHIDEventTap,e);}post(${info.down},${args.from_x},${args.from_y});delay(${clamp(args.hold_ms,120,0,5000)/1000});post(${info.drag},${args.to_x},${args.to_y});delay(${clamp(args.duration_ms,120,0,5000)/1000});post(${info.up},${args.to_x},${args.to_y});`;
  await runOsa(script,{javascript:true,label:'drag and drop'});
  return jsonResult({from:[args.from_x,args.from_y],to:[args.to_x,args.to_y]});
}

export async function scroll(args = {}) {
  const dx=Number(args.delta_x||0),dy=Number(args.delta_y??args.delta??0);
  await runOsa(`ObjC.import('ApplicationServices');var e=$.CGEventCreateScrollWheelEvent(null,$.kCGScrollEventUnitPixel,2,${Math.trunc(-dy)},${Math.trunc(-dx)});$.CGEventPost($.kCGHIDEventTap,e);`,{javascript:true,label:'scroll'});
  return jsonResult({delta_x:dx,delta_y:dy});
}

export async function cursorPosition() {
  const script="ObjC.import('ApplicationServices');var e=$.CGEventCreate(null);var p=$.CGEventGetLocation(e);JSON.stringify({x:Number(p.x),y:Number(p.y)})";
  const { stdout } = await runOsa(script, { javascript:true, label:'cursor position' });
  let parsed;
  try { parsed = JSON.parse(stdout.trim()); } catch { parsed = null; }
  if (!parsed || !Number.isFinite(Number(parsed.x)) || !Number.isFinite(Number(parsed.y))) throw new Error('Could not read cursor position');
  return jsonResult({ x:Number(parsed.x), y:Number(parsed.y) });
}

export async function displayInventory() {
  const script=`ObjC.import('AppKit');var screens=$.NSScreen.screens;var main=$.NSScreen.mainScreen;var mf=main.frame;var top=Number(mf.origin.y)+Number(mf.size.height);var out=[];for(var i=0;i<Number(screens.count);i++){var s=screens.objectAtIndex(i);var f=s.frame;var name='Display '+(i+1);try{name=ObjC.unwrap(s.localizedName)}catch(e){};out.push({name:name,primary:Boolean(s.isEqual(main)),x:Number(f.origin.x),y:top-(Number(f.origin.y)+Number(f.size.height)),width:Number(f.size.width),height:Number(f.size.height),scale:Number(s.backingScaleFactor)})}JSON.stringify(out)`;
  const {stdout}=await runOsa(script,{javascript:true,label:'display inventory',timeout:30_000});
  let parsed;
  try { parsed=JSON.parse(stdout.trim()); } catch { parsed=null; }
  if (!Array.isArray(parsed)) throw new Error('Could not normalize macOS display inventory');
  return jsonResult(parsed);
}

export async function screenshotRegion(args = {}) {
  const x=Math.trunc(Number(args.x)),y=Math.trunc(Number(args.y)),width=Math.trunc(Number(args.width)),height=Math.trunc(Number(args.height));
  if(![x,y,width,height].every(Number.isFinite)||width<=0||height<=0)throw new Error('x, y, width and height are required; width/height must be positive');
  if(width>8192||height>8192||width*height>16_777_216)throw new Error('screenshot region is too large; width/height must be <= 8192 and area <= 16 megapixels');
  const dir=await tempDir('remcp-region-'),target=path.join(dir,'region.png');
  try{
    await runFile('/usr/sbin/screencapture',['-x','-R',`${x},${y},${width},${height}`,target],{label:'screenshot region'});
    const {data}=await readPrivateTempFile(target,4*1024*1024);
    return multi([{type:'text',text:`Captured ${width}x${height} at ${x},${y}.`},image(data.toString('base64'),'image/png')]);
  }finally{await removeTemp(dir);}
}

export async function notification(args = {}) {
  const title=escapeAppleScript(optionalString(args.title)||'ReMCP');
  const body=escapeAppleScript(String(args.message??args.body??''));
  await runOsa(`display notification "${body}" with title "${title}"`,{label:'notification'});
  return text('Notification sent.');
}

export async function launchApp(app,argv=[],options={}) {
  if(options.cwd){
    const direct=path.isAbsolute(app)||String(app).includes('/');
    if(!direct) throw new Error('cwd requires an executable/path on macOS; friendly application-name launch via open -a cannot guarantee the child working directory');
    const pid=spawnDetached(app,argv,{cwd:options.cwd});
    return `Launched ${app} (pid ${pid}) in ${options.cwd}.`;
  }
  const openArgs=['-a',app];
  if(argv.length)openArgs.push('--args',...argv);
  const pid=spawnDetached('/usr/bin/open',openArgs);
  return `Launched ${app} (launcher pid ${pid}).`;
}
export async function openPath(target){spawnDetached('/usr/bin/open',[target]);}
export async function revealPath(target){spawnDetached('/usr/bin/open',['-R',target]);}
