// Reusable, read-only Windows window inventory with private parent-child stdio.
// No listener, named pipe, TCP endpoint, dynamic evaluation, or GUI write command.
import {spawn} from 'node:child_process';
import path from 'node:path';
import {windowsPowerShellArguments} from './common.mjs';
import {windowsInteropLoad} from './windows-interop.mjs';

const MAX_LINE = 512 * 1024;
const MAX_PENDING = 4;
const IDLE_MS = 90_000;

export function windowInventoryWorkerScript() {
  return String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
${windowsInteropLoad('window-list')}
if([System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0){
 throw 'Windows window inventory requires an interactive user desktop'
}
while($true){
 $line=[Console]::ReadLine()
 if($null -eq $line){break}
 $requestId=0
 try{
  if($line.Length -gt 128){throw 'Oversized request'}
  $request=ConvertFrom-Json -InputObject $line -ErrorAction Stop
  $requestId=[int]$request.id
  if($requestId -le 0 -or $request.op -cne 'list_windows'){throw 'Unsupported request'}
  $processes=@{}
  $rows=New-Object System.Collections.ArrayList
  foreach($item in [RemcpWindowInventory]::Read()){
   $pidKey=[int]$item.Pid
   if(-not $processes.ContainsKey($pidKey)){
    try{$processes[$pidKey]=[System.Diagnostics.Process]::GetProcessById($pidKey).ProcessName}
    catch{$processes[$pidKey]=''}
   }
   $app=$processes[$pidKey]
   if([string]::IsNullOrWhiteSpace($app)){continue}
   [void]$rows.Add([pscustomobject]@{
    id=('0x{0:X}' -f $item.Handle);pid=$pidKey;app=[string]$app;title=$item.Title;
    active=$item.Active;minimized=$item.Minimized;maximized=$item.Maximized;
    x=$item.X;y=$item.Y;width=$item.Width;height=$item.Height
   })
  }
  $json=ConvertTo-Json -InputObject ($rows.ToArray()) -Compress -Depth 4
  [Console]::Out.WriteLine('{"id":'+$requestId+',"rows":'+$json+'}')
 }catch{
  [Console]::Out.WriteLine('{"id":'+$requestId+',"error":"Windows inventory failed"}')
 }
}
`;
}

export class WindowsWindowInventoryWorker {
  constructor({spawnFn=spawn, executable}={}) {
    const exe=executable || (process.env.SystemRoot
      ? path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe')
      : 'powershell.exe');
    this.pending=new Map();
    this.inFlight=null;
    this.sequence=0;
    this.hasAnswered=false;
    this.buffer='';
    this.closed=false;
    this.idle=null;
    this.child=spawnFn(exe,windowsPowerShellArguments(windowInventoryWorkerScript()),{
      stdio:['pipe','pipe','pipe'],windowsHide:true,detached:false
    });
    this.child.unref?.();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',chunk=>this.onData(chunk));
    this.child.stdin.on('error',()=>this.abort('Windows inventory IPC closed'));
    this.child.stdout.on('error',()=>this.abort('Windows inventory IPC read failed'));
    // No arbitrary stderr content is returned to callers or logs.
    this.child.stderr.on('data',()=>{});
    this.child.stderr.on('error',()=>{});
    this.child.on('error',()=>this.abort('Windows inventory worker could not start'));
    this.child.on('exit',()=>this.abort('Windows inventory worker exited'));
  }

  onData(chunk) {
    if(this.closed)return;
    this.buffer+=chunk;
    for(let pos;(pos=this.buffer.indexOf('\n'))!==-1;){
      if(pos>MAX_LINE){this.abort('Windows inventory response too large');return;}
      const line=this.buffer.slice(0,pos).replace(/\r$/,'');
      this.buffer=this.buffer.slice(pos+1);
      if(!line){this.abort('Invalid Windows inventory protocol');return;}
      let message;
      try{message=JSON.parse(line);}catch{this.abort('Invalid Windows inventory response');return;}
      const pending=this.pending.get(message?.id);
      if(!pending){this.abort('Unexpected Windows inventory response');return;}
      this.pending.delete(message.id);
      this.hasAnswered=true;
      clearTimeout(pending.timer);
      if(message.error){pending.reject(new Error('Windows inventory worker refused request'));}
      else if(Array.isArray(message.rows) && message.rows.length<=500){pending.resolve(message.rows);}
      else{pending.reject(new Error('Invalid Windows inventory rows'));}
      if(this.pending.size===0)this.scheduleIdle();
    }
    if(this.buffer.length>MAX_LINE)this.abort('Windows inventory response too large');
  }

  scheduleIdle() {
    clearTimeout(this.idle);
    // Do not keep a one-shot Node CLI alive just for the cache process.
    for(const pipe of [this.child.stdin,this.child.stdout,this.child.stderr])pipe.unref?.();
    this.idle=setTimeout(()=>this.abort('Windows inventory worker idle'),IDLE_MS);
    this.idle.unref?.();
  }

  read() {
    if(this.closed)return Promise.reject(new Error('Windows inventory worker unavailable'));
    // One live snapshot satisfies overlapping read-only requests. Do not cache
    // after completion: HWNDs and ownership can change between calls.
    if(this.inFlight)return this.inFlight.then(rows=>rows.map(row=>({...row})));
    if(this.pending.size>=MAX_PENDING)return Promise.reject(new Error('Windows inventory worker busy'));
    clearTimeout(this.idle);
    for(const pipe of [this.child.stdin,this.child.stdout,this.child.stderr])pipe.ref?.();
    const id=++this.sequence;
    const request=new Promise((resolve,reject)=>{
      // ARM64 PowerShell cold starts can exceed 10s; warmed calls stay bounded.
      const timer=setTimeout(()=>this.abort('Windows inventory worker timeout'),this.hasAnswered?5_000:30_000);
      timer.unref?.();
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({id,op:'list_windows'})+'\n',error=>{
        if(error)this.abort('Windows inventory IPC write failed');
      });
    });
    const shared=request.finally(()=>{if(this.inFlight===shared)this.inFlight=null;});
    this.inFlight=shared;
    // Each caller receives its own mutable result, so one tool consumer cannot
    // alter another consumer's identity observations while sharing the read.
    return shared.then(rows=>rows.map(row=>({...row})));
  }

  abort(reason) {
    if(this.closed)return;
    this.closed=true;
    clearTimeout(this.idle);
    for(const pending of this.pending.values()){
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    try{this.child.stdin.end();}catch{}
    try{this.child.kill();}catch{}
  }
}

let shared;
export async function readFastWindows() {
  if(!shared || shared.closed)shared=new WindowsWindowInventoryWorker();
  return shared.read();
}
