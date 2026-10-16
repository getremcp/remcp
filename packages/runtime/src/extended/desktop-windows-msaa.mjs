import { clamp, runPowerShell, escapePowerShellSingle, optionalString } from './common.mjs';

export async function msaaBrowserSnapshot(args = {}) {
  const maxNodes = clamp(args.max_nodes, 1200, 1, 5000);
  const maxDepth = clamp(args.max_depth, 64, 1, 128);
  const script = String.raw`
Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes;Add-Type -AssemblyName Accessibility
${windowsUiRootScript(args)}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RMAcc {
 [DllImport("oleacc.dll")]
 public static extern int AccessibleObjectFromWindow(IntPtr hwnd,uint dwId,ref Guid riid,[MarshalAs(UnmanagedType.Interface)] out object ppvObject);
 public static object FromWindow(IntPtr hwnd) {
  Guid iid=new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
  object value=null;
  int hr=AccessibleObjectFromWindow(hwnd,0xFFFFFFFCu,ref iid,out value);
  if(hr<0) Marshal.ThrowExceptionForHR(hr);
  return value;
 }
}
'@
$rootAcc=[Accessibility.IAccessible][RMAcc]::FromWindow($h)
$nodes=New-Object System.Collections.ArrayList
$seen=0
$truncated=$false
$interactive=@(30,33,34,36,37,43,44,45,46,47,51,56,60,62)
$informative=@(15,20,22,24,31,32,40,41,42)
function Get-RoleName([int]$role){
 switch($role){
  15{'Document'};20{'Group'};22{'Toolbar'};24{'Table'};30{'Link'};33{'List'};34{'ListItem'};35{'Tree'};36{'TreeItem'};37{'TabItem'};40{'Graphic'};41{'Text'};42{'Edit'};43{'Button'};44{'CheckBox'};45{'RadioButton'};46{'ComboBox'};47{'DropList'};51{'Slider'};56{'Button'};60{'TabList'};62{'Button'};default{'Accessible'}
 }
}
function Walk-Acc($acc,[int]$depth,[string]$path,[bool]$inDocument,[string]$parentId){
 if($null -eq $acc -or $depth -gt ${maxDepth} -or $script:seen -ge ${maxNodes}){if($script:seen -ge ${maxNodes}){$script:truncated=$true};return}
 $script:seen++
 try{$roleRaw=$acc.get_accRole(0);$role=[int]$roleRaw}catch{$role=-1}
 try{$state=[int]$acc.get_accState(0)}catch{$state=0}
 $invisible=(($state -band 0x8000) -ne 0) -or (($state -band 0x10000) -ne 0)
 if($depth -gt 0 -and $invisible){return}
 $isDocument=$role -eq 15
 $inside=$inDocument -or $isDocument
 $l=0;$t=0;$w=0;$hh=0;$hasRect=$true
 try{$acc.accLocation([ref]$l,[ref]$t,[ref]$w,[ref]$hh,0)}catch{$hasRect=$false}
 try{$name=[string]$acc.get_accName(0)}catch{$name=''}
 try{$value=[string]$acc.get_accValue(0)}catch{$value=''}
 $visible=$hasRect -and $w -gt 0 -and $hh -gt 0 -and -not $invisible
 if($inside -and $visible -and (($interactive -contains $role) -or ($informative -contains $role) -or $name -or $value)){
  $id='msaa:'+$rootPid+':'+$path
  $patterns=New-Object System.Collections.ArrayList
  if($role -in @(30,43,56,62)){[void]$patterns.Add('invoke')}
  if($role -in @(42,46,47)){[void]$patterns.Add('value')}
  if($role -in @(34,36,37,45)){[void]$patterns.Add('selection_item')}
  if($role -eq 44){[void]$patterns.Add('toggle')}
  if($role -eq 51){[void]$patterns.Add('range_value')}
  [void]$nodes.Add([pscustomobject]@{
   id=$id;parent_id=$parentId;depth=$depth;active=($depth -eq 0);pid=$rootPid;app=$rootApp;window=$windowName;
   name=$name;role=(Get-RoleName $role);localized_role=(Get-RoleName $role);automationId='';className='';frameworkId='MSAA';
   enabled=$true;offscreen=$false;focused=(($state -band 0x4) -ne 0);focusable=(($state -band 0x100000) -ne 0);password=$false;
   value=$value;patterns=@($patterns);x=[int]$l;y=[int]$t;width=[int]$w;height=[int]$hh
  })
  $parentId=$id
 }
 try{$count=[int]$acc.accChildCount}catch{$count=0}
 for($i=1;$i -le $count;$i++){
  if($script:seen -ge ${maxNodes}){$script:truncated=$true;break}
  try{$child=$acc.get_accChild($i)}catch{continue}
  if($child -is [Accessibility.IAccessible]){
   Walk-Acc $child ($depth+1) ($path+'.'+$i) $inside $parentId
  }
 }
}
Walk-Acc $rootAcc 0 'r' $false $null
[pscustomobject]@{platform='win32';count=$nodes.Count;nodes=@($nodes);truncated=$truncated;max_nodes=${maxNodes};browser_dom=[pscustomobject]@{requested=$true;available=($nodes.Count -gt 0);provider='msaa-iaccessible'}}|ConvertTo-Json -Compress -Depth 7`;
  const { stdout } = await runPowerShell(script, { label:'MSAA browser accessibility snapshot', timeout:30_000 });
  return stdout.trim() ? JSON.parse(stdout) : { platform:'win32', count:0, nodes:[], browser_dom:{ requested:true, available:false, provider:'msaa-iaccessible' } };
}

export function windowsUiRootScript(args = {}) {
  const pid = Number.isInteger(Number(args.pid)) ? Number(args.pid) : 0;
  const app = escapePowerShellSingle(optionalString(args.app) || '');
  const title = escapePowerShellSingle(optionalString(args.window_title || args.windowTitle) || '');
  const scoped = pid > 0 || app || title;
  const selector = scoped
    ? `$p=Get-Process|Where-Object{$_.MainWindowHandle -ne 0 -and (${pid} -eq 0 -or $_.Id -eq ${pid}) -and ('${app}' -eq '' -or $_.ProcessName -like '*${app}*') -and ('${title}' -eq '' -or $_.MainWindowTitle -like '*${title}*')}|Select-Object -First 1;if(-not $p){throw 'No matching UI window found'};$h=$p.MainWindowHandle`
    : '$h=[RMFG]::GetForegroundWindow()';
  return String.raw`
Add-Type @'
using System;using System.Runtime.InteropServices;
public static class RMFG{
 [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
}
'@
$h=[IntPtr]::Zero
${selector}
if($h -eq [IntPtr]::Zero){throw 'No foreground UI window is available'}
$root=[System.Windows.Automation.AutomationElement]::FromHandle($h)
if(-not $root){throw 'Could not create UI Automation root'}
$windowName=$root.Current.Name
$rootPid=$root.Current.ProcessId
try{$rootApp=(Get-Process -Id $rootPid -ErrorAction Stop).ProcessName}catch{$rootApp=''}
`;
}
