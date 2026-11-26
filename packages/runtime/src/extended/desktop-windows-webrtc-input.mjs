// Private, bounded input worker for an already admitted Windows WebRTC capture.
// The parent owns session/sequence validation; no network or dynamic code IPC.
import {spawn} from 'node:child_process';
import path from 'node:path';
import {windowsPowerShellArguments} from './common.mjs';
import {windowsInteropLoad} from './windows-interop.mjs';
import {parseWebRtcControlInput} from './webrtc-control-contract.mjs';

const FAST_KINDS=new Set(['pointer','drag','scroll','keyboard','text']);
const supports=input=>FAST_KINDS.has(input?.kind)&&
 (input.kind!=='text'||(typeof input.text==='string'&&!/[\r\n\t]/.test(input.text)));
const MAX_REPLY=512;
export function windowsWebRtcInputScript(){
 return String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
${windowsInteropLoad('pointer')}
function AssertInteractive {
 if([System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0 -or -not [Environment]::UserInteractive -or -not [RMMouse]::InteractiveDesktop()){
  throw 'Windows input requires an interactive desktop'
 }
}
function MovePointer([double]$x,[double]$y) {
 if($x -lt 0 -or $x -gt 1 -or $y -lt 0 -or $y -gt 1){throw 'Invalid coordinates'}
 $r=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
 if($r.Width -lt 1 -or $r.Height -lt 1 -or $r.Width -gt 16384 -or $r.Height -gt 16384){throw 'Invalid display'}
 $px=$r.X+[int][Math]::Round($x*($r.Width-1),[MidpointRounding]::AwayFromZero)
 $py=$r.Y+[int][Math]::Round($y*($r.Height-1),[MidpointRounding]::AwayFromZero)
 if(-not [RMMouse]::SetCursorPos($px,$py)){throw 'Windows refused pointer position'}
}
function MouseFlags([string]$button) {
 switch -CaseSensitive ($button) {
  'left' {return @(2,4)}
  'right' {return @(8,16)}
  'middle' {return @(32,64)}
  default {throw 'Invalid pointer button'}
 }
}
function MouseEvent([uint32]$flag,[int]$delta=0){
 if(-not [RMMouse]::SendMouseFlag($flag,$delta)){throw "Windows refused mouse input"}
}
AssertInteractive
while($true){
 $line=[Console]::ReadLine()
 if($null -eq $line){break}
 $seq=0
 try{
  if($line.Length -gt 32768){throw 'Oversized input'}
  $q=ConvertFrom-Json -InputObject $line -ErrorAction Stop
  $seq=[int]$q.seq
  if($seq -lt 1){throw 'Invalid sequence'}
  AssertInteractive
  switch -CaseSensitive ($q.kind) {
   'pointer' {
    if($q.op -cnotin @('move','click','right_click','double_click')){throw 'Invalid pointer operation'}
    MovePointer $q.x $q.y
    if($q.op -ceq 'move'){break}
    $f=MouseFlags $q.button
    $count=1
    if($q.op -ceq 'double_click'){$count=2}
    for($i=0;$i -lt $count;$i++){
     AssertInteractive
     if(-not [RMMouse]::SendMouseClick($f[0],$f[1])){throw "Windows refused click"}
     if($i+1 -lt $count){Start-Sleep -Milliseconds 50}
    }
   }
   'drag' {
    $f=MouseFlags $q.button
    MovePointer $q.from_x $q.from_y
    MouseEvent $f[0]
    try{
     Start-Sleep -Milliseconds 120
     AssertInteractive
     MovePointer $q.to_x $q.to_y
     Start-Sleep -Milliseconds 160
    }finally{MouseEvent $f[1]}
   }
   'scroll' {
    if([Math]::Abs([double]$q.dx) -gt 1200 -or [Math]::Abs([double]$q.dy) -gt 1200){throw 'Invalid scroll'}
    MovePointer $q.x $q.y
    if($q.dy -ne 0){MouseEvent 0x0800 (-[int][Math]::Truncate($q.dy))}
    if($q.dx -ne 0){MouseEvent 0x1000 ([int][Math]::Truncate($q.dx))}
   }
   'keyboard' {
    if($q.shortcut -cnotmatch '^[A-Za-z0-9+_-]{1,64}$'){throw 'Invalid shortcut'}
    $tokens=@($q.shortcut.Split('+') | Where-Object {$_})
    if($tokens.Length -lt 1){throw 'Invalid shortcut'}
    $mods=@{ctrl=17;control=17;alt=18;shift=16}
    $special=@{enter=13;return=13;esc=27;escape=27;tab=9;backspace=8;delete=46;up=38;down=40;left=37;right=39;home=36;end=35;pageup=33;pagedown=34;space=32}
    $keys=New-Object 'System.Collections.Generic.List[int]'
    for($i=0;$i -lt $tokens.Length-1;$i++){
     if(-not $mods.ContainsKey($tokens[$i])){throw 'Unsupported modifier'}
     $keys.Add([int]$mods[$tokens[$i]])
    }
    $key=$tokens[-1]
    if($special.ContainsKey($key)){$vk=[int]$special[$key]}
    elseif($key -match '^[A-Za-z0-9]$'){$vk=[int][char]$key.ToUpperInvariant()}
    elseif($key -match '^F([1-9]|1[0-9]|2[0-4])$'){$vk=111+[int]$key.Substring(1)}
    elseif($key -ceq '-'){$vk=189}
    elseif($key -ceq '_'){$vk=189;if(-not $keys.Contains(16)){$keys.Add(16)}}
    else{throw 'Unsupported key'}
    $keys.Add($vk)
    if(-not [RMMouse]::SendKeyChord($keys.ToArray())){throw 'Windows refused keyboard input'}
   }
   'text' {
    $value=[string]$q.text
    if($value.Length -lt 1 -or $value.Length -gt 4096){throw 'Invalid text length'}
    if(-not [RMMouse]::SendUnicodeText($value)){throw 'Windows refused text input'}
   }
   default {throw 'Unsupported input'}
  }
  [Console]::Out.WriteLine('{"seq":'+$seq+',"ok":true}')
 }catch{
  [Console]::Out.WriteLine('{"seq":'+$seq+',"ok":false}')
 }
}
`;
}

function createWorker(spawnFn,env,deadlineMs,idleMs,onClose){
 const root=env.SystemRoot||'C:\\Windows';
 const executable=path.win32.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const allowed=['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','HOME'];
 const workerEnv=Object.fromEntries(allowed.filter(k=>typeof env[k]==='string').map(k=>[k,env[k]]));
 workerEnv.PATH=path.win32.join(root,'System32');
 const child=spawnFn(executable,windowsPowerShellArguments(windowsWebRtcInputScript()),{
  stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true,env:workerEnv,
 });
 let pending=null,buffer='',closing=false,closed=false,idle=null,escalate=null,failure=null,resolveClosed;
 const done=new Promise(resolve=>{resolveClosed=resolve;});
 const clearIdle=()=>{clearTimeout(idle);idle=null;};
 const finish=(error)=>{
  const p=pending;pending=null;
  if(!p)return;
  clearTimeout(p.timer);
  if(error)p.reject(error);else p.resolve();
 };
 const terminate=(error=null)=>{
  if(error&&!failure)failure=error;
  if(closed||closing)return done;
  closing=true;clearIdle();
  try{child.stdin.end();}catch{}
  escalate=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},800);
  return done;
 };
 child.stdout.setEncoding('utf8');
 child.stdout.on('data',chunk=>{
  if(closing)return;
  buffer+=chunk;
  if(buffer.length>MAX_REPLY){void terminate(new Error('Invalid Windows input acknowledgement'));return;}
  const index=buffer.indexOf('\n');
  if(index<0)return;
  let reply;
  try{reply=JSON.parse(buffer.slice(0,index));}catch{}
  buffer=buffer.slice(index+1);
  if(buffer||!pending||reply?.seq!==pending.seq||typeof reply.ok!=='boolean'||Object.keys(reply).length!==2){
   void terminate(new Error('Invalid Windows input acknowledgement'));return;
  }
  if(reply.ok!==true){void terminate(new Error('Windows input was refused'));return;}
  finish(null);
  idle=setTimeout(()=>void terminate(),idleMs);
 });
 child.stderr.on('data',()=>{});
 for(const pipe of [child.stdin,child.stdout,child.stderr])
  pipe.on('error',()=>void terminate(new Error('Windows input worker pipe failed')));
 child.once('error',()=>void terminate(new Error('Windows input worker failed')));
 child.once('close',()=>{
  closed=true;closing=true;clearIdle();clearTimeout(escalate);
  finish(failure||new Error('Windows input worker exited'));
  resolveClosed();onClose();
 });
 // A warmup that receives no input must also expire.
 idle=setTimeout(()=>void terminate(),idleMs);
 return {
  get closing(){return closing;},done,close:terminate,
  dispatch(input){
   if(closing||pending)return Promise.reject(new Error('Windows input worker unavailable'));
   clearIdle();
   return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>void terminate(new Error('Windows input acknowledgement timed out')),deadlineMs);
    pending={seq:input.seq,resolve,reject,timer};
    try{child.stdin.write(JSON.stringify(input)+'\n',error=>{if(error)void terminate(new Error('Windows input write failed'));});}
    catch{void terminate(new Error('Windows input write failed'));}
   });
  },
 };
}

export function createWindowsWebRtcInput({spawnFn=spawn,env=process.env,deadlineMs=9_000,idleMs=10*60_000}={}){
 let worker=null;
 const prepare=()=>{
  if(worker)return;
  let instance;
  instance=createWorker(spawnFn,env,deadlineMs,idleMs,()=>{if(worker===instance)worker=null;});
  worker=instance;
 };
 return {
  prepare,
  supports,
  async dispatch(input,{signal}={}){
   const parsed=parseWebRtcControlInput(input);
   if(!parsed||!supports(parsed))throw new Error('Invalid Windows input');
   if(signal?.aborted)throw new Error('Windows input cancelled');
   if(worker?.closing)await worker.done;
   if(signal?.aborted)throw new Error('Windows input cancelled');
   prepare();
   await worker.dispatch(parsed);
   if(signal?.aborted)throw new Error('Windows input cancelled');
  },
  async close(){if(worker)await worker.close();},
 };
}

