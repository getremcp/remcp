import { msaaBrowserSnapshot, windowsUiRootScript } from './desktop-windows-msaa.mjs';
import { strictWindowsActionGate } from './desktop-windows-action-guard.mjs';
import { windowsWindowSelector } from './desktop-windows-window-selector.mjs';
import { windowsInteropLoad } from './windows-interop.mjs';
import { quoteWindowsArgument } from './windows-argv.mjs';
import path from 'node:path';
import process from 'node:process';
import { image, multi, text } from '../util.mjs';
import {
  clamp,
  escapePowerShellSingle,
  jsonResult,
  optionalString,
  readPrivateTempFile,
  removeTemp,
  requireEnum,
  runPowerShell,
  spawnDetached,
  tempDir,
} from './common.mjs';
export { listWindows } from './desktop-windows-list.mjs';
export async function windowAction(args = {}, {runPowerShellFn=runPowerShell}={}) {
  const action=requireEnum(args.action,'action',['focus','minimize','maximize','restore','move','resize','move_resize','close']);
  const x=Number(args.x),y=Number(args.y),width=Number(args.width),height=Number(args.height);
  const script=String.raw`
${windowsInteropLoad('window-action')}
${windowsInteropLoad('foreground')}
${windowsWindowSelector(args)}
$r=New-Object RM+RECT;[void][RM]::GetWindowRect($h,[ref]$r)
switch('${action}'){
 'focus'{if(-not [RM]::FocusWindow($h)){throw 'Windows refused foreground focus'}}
 'minimize'{[void][RM]::ShowWindow($h,6)}
 'maximize'{[void][RM]::ShowWindow($h,3)}
 'restore'{[void][RM]::ShowWindow($h,9)}
 'close'{if(-not [RM]::PostMessage($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Windows refused window close message'}}
 'move'{if(-not [RM]::MoveWindow($h,${Number.isFinite(x)?Math.trunc(x):0},${Number.isFinite(y)?Math.trunc(y):0},$r.Right-$r.Left,$r.Bottom-$r.Top,$true)){throw 'Windows refused window move'}}
 'resize'{if(-not [RM]::MoveWindow($h,$r.Left,$r.Top,${Number.isFinite(width)?Math.trunc(width):800},${Number.isFinite(height)?Math.trunc(height):600},$true)){throw 'Windows refused window resize'}}
 'move_resize'{if(-not [RM]::MoveWindow($h,${Number.isFinite(x)?Math.trunc(x):0},${Number.isFinite(y)?Math.trunc(y):0},${Number.isFinite(width)?Math.trunc(width):800},${Number.isFinite(height)?Math.trunc(height):600},$true)){throw 'Windows refused window move_resize'}}
}
`;
  await runPowerShellFn(script,{label:'window action'});
  return text(`Window action ${action} completed.`);
}
export async function uiSnapshot(args = {}, {runPowerShellFn=runPowerShell}={}) {
  const maxNodes = clamp(args.max_nodes, 500, 1, 5000);
  const maxDepth = clamp(args.max_depth, 8, 1, 32);
  const browserDom = args.browser_dom === true;
  const script = String.raw`
Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes
${windowsUiRootScript(args)}
$windowForeground=($h -eq [RMFG]::GetForegroundWindow())
$browserProvider=$null
if(${browserDom ? '$true' : '$false'}){
 try{
  $cond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'RootWebArea')
  $dom=$root.FindFirst([System.Windows.Automation.TreeScope]::Subtree,$cond)
  if($dom){$root=$dom;$browserProvider='uia-rootwebarea'}
 }catch{}
}
$cache=New-Object System.Windows.Automation.CacheRequest
$cache.TreeScope=[System.Windows.Automation.TreeScope]::Element
@(
 [System.Windows.Automation.AutomationElement]::NameProperty,
 [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
 [System.Windows.Automation.AutomationElement]::LocalizedControlTypeProperty,
 [System.Windows.Automation.AutomationElement]::AcceleratorKeyProperty,
 [System.Windows.Automation.AutomationElement]::ClassNameProperty,
 [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
 [System.Windows.Automation.AutomationElement]::FrameworkIdProperty,
 [System.Windows.Automation.AutomationElement]::IsEnabledProperty,
 [System.Windows.Automation.AutomationElement]::IsOffscreenProperty,
 [System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty,
 [System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty,
 [System.Windows.Automation.AutomationElement]::IsPasswordProperty,
 [System.Windows.Automation.AutomationElement]::BoundingRectangleProperty,
 [System.Windows.Automation.AutomationElement]::HelpTextProperty,
 [System.Windows.Automation.AutomationElement]::ProcessIdProperty
)|ForEach-Object{$cache.Add($_)}
@(
 [System.Windows.Automation.InvokePattern]::Pattern,
 [System.Windows.Automation.ValuePattern]::Pattern,
 [System.Windows.Automation.TogglePattern]::Pattern,
 [System.Windows.Automation.SelectionItemPattern]::Pattern,
 [System.Windows.Automation.ExpandCollapsePattern]::Pattern,
 [System.Windows.Automation.RangeValuePattern]::Pattern,
 [System.Windows.Automation.ScrollPattern]::Pattern,
 [System.Windows.Automation.ScrollItemPattern]::Pattern
)|ForEach-Object{try{$cache.Add($_)}catch{}}
$legacyPattern=$null;$legacyType='System.Windows.Automation.LegacyIAccessiblePattern' -as [type];if($legacyType){try{$legacyPattern=$legacyType.GetField('Pattern').GetValue($null);$cache.Add($legacyPattern)}catch{$legacyPattern=$null}}
try{$root=$root.GetUpdatedCache($cache)}catch{}
$q=New-Object System.Collections.Queue
$q.Enqueue([pscustomobject]@{e=$root;d=0;parent=$null})
$o=New-Object System.Collections.ArrayList
$seen=0
while($q.Count -gt 0 -and $seen -lt ${maxNodes}){
 $item=$q.Dequeue();$e=$item.e;$d=[int]$item.d;$parent=$item.parent;$seen++
 try{
  $c=$e.Cached
  $r=$c.BoundingRectangle
  try{$rid=($e.GetRuntimeId()-join '.')}catch{$rid=($rootPid.ToString()+'.'+$seen.ToString())}
  $id='win:'+$rid
  $patterns=New-Object System.Collections.ArrayList
  $value=$null;$toggleState=$null;$expandState=$null;$rangeValue=$null;$rangeMin=$null;$rangeMax=$null
  $selected=$null;$scrollH=$false;$scrollV=$false;$scrollHPct=$null;$scrollVPct=$null;$defaultAction=$null;$privateField=($c.IsPassword -or ($c.Name -match 'password|passphrase|passcode|secret|token|otp|recovery.*code|\bpin\b') -or ($c.ControlType.ProgrammaticName -eq 'ControlType.Pane' -and $c.ClassName -match '^WindowsForms10\.EDIT'))
  try{$p=$e.GetCachedPattern([System.Windows.Automation.InvokePattern]::Pattern);if($p){[void]$patterns.Add('invoke')}}catch{}
  if(-not $privateField){$p=$null;try{$p=[System.Windows.Automation.ValuePattern]$e.GetCachedPattern([System.Windows.Automation.ValuePattern]::Pattern)}catch{};if(-not $p){try{$p=[System.Windows.Automation.ValuePattern]$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)}catch{}};if($p){try{$value=$p.Current.Value;[void]$patterns.Add('value')}catch{}}}
  try{$p=[System.Windows.Automation.TogglePattern]$e.GetCachedPattern([System.Windows.Automation.TogglePattern]::Pattern);if($p){[void]$patterns.Add('toggle');$toggleState=$p.Cached.ToggleState.ToString().ToLowerInvariant()}}catch{}
  try{$p=[System.Windows.Automation.SelectionItemPattern]$e.GetCachedPattern([System.Windows.Automation.SelectionItemPattern]::Pattern);if($p){[void]$patterns.Add('selection_item');$selected=$p.Cached.IsSelected}}catch{}
  try{$p=[System.Windows.Automation.ExpandCollapsePattern]$e.GetCachedPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern);if($p){[void]$patterns.Add('expand_collapse');$expandState=$p.Cached.ExpandCollapseState.ToString().ToLowerInvariant()}}catch{}
  try{$p=[System.Windows.Automation.RangeValuePattern]$e.GetCachedPattern([System.Windows.Automation.RangeValuePattern]::Pattern);if($p){[void]$patterns.Add('range_value');$rangeValue=$p.Cached.Value;$rangeMin=$p.Cached.Minimum;$rangeMax=$p.Cached.Maximum}}catch{}
  try{$p=[System.Windows.Automation.ScrollPattern]$e.GetCachedPattern([System.Windows.Automation.ScrollPattern]::Pattern);if($p){[void]$patterns.Add('scroll');$scrollH=$p.Cached.HorizontallyScrollable;$scrollV=$p.Cached.VerticallyScrollable;$scrollHPct=$p.Cached.HorizontalScrollPercent;$scrollVPct=$p.Cached.VerticalScrollPercent}}catch{}
  try{$p=$e.GetCachedPattern([System.Windows.Automation.ScrollItemPattern]::Pattern);if($p){[void]$patterns.Add('scroll_item')}}catch{}
  if($legacyPattern){try{$p=$e.GetCachedPattern($legacyPattern);if($p){[void]$patterns.Add('legacy_iaccessible');$defaultAction=$p.Cached.DefaultAction;if(-not $privateField -and ($null -eq $value -or $value -eq '')){$value=$p.Cached.Value}}}catch{}}
  [void]$o.Add([pscustomobject]@{
   id=$id;parent_id=$parent;depth=$d;active=($d -eq 0 -and $windowForeground);pid=$c.ProcessId;app=$rootApp;window=$windowName;window_id=$(if($d -eq 0){'0x{0:X}' -f $h.ToInt64()}else{''});
   name=$(if($privateField){''}else{$c.Name});role=$c.ControlType.ProgrammaticName.Replace('ControlType.','');localized_role=$c.LocalizedControlType;
   automationId=$c.AutomationId;className=$c.ClassName;frameworkId=$c.FrameworkId;enabled=$c.IsEnabled;offscreen=$c.IsOffscreen;
   focused=$c.HasKeyboardFocus;focusable=$c.IsKeyboardFocusable;password=$privateField;help_text=$c.HelpText;shortcut=$c.AcceleratorKey;
   value=$value;patterns=@($patterns);toggle_state=$toggleState;expand_collapse_state=$expandState;selected=$selected;
   range_value=$rangeValue;range_min=$rangeMin;range_max=$rangeMax;scrollable=($scrollH -or $scrollV);
   horizontal_scrollable=$scrollH;vertical_scrollable=$scrollV;horizontal_scroll_percent=$scrollHPct;vertical_scroll_percent=$scrollVPct;
   default_action=$defaultAction;x=[int]$r.X;y=[int]$r.Y;width=[int]$r.Width;height=[int]$r.Height
  })
  if($d -lt ${maxDepth}){
   try{$activation=$cache.Activate();try{$children=$e.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)}finally{if($activation){$activation.Dispose()}}}
   catch{$children=$null}
   if($children){for($i=0;$i -lt $children.Count;$i++){$q.Enqueue([pscustomobject]@{e=$children.Item($i);d=$d+1;parent=$id})}}
  }
 }catch{}
}
[pscustomobject]@{platform='win32';count=$o.Count;nodes=@($o);truncated=($q.Count -gt 0);max_nodes=${maxNodes};browser_dom=[pscustomobject]@{requested=${browserDom ? '$true' : '$false'};available=($null -ne $browserProvider);provider=$browserProvider}}|ConvertTo-Json -Compress -Depth 8`;
  const { stdout } = await runPowerShellFn(script, { label:'UI snapshot', timeout:30_000 });
  const parsed = stdout.trim() ? JSON.parse(stdout) : { platform:'win32', count:0, nodes:[] };
  if (browserDom && !parsed?.browser_dom?.available) {
    const fallback = await msaaBrowserSnapshot(args).catch(() => null);
    if (fallback?.nodes?.length) return jsonResult(fallback);
  }
  return jsonResult(parsed);
}
export async function uiAction(args = {}, { runPowerShellFn = runPowerShell } = {}) {
  const action = requireEnum(args.action, 'action', [
    'click','invoke','focus','set_value','select','toggle','expand','collapse',
    'scroll_into_view','set_range_value','add_to_selection','remove_from_selection',
  ]);
  const id = escapePowerShellSingle(optionalString(args.id) || '');
  const name = escapePowerShellSingle(optionalString(args.name) || '');
  const role = escapePowerShellSingle(optionalString(args.role) || '');
  const automationId = escapePowerShellSingle(optionalString(args.automation_id || args.automationId) || '');
  const value = escapePowerShellSingle(String(args.value ?? ''));
  const expectedValue = args.strict_target_id===true&&action==='set_value'&&typeof args.expected_value==='string'?escapePowerShellSingle(args.expected_value):null;
  // The entire switch must parse even when the selected action has no numeric value.
  const numericValue = action === 'set_range_value' ? Number(args.value) : 0;
  if (action === 'set_range_value' && !Number.isFinite(numericValue)) throw new Error('set_range_value requires a finite numeric value');
  const script = String.raw`
Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes
${windowsUiRootScript(args)}
${strictWindowsActionGate(args)}
${action==='click'&&args.strict_target_id!==true?windowsInteropLoad('ui-mouse'):''}
$q=New-Object System.Collections.Queue;$q.Enqueue($root);$found=$null;$visited=0
while($q.Count -gt 0 -and -not $found -and $visited -lt 10000){
 $e=$q.Dequeue();$visited++
 try{
  $rid='win:'+($e.GetRuntimeId()-join '.')
  $r=$e.Current.ControlType.ProgrammaticName.Replace('ControlType.','')
  if(('${id}' -eq '' -or $rid -eq '${id}') -and ('${name}' -eq '' -or $e.Current.Name -like '*${name}*') -and ('${role}' -eq '' -or $r -like '*${role}*') -and ('${automationId}' -eq '' -or $e.Current.AutomationId -eq '${automationId}')){$found=$e;break}
  $children=$e.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
  for($i=0;$i -lt $children.Count;$i++){$q.Enqueue($children.Item($i))}
 }catch{}
}
if(-not $found){throw 'UI element not found'}
if(${args.strict_target_id === true ? '$true' : '$false'}){
 if($h -ne [RMFG]::GetForegroundWindow()){throw 'Native guided action refused: target window is background'}
 if($found.Current.ProcessId -ne $rootPid){throw 'Native guided action refused: control process changed'}
 if($found.Current.Name -ne '${name}' -or
    $found.Current.ControlType.ProgrammaticName.Replace('ControlType.','') -ne '${role}'){
  throw 'Exact UI element identity changed before action'
 }
}
$used=$null
switch('${action}'){
 'focus'{[void]$found.SetFocus();$used='SetFocus'}
 'invoke'{
  $p=$null;if($found.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$p)){([System.Windows.Automation.InvokePattern]$p).Invoke();$used='InvokePattern'}else{throw 'InvokePattern unavailable'}
 }
 'click'{
  $p=$null
  if($found.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$p)){([System.Windows.Automation.InvokePattern]$p).Invoke();$used='InvokePattern'}
  else{
   ${args.strict_target_id===true?
     "throw 'Strict Windows UIA click requires InvokePattern'":
     `$pt=New-Object System.Windows.Point
   $hasPoint=$false
   try{$hasPoint=$found.TryGetClickablePoint([ref]$pt)}catch{}
   if(-not $hasPoint){$b=$found.Current.BoundingRectangle;$pt=New-Object System.Windows.Point(($b.X+$b.Width/2),($b.Y+$b.Height/2))}
   [void][RMMouse]::SetCursorPos([int]$pt.X,[int]$pt.Y)
   [RMMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[RMMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero);$used='pointer'`}
  }
 }
 'set_value'{$p=$null;if(-not $found.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$p)){throw 'ValuePattern unavailable'}
  if($found.Current.IsPassword){throw 'Native text mutation refused for protected control'}
  if(([System.Windows.Automation.ValuePattern]$p).Current.IsReadOnly){throw 'Native text control is read-only'}
  ${expectedValue===null?'':"if(([System.Windows.Automation.ValuePattern]$p).Current.Value -cne '"+expectedValue+"'){throw 'Native text value changed before write'}"}
  if(${args.strict_target_id===true?'$true':'$false'} -and $h -ne [RMFG]::GetForegroundWindow()){throw 'Native guided action refused: target window became background'}
  ([System.Windows.Automation.ValuePattern]$p).SetValue('${value}');$used='ValuePattern' }
 'select'{
  $p=$null;if($found.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$p)){([System.Windows.Automation.SelectionItemPattern]$p).Select();$used='SelectionItemPattern.Select'}else{throw 'SelectionItemPattern unavailable'}
 }
 'add_to_selection'{
  $p=$null;if($found.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$p)){([System.Windows.Automation.SelectionItemPattern]$p).AddToSelection();$used='SelectionItemPattern.AddToSelection'}else{throw 'SelectionItemPattern unavailable'}
 }
 'remove_from_selection'{
  $p=$null;if($found.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$p)){([System.Windows.Automation.SelectionItemPattern]$p).RemoveFromSelection();$used='SelectionItemPattern.RemoveFromSelection'}else{throw 'SelectionItemPattern unavailable'}
 }
 'toggle'{
  $p=$null;if($found.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$p)){([System.Windows.Automation.TogglePattern]$p).Toggle();$used='TogglePattern'}else{throw 'TogglePattern unavailable'}
 }
 'expand'{
  $p=$null;if($found.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$p)){([System.Windows.Automation.ExpandCollapsePattern]$p).Expand();$used='ExpandCollapsePattern.Expand'}else{throw 'ExpandCollapsePattern unavailable'}
 }
 'collapse'{
  $p=$null;if($found.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$p)){([System.Windows.Automation.ExpandCollapsePattern]$p).Collapse();$used='ExpandCollapsePattern.Collapse'}else{throw 'ExpandCollapsePattern unavailable'}
 }
 'scroll_into_view'{
  $p=$null;if($found.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern,[ref]$p)){([System.Windows.Automation.ScrollItemPattern]$p).ScrollIntoView();$used='ScrollItemPattern'}else{throw 'ScrollItemPattern unavailable'}
 }
 'set_range_value'{
  $p=$null;if($found.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern,[ref]$p)){([System.Windows.Automation.RangeValuePattern]$p).SetValue([double]${numericValue});$used='RangeValuePattern'}else{throw 'RangeValuePattern unavailable'}
 }
}
# Strict UIA reports independent booleans, never the written or read-back text.
$foregroundAfter=$null;$focusedAfter=$null;$valueMatchesAfter=$null
if(${args.strict_target_id===true?'$true':'$false'}){
 if('${action}' -eq 'set_value'){Start-Sleep -Milliseconds 60}
 try{$foregroundAfter=($h -eq [RMFG]::GetForegroundWindow())}catch{$foregroundAfter=$false}
 if('${action}' -eq 'focus'){
  try{$focusedAfter=[bool]$found.Current.HasKeyboardFocus}catch{$focusedAfter=$false}
 }
 if('${action}' -eq 'set_value'){
  try{
   $fresh=$found.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
   if($null -ne $fresh){
    $valueMatchesAfter=([System.Windows.Automation.ValuePattern]$fresh).Current.Value -ceq '${value}'
   }else{$valueMatchesAfter=$false}
  }catch{$valueMatchesAfter=$false}
 }
}
$out=[ordered]@{id=('win:'+($found.GetRuntimeId()-join '.'));name=$found.Current.Name;role=$found.Current.ControlType.ProgrammaticName.Replace('ControlType.','');action='${action}';backend=$used}
if(${args.strict_target_id===true?'$true':'$false'}){
 $out.foreground_after=$foregroundAfter
 $out.focused_after=$focusedAfter
 $out.value_matches_after=$valueMatchesAfter
}
[pscustomobject]$out|ConvertTo-Json -Compress`;
  const raw = (await runPowerShellFn(script, { label:'UI action', timeout:30_000 })).stdout.trim();
  return jsonResult(raw ? JSON.parse(raw) : { action });
}
export function buildWindowsClipboardPowerShell(action, value = '') {
  // Set-Clipboard rejects an empty value in Windows PowerShell 5.1.
  // Clear the clipboard using the OS clipboard API instead of treating it as a write.
  if (action === 'clear' || value.length === 0) {
    return 'Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Clipboard]::Clear()';
  }
  const encoded = Buffer.from(value, 'utf16le').toString('base64');
  return `$b=[Convert]::FromBase64String('${encoded}');Set-Clipboard -Value ([Text.Encoding]::Unicode.GetString($b))`;
}

export function buildWindowsClipboardReadPowerShell() {
  // Windows PowerShell writes redirected stdout in the OEM code page, which
  // corrupts non-ASCII clipboard text. Return UTF-8 bytes as base64 instead.
  return "$v=Get-Clipboard -Raw;if($null -eq $v){$v=''};[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v))";
}

export function decodeWindowsClipboardRead(stdout = '') {
  const encoded = String(stdout).trim();
  if (!encoded) return '';
  return Buffer.from(encoded, 'base64').toString('utf8');
}

export async function clipboard(args = {}) {
  const action=requireEnum(args.action,'action',['read','write','clear']);
  if(action==='read'){
    const {stdout}=await runPowerShell(buildWindowsClipboardReadPowerShell(),{label:'clipboard read'});
    return text(decodeWindowsClipboardRead(stdout));
  }
  const value=action==='clear'?'':String(args.text??args.value??'');
  await runPowerShell(buildWindowsClipboardPowerShell(action, value),{label: action === 'clear' ? 'clipboard clear' : 'clipboard write'});
  return jsonResult({action,length:value.length});
}

export async function keyboard(args = {}) {
  const shortcut=optionalString(args.shortcut)||(Array.isArray(args.keys)?args.keys.join('+'):optionalString(args.key));
  if(!shortcut)throw new Error('shortcut or key is required');
  const tokens=shortcut.split('+').map(value=>value.trim()).filter(Boolean);
  const mods={ctrl:'^',control:'^',alt:'%',shift:'+'};
  const special={enter:'{ENTER}',return:'{ENTER}',esc:'{ESC}',escape:'{ESC}',tab:'{TAB}',backspace:'{BACKSPACE}',delete:'{DELETE}',up:'{UP}',down:'{DOWN}',left:'{LEFT}',right:'{RIGHT}',home:'{HOME}',end:'{END}',pageup:'{PGUP}',pagedown:'{PGDN}',space:' '};
  const prefix=tokens.slice(0,-1).map(v=>mods[v.toLowerCase()]||'').join('');
  const key=tokens.at(-1);
  const send=prefix+(special[key.toLowerCase()]||(key.length===1?key:`{${key.toUpperCase()}}`));
  await runPowerShell(`$w=New-Object -ComObject WScript.Shell;$w.SendKeys('${escapePowerShellSingle(send)}')`,{label:'keyboard'});
  return text(`Sent ${shortcut}.`);
}

export async function typeTextKeys(value) {
  const escaped=escapePowerShellSingle(String(value).replace(/[+^%~(){}\[\]]/g,'{$&}'));
  await runPowerShell(`$w=New-Object -ComObject WScript.Shell;$w.SendKeys('${escaped}')`,{label:'type text'});
}

function mousePrelude() {
  return String.raw`${windowsInteropLoad('pointer')}`;
}

function flags(button='left') {
  const b=String(button).toLowerCase();
  return b==='right'?{down:'0x0008',up:'0x0010'}:b==='middle'?{down:'0x0020',up:'0x0040'}:{down:'0x0002',up:'0x0004'};
}

export async function pointer(args = {}) {
  const action=requireEnum(args.action,'action',['move','click','double_click','right_click','down','up']);
  const x=Number(args.x),y=Number(args.y),f=flags(action==='right_click'?'right':args.button);
  const clicks=action==='double_click'?2:1;
  const op=action==='move'?'':action==='down'?`[RMMouse]::mouse_event(${f.down},0,0,0,[UIntPtr]::Zero)`:action==='up'?`[RMMouse]::mouse_event(${f.up},0,0,0,[UIntPtr]::Zero)`:`for($i=0;$i -lt ${clicks};$i++){[RMMouse]::mouse_event(${f.down},0,0,0,[UIntPtr]::Zero);[RMMouse]::mouse_event(${f.up},0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 70}`;
  const move=Number.isFinite(x)&&Number.isFinite(y)?`[void][RMMouse]::SetCursorPos(${Math.trunc(x)},${Math.trunc(y)})`:'';
  await runPowerShell(`${mousePrelude()}\n${move}\n${op}`,{label:'pointer'});
  return text(`Pointer ${action} completed.`);
}

export async function dragDrop(args = {}) {
  const f=flags(args.button);
  const script=`${mousePrelude()}\n[void][RMMouse]::SetCursorPos(${Math.trunc(args.from_x)},${Math.trunc(args.from_y)});[RMMouse]::mouse_event(${f.down},0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds ${clamp(args.hold_ms,120,0,5000)};[void][RMMouse]::SetCursorPos(${Math.trunc(args.to_x)},${Math.trunc(args.to_y)});Start-Sleep -Milliseconds ${clamp(args.duration_ms,120,0,5000)};[RMMouse]::mouse_event(${f.up},0,0,0,[UIntPtr]::Zero)`;
  await runPowerShell(script,{label:'drag and drop'});
  return jsonResult({from:[args.from_x,args.from_y],to:[args.to_x,args.to_y]});
}

export function buildWindowsScrollPowerShell(dx, dy) {
  const wheel = Math.trunc(Number(dy) || 0);
  const horizontal = Math.trunc(Number(dx) || 0);
  return `${mousePrelude()}\n[RMMouse]::mouse_event(0x0800,0,0,${-wheel},[UIntPtr]::Zero);[RMMouse]::mouse_event(0x01000,0,0,${horizontal},[UIntPtr]::Zero)`;
}

export async function scroll(args = {}) {
  const dx=Number(args.delta_x||0),dy=Number(args.delta_y??args.delta??0);
  await runPowerShell(buildWindowsScrollPowerShell(dx,dy),{label:'scroll'});
  return jsonResult({delta_x:dx,delta_y:dy});
}

export async function cursorPosition() {
  const script=String.raw`${windowsInteropLoad('cursor')};$p=New-Object RMCursor+POINT;if(-not [RMCursor]::GetCursorPos([ref]$p)){throw 'GetCursorPos failed'};[pscustomobject]@{x=$p.X;y=$p.Y}|ConvertTo-Json -Compress`;
  const raw=(await runPowerShell(script,{label:'cursor position'})).stdout.trim();
  return jsonResult(raw?JSON.parse(raw):{x:null,y:null});
}

export async function displayInventory() {
  const script=String.raw`Add-Type -AssemblyName System.Windows.Forms
${windowsInteropLoad('displays')}
[System.Windows.Forms.Screen]::AllScreens|ForEach-Object{
 $cx=$_.Bounds.X+[int]($_.Bounds.Width/2);$cy=$_.Bounds.Y+[int]($_.Bounds.Height/2);$dpi=[RMDisplay]::DpiAt($cx,$cy);$scale=[Math]::Round($dpi/96.0,3)
 [pscustomobject]@{name=$_.DeviceName;display_name=$_.DeviceName;primary=$_.Primary;x=$_.Bounds.X;y=$_.Bounds.Y;width=$_.Bounds.Width;height=$_.Bounds.Height;pixel_width=$_.Bounds.Width;pixel_height=$_.Bounds.Height;workingX=$_.WorkingArea.X;workingY=$_.WorkingArea.Y;workingWidth=$_.WorkingArea.Width;workingHeight=$_.WorkingArea.Height;scale=$scale;dpi=$dpi}
}|ConvertTo-Json -Compress`;
  const raw=(await runPowerShell(script,{label:'display inventory'})).stdout.trim();
  const parsed=raw?JSON.parse(raw):[];
  return jsonResult(Array.isArray(parsed)?parsed:[parsed]);
}

export function windowsRegionCaptureScript({primary=false,x=0,y=0,width=0,height=0} = {}, target='') {
  const safe=escapePowerShellSingle(target);
  const bounds=primary
    ? 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;$r=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;'
    : `Add-Type -AssemblyName System.Drawing;$r=[pscustomobject]@{X=${x};Y=${y};Width=${width};Height=${height}};`;
  return `$ErrorActionPreference='Stop';${bounds}if($r.Width -le 0 -or $r.Height -le 0 -or $r.Width -gt 8192 -or $r.Height -gt 8192 -or ($r.Width*$r.Height) -gt 16777216){throw 'Invalid or oversized display bounds'};$b=New-Object System.Drawing.Bitmap $r.Width,$r.Height;$g=$null;try{$g=[System.Drawing.Graphics]::FromImage($b);$g.CopyFromScreen($r.X,$r.Y,0,0,$b.Size);$b.Save('${safe}',[System.Drawing.Imaging.ImageFormat]::Png)}finally{if($g){$g.Dispose()};$b.Dispose()}`;
}

export async function screenshotRegion(args = {}) {
  const primary=args.monitor==='primary' && args.x==null && args.y==null
    && args.width==null && args.height==null;
  const x=Math.trunc(Number(args.x)),y=Math.trunc(Number(args.y)),width=Math.trunc(Number(args.width)),height=Math.trunc(Number(args.height));
  if(!primary && (![x,y,width,height].every(Number.isFinite)||width<=0||height<=0))
    throw new Error('x, y, width and height are required; width/height must be positive');
  if(!primary && (width>8192||height>8192||width*height>16_777_216))
    throw new Error('screenshot region is too large; width/height must be <= 8192 and area <= 16 megapixels');
  const dir=await tempDir('remcp-region-'),target=path.join(dir,'region.png');
  try{
    const script=windowsRegionCaptureScript({primary,x,y,width,height},target);
    await runPowerShell(script,{label:'screenshot region',timeout:30_000});
    const {data}=await readPrivateTempFile(target,4*1024*1024);
    const description=primary ? `Captured primary display ${data.readUInt32BE(16)}x${data.readUInt32BE(20)}.`
      : `Captured ${width}x${height} at ${x},${y}.`;
    return multi([{type:'text',text:description},image(data.toString('base64'),'image/png')]);
  }finally{await removeTemp(dir);}
}

export async function notification(args = {}) {
  const title=escapePowerShellSingle(optionalString(args.title)||'ReMCP');
  const body=escapePowerShellSingle(String(args.message??args.body??''));
  await runPowerShell(`$w=New-Object -ComObject WScript.Shell;[void]$w.Popup('${body}',${clamp(args.timeout_seconds,5,1,60)},'${title}',0x40)`,{label:'notification'});
  return text('Notification sent.');
}

export async function launchApp(app,argv=[],options={}) {
  const query=escapePowerShellSingle(String(app));
  const argsText=escapePowerShellSingle(argv.map(quoteWindowsArgument).join(' '));
  const argumentClause=argv.length?`-ArgumentList '${argsText}'`:'';
  const hasArgs=argv.length?'$true':'$false';
  const cwd=options.cwd?escapePowerShellSingle(String(options.cwd)):'';
  const hasCwd=cwd?'$true':'$false';
  const cwdClause=cwd?`-WorkingDirectory '${cwd}'`:'';
  const script=String.raw`
$ErrorActionPreference='Stop'
$name='${query}'
$mode='direct';$pidValue=$null;$resolved=$name
try{
 $p=Start-Process -FilePath $name ${argumentClause} ${cwdClause} -PassThru -ErrorAction Stop
 $pidValue=$p.Id
}catch{
 if(${hasArgs} -or ${hasCwd}){throw}
 $apps=@()
 if(Get-Command Get-StartApps -ErrorAction SilentlyContinue){$apps=@(Get-StartApps)}
 $row=$apps|Where-Object{$_.Name -ieq $name -or $_.AppID -ieq $name}|Select-Object -First 1
 if(-not $row){$row=$apps|Where-Object{$_.Name -like ('*'+$name+'*') -or $_.AppID -like ('*'+$name+'*')}|Sort-Object @{Expression={if($_.Name -like ($name+'*')){0}else{1}}},@{Expression={$_.Name.Length}}|Select-Object -First 1}
 if($row){
  $mode='start_menu';$resolved=$row.Name
  Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\'+$row.AppID) -ErrorAction Stop
 }else{
  $roots=@(
   (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
   (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
  )|Where-Object{$_ -and (Test-Path $_)}
  $links=@($roots|ForEach-Object{Get-ChildItem -LiteralPath $_ -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue})
  $link=$links|Where-Object{$_.BaseName -ieq $name}|Select-Object -First 1
  if(-not $link){$link=$links|Where-Object{$_.BaseName -like ('*'+$name+'*')}|Sort-Object @{Expression={if($_.BaseName -like ($name+'*')){0}else{1}}},@{Expression={$_.BaseName.Length}}|Select-Object -First 1}
  if(-not $link){throw ('Application not found by executable/path or Start Menu name: '+$name)}
  $mode='start_menu_link';$resolved=$link.BaseName
  Start-Process -FilePath $link.FullName -ErrorAction Stop
 }
}
[pscustomobject]@{requested=$name;resolved=$resolved;mode=$mode;pid=$pidValue}|ConvertTo-Json -Compress`;
  const raw=(await runPowerShell(script,{label:'launch app',timeout:15_000})).stdout.trim();
  const payload=raw?JSON.parse(raw):{requested:String(app),resolved:String(app),mode:'direct',pid:null};
  return `Launched ${payload.resolved} via ${payload.mode}${payload.pid?` (pid ${payload.pid})`:''}.`;
}

export async function openPath(target){await runPowerShell(`Start-Process -FilePath '${escapePowerShellSingle(target)}'`,{label:'open path'});}
export async function revealPath(target){spawnDetached('explorer.exe',['/select,',target]);}
