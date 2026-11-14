// Read-only Win32 top-level window inventory. One process can own many windows:
// Get-Process.MainWindowHandle is not a complete enumeration.
import {jsonResult,runPowerShell} from './common.mjs';
import { windowsInteropLoad } from './windows-interop.mjs';
import { readFastWindows } from './desktop-windows-window-worker.mjs';

export async function listWindows(_args={}, {
  runPowerShellFn=runPowerShell,
  fastReadFn=readFastWindows,
  // A new persistent PowerShell child must never start by default on
  // user desktops during a WebRTC-only runtime update.
  preferFast=process.platform==='win32' && process.env.REMCP_WINDOWS_WINDOW_IPC==='1' && runPowerShellFn===runPowerShell,
}={}){
  // Private stdio child IPC: process and verified Win32 helper are initialized
  // only once. Fall back to the established read-only path on IPC failure.
  if(preferFast){
    try{return jsonResult(await fastReadFn());}
    catch(error){
      if(process.env.REMCP_WINDOWS_WINDOW_IPC_STRICT==='1')throw error;
    }
  }
  const script=String.raw`
${windowsInteropLoad('window-list')}
if([System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0){
 throw 'Windows window inventory requires an interactive user desktop'
}
$processes=@{}
Get-Process -ErrorAction SilentlyContinue|ForEach-Object{$processes[[int]$_.Id]=$_.ProcessName}
$rows=New-Object System.Collections.ArrayList
foreach($item in [RemcpWindowInventory]::Read()){
 $app=$processes[[int]$item.Pid]
 if([string]::IsNullOrWhiteSpace($app)){continue}
 [void]$rows.Add([pscustomobject]@{
  id=('0x{0:X}' -f $item.Handle);pid=$item.Pid;app=[string]$app;title=$item.Title;
  active=$item.Active;minimized=$item.Minimized;maximized=$item.Maximized;
  x=$item.X;y=$item.Y;width=$item.Width;height=$item.Height
 })
}
@($rows.ToArray())|ConvertTo-Json -Compress -Depth 4`;
  const {stdout}=await runPowerShellFn(script,{label:'list windows',timeout:15000});
  const parsed=String(stdout||'').trim()?JSON.parse(stdout):[];
  return jsonResult(Array.isArray(parsed)?parsed:[parsed]);
}
