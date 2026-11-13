// Fast Linux-only read-only process preflight for guided desktop inspection.
// Absence never proves an app is not installed; it only avoids a costly AT-SPI
// desktop scan when none of its registered process names is currently running.
import { readdirSync, readFileSync } from 'node:fs';

export function recognizedProcessName(comm,windowsNames) {
  const value=String(comm||'').trim().toLowerCase().replace(/\.exe$/,'');
  if(!value) return false;
  return (windowsNames||[]).some(raw=>{
    const expected=String(raw||'').trim().toLowerCase().replace(/\.exe$/,'');
    // Linux task names are limited to 15 visible bytes (TASK_COMM_LEN).
    // A truncated match only permits further inspection; it never grants
    // permission to act. Accessibility must still match the full app PID.
    return expected && (expected===value ||
      (expected.length>15 && value===expected.slice(0,15)));
  });
}

export function linuxRegisteredProcessState(windowNames,{
  procRoot='/proc',list=readdirSync,read=readFileSync,maxEntries=4096
}={}) {
  if(!Array.isArray(windowNames)||windowNames.length===0)
    return {state:'unknown',reason:'no_registered_process_name'};
  let entries;
  try {entries=list(procRoot);}catch{return {state:'unknown',reason:'proc_unavailable'};}
  if(!Array.isArray(entries))return {state:'unknown',reason:'proc_unavailable'};
  let checked=0,discovered=0;
  for(const entry of entries){
    const pid=String(entry);
    if(!/^[1-9]\d{0,9}$/.test(pid))continue;
    discovered++;
    if(discovered>maxEntries)return {state:'unknown',reason:'process_budget_exceeded'};
    try {
      const comm=String(read(procRoot+'/'+pid+'/comm','utf8')).trim();
      checked++;
      if(recognizedProcessName(comm,windowNames))return {state:'running'};
    }catch { /* process exited between enumeration and reading, or invisible */ }
  }
  // If /proc is masked or unreadable, never claim absence from no data.
  if(checked===0)return {state:'unknown',reason:'no_readable_processes'};
  return {state:'not_found',reason:'registered_process_not_running'};
}
