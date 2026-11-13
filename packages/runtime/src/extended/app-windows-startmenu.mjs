// Read-only Windows Start Menu GUI shortcut inventory. Never execute targets.
import path from 'node:path';
import {escapePowerShellSingle,jsonResult,runPowerShell} from './common.mjs';

const safeLabel=value=>typeof value==='string'&&value.trim().length>0&&
  value.length<=180&&!/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
const driveExe=value=>typeof value==='string'&&value.length<1024&&
  /^[A-Za-z]:\\[^<>"|?*\r\n]*\.exe$/i.test(value)&&
  !value.split('\\').includes('..')&&
  !/[\u202a-\u202e\u2066-\u2069]/u.test(value);
const shortcutPath=value=>typeof value==='string'&&value.length<1024&&
  /^[A-Za-z]:\\[^<>"|?*\r\n]*\.lnk$/i.test(value)&&
  !value.split('\\').includes('..')&&
  !/[\u202a-\u202e\u2066-\u2069]/u.test(value);

export function windowsStartMenuScript(){
  return String.raw`
$ErrorActionPreference='Stop'
$roots=@([Environment]::GetFolderPath('Programs'),[Environment]::GetFolderPath('CommonPrograms')) |
  Where-Object{$_ -and [IO.Path]::IsPathRooted($_)}
$rows=New-Object System.Collections.ArrayList
$seen=@{}
$stack=New-Object System.Collections.Stack
foreach($root in @($roots)){
  if(Test-Path -LiteralPath $root -PathType Container){
    $stack.Push(@($root,0))
  }
}
$shell=New-Object -ComObject WScript.Shell
$scanned=0;$directories=0;$partial=$false
while($stack.Count -gt 0 -and $directories -lt 200 -and
  $scanned -lt 800 -and $rows.Count -lt 400){
  $item=$stack.Pop();$dir=[string]$item[0];$depth=[int]$item[1];$directories++
  try{$children=@(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop |
    Select-Object -First 501)}catch{continue}
  if($children.Count -gt 500){$partial=$true;$children=@($children | Select-Object -First 500)}
  foreach($entry in $children){
    if($scanned -ge 800 -or $rows.Count -ge 400){break}
    if(([int]$entry.Attributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0){continue}
    if(([int]$entry.Attributes -band [int][IO.FileAttributes]::Hidden) -ne 0){continue}
    if($entry.PSIsContainer){
      if($depth -lt 5){$stack.Push(@($entry.FullName,$depth+1))}
      continue
    }
    if($entry.Extension -ine '.lnk'){continue}
    $scanned++
    if($seen.ContainsKey([string]$entry.FullName)){continue}
    $seen[[string]$entry.FullName]=$true
    try{
      $lnk=$shell.CreateShortcut([string]$entry.FullName)
      $target=[string]$lnk.TargetPath
    }catch{continue}
    if($target -notmatch '^[A-Za-z]:\\' -or
      -not $target.EndsWith('.exe',[StringComparison]::OrdinalIgnoreCase)){continue}
    $binary=[IO.Path]::GetFileNameWithoutExtension($target)
    if($binary -match '^(cmd|powershell|pwsh|wscript|cscript|mshta|explorer|rundll32|regsvr32|conhost)$'){continue}
    # A shortcut with arguments may identify a browser profile or wrapper,
    # not the selected executable's default application. Fail closed.
    if(-not [string]::IsNullOrWhiteSpace([string]$lnk.Arguments)){continue}
    $label=[IO.Path]::GetFileNameWithoutExtension($entry.Name)
    [void]$rows.Add([pscustomobject]@{
      name=$label;shortcut_id=[string]$entry.FullName
      target_path=$target;source='windows_startmenu_shortcut'
    })
  }
}
[pscustomobject]@{data=@($rows.ToArray());scanned=$scanned;
  truncated=($partial -or $directories -ge 200 -or
    $scanned -ge 800 -or $rows.Count -ge 400)} |
  ConvertTo-Json -Depth 4 -Compress
`;
}

export function parseWindowsShortcutInventory(value){
  if(!value||typeof value!=='object')throw Error('Invalid Start Menu response');
  const rows=[],ids=new Set();
  const candidates=Array.isArray(value.data)?value.data:[];
  for(const item of candidates.slice(0,800)){
    const name=item?.name,shortcut_id=item?.shortcut_id;
    const target_path=item?.target_path;
    if(!safeLabel(name)||!shortcutPath(shortcut_id)||!driveExe(target_path))
      continue;
    const key=shortcut_id.toLowerCase();
    if(ids.has(key))continue;
    ids.add(key);
    const base=path.win32.basename(target_path).replace(/\.exe$/i,'');
    if(!safeLabel(base)||
      /^(?:cmd|powershell|pwsh|wscript|cscript|mshta|explorer|rundll32|regsvr32|conhost)$/i.test(base))
      continue;
    rows.push({name:name.trim(),shortcut_id,target_path,
      process_hint:base,source:'windows_startmenu_shortcut'});
  }
  rows.sort((a,b)=>a.name.localeCompare(b.name)||a.shortcut_id.localeCompare(b.shortcut_id));
  return {backend:'windows_startmenu_shortcuts',data:rows,count:rows.length,
    returned:rows.length,inventory_truncated:value.truncated===true||candidates.length>800,
    inspected_files:Number.isInteger(value.scanned)?value.scanned:0};
}

export async function windowsGuiInventory(options={}){
  const invoke=options.runPowerShellFn||runPowerShell;
  const {stdout}=await invoke(windowsStartMenuScript(),{
    label:'read Windows Start Menu shortcuts',timeout:25_000,
    maxBuffer:2*1024*1024});
  let parsed;
  try{parsed=JSON.parse(String(stdout||'').trim())}
  catch{throw Error('Invalid JSON from Windows Start Menu inventory')}
  return jsonResult(parseWindowsShortcutInventory(parsed));
}

// Some packaged desktop processes deny Get-Process.Path in a standard
// session. QueryFullProcessImageName needs only PROCESS_QUERY_LIMITED_INFORMATION.
const limitedProcessImageFallback=String.raw`
 if([string]::IsNullOrEmpty($actual)){
$source=@'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RemcpGuiProcessImage {
 [DllImport("kernel32.dll", SetLastError=true)]
 public static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 [return: MarshalAs(UnmanagedType.Bool)]
 public static extern bool QueryFullProcessImageName(IntPtr h,uint flags,StringBuilder name,ref uint size);
 [DllImport("kernel32.dll", SetLastError=true)]
 public static extern bool CloseHandle(IntPtr h);
}
'@
  Add-Type -TypeDefinition $source -ErrorAction Stop
  $h=[RemcpGuiProcessImage]::OpenProcess(4096,$false,__PID__)
  if($h -ne [IntPtr]::Zero){
    try{
      $buf=[System.Text.StringBuilder]::new(1024)
      $length=[uint32]1024
      if([RemcpGuiProcessImage]::QueryFullProcessImageName($h,0,$buf,[ref]$length)){
        $actual=$buf.ToString()
      }
    }finally{[void][RemcpGuiProcessImage]::CloseHandle($h)}
  }
}
`;
// A shortcut identifies a candidate executable, never a process identity.
// UWP/packaged windows may have an empty .NET Process.Path. Use only the
// read-only PROCESS_QUERY_LIMITED_INFORMATION right for a native fallback.
export function windowsPidExecutableCheckScript(targetPath,pid){
  if(!driveExe(targetPath)||!Number.isSafeInteger(pid)||pid<=0)return null;
  const expected=escapePowerShellSingle(targetPath);
  return [
    "$ErrorActionPreference='Stop'",
    'try{',
    ' $process=Get-Process -Id '+pid+' -ErrorAction Stop',
    " $actual='';try{$actual=[string]$process.Path}catch{$actual=''}",
    limitedProcessImageFallback.replace('__PID__',String(pid)),
    " $expected='"+expected+"'",
    ' $verified=($actual.Length -gt 0 -and',
    '   [string]::Equals($actual,$expected,[StringComparison]::OrdinalIgnoreCase))',
    ' [pscustomobject]@{verified=$verified}|ConvertTo-Json -Compress',
    '}catch{[pscustomobject]@{verified=$false}|ConvertTo-Json -Compress}',
  ].join('\n');
}
// Return only a boolean. If both .NET and native reads fail, deny the action.
export async function windowsShortcutPidVerified(targetPath,pid,
  {runPowerShellFn=runPowerShell}={}){
  const script=windowsPidExecutableCheckScript(targetPath,pid);
  if(!script)return false;
  try{
    const result=await runPowerShellFn(script,{label:'Windows GUI process provenance',
      timeout:15000,maxBuffer:16*1024});
    return JSON.parse(String(result.stdout||'').trim())?.verified===true;
  }catch{return false}
}
