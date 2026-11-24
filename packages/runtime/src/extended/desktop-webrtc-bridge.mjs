import {validateDeviceIce} from './webrtc-device-ice-contract.mjs';
import {createWebRtcSessionControl} from './desktop-webrtc-control.mjs';
// Optional owner-installed media: device RPC -> isolated aiortc worker over
// private stdio. Native capture still requires the operating system permission.
import {spawn} from 'node:child_process';
import {existsSync,lstatSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {jsonResult} from './common.mjs';
import {windowsNativeWorkerTrusted,windowsWorkerAclCache} from './webrtc-windows-trust.mjs';
import {windowsFrozenQaTrusted} from './webrtc-windows-frozen.mjs';
import {posixFrozenQaTrusted} from './webrtc-posix-frozen.mjs';
import {windowsKillWorkerTree} from './webrtc-windows-tree-kill.mjs';
import {readWindowsPrivateTurn} from './webrtc-windows-private-turn.mjs';

const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_SDP=60_000, MAX_LINE=70_000;
const MAX_IDLE_MS=45_000, MAX_OFFER_MS=64_000, MAX_AGE_MS=600_000;
const NATIVE_SOURCE={linux:'portal',darwin:'avfoundation',win32:'gdigrab'};
const LINUX_TEST_SOURCES=new Set(['synthetic','gst-test']);
function workerSource(env,platform){
  const native=NATIVE_SOURCE[platform];
  if(!native)return null;
  const source=env.REMCP_WEBRTC_DEV_SOURCE||native;
  if(source===native)return source;
  if(platform==='linux'&&source==='x11'&&!env.WAYLAND_DISPLAY&&env.XDG_SESSION_TYPE!=='wayland'&&/^:[0-9]{1,3}(?:\.[0-9]{1,2})?$/.test(env.DISPLAY||''))return source;
  return platform==='linux'&&LINUX_TEST_SOURCES.has(source)&&
    env.REMCP_WEBRTC_ALLOW_TEST_SOURCE==='1'?source:null;
}

function trustedLocalFile(filename,platform=process.platform,env=process.env){
  if(!filename||!path.isAbsolute(filename)||!existsSync(filename))return false;
  if(platform==='win32'&&process.platform==='win32')
    return windowsNativeWorkerTrusted(filename,{env,cache:windowsWorkerAclCache});
  try{
    const info=lstatSync(filename);
    return info.isFile()&&!info.isSymbolicLink()&&(info.mode&0o022)===0&&
      (typeof process.getuid!=='function'||info.uid===process.getuid()||info.uid===0);
  }catch{return false;}
}

export function webRtcWorkerAvailable(env=process.env,platform=process.platform){
  if(env.REMCP_WEBRTC_RUNTIME_PILOT!=='1'||!workerSource(env,platform))return false;
  if(env.REMCP_WEBRTC_FROZEN_WORKER){
    // Local, pinned, owner-approved QA only: no unsigned worker is accepted
    // by a normal runtime or mixed with the Python/script launch mode.
    if(env.REMCP_WEBRTC_WORKER_SCRIPT||env.REMCP_WEBRTC_PYTHON)
      return false;
    return platform==='win32'&&process.platform==='win32'
      ? windowsFrozenQaTrusted(env.REMCP_WEBRTC_FROZEN_WORKER,{env})
      : (platform==='linux'||platform==='darwin')&&
        posixFrozenQaTrusted(env.REMCP_WEBRTC_FROZEN_WORKER,{env,platform});
  }
  if(!trustedLocalFile(env.REMCP_WEBRTC_WORKER_SCRIPT,platform,env)||
     !path.isAbsolute(env.REMCP_WEBRTC_PYTHON||''))return false;
  return existsSync(env.REMCP_WEBRTC_PYTHON);
}

export function createDesktopWebRtcBridge({
  env=process.env,platform=process.platform,spawnChild=spawn,
  now=Date.now,setIntervalFn=setInterval,clearIntervalFn=clearInterval,
  workerAvailable=webRtcWorkerAvailable,
  killProcessTree=windowsKillWorkerTree,
  privateTurnReader=readWindowsPrivateTurn,
  stopExitTimeoutMs=5_000,frozenStopExitTimeoutMs=15_000,
  terminationEscalationMs=3_000,
}={}){
  if(!Number.isSafeInteger(stopExitTimeoutMs)||stopExitTimeoutMs<100||
     stopExitTimeoutMs>10_000||
     !Number.isSafeInteger(frozenStopExitTimeoutMs)||
     frozenStopExitTimeoutMs<100||frozenStopExitTimeoutMs>30_000||
     !Number.isSafeInteger(terminationEscalationMs)||
     terminationEscalationMs<100||terminationEscalationMs>10_000)
    throw new RangeError('Invalid WebRTC native Stop exit deadline');
  let child=null, current=null, active=false, started=0, seen=0;
  let stdout='', sequence=0, clock=null, pendingExit=null;
  let lastExitedSession=null,inputEnabled=false,inputStopping=false,inputEpoch='',stopRequest=null;
  const waits=new Map();

  function rejectWaits(){
    for(const pending of waits.values()){
      clearTimeout(pending.timer);
      pending.reject(new Error('WebRTC worker disconnected'));
    }
    waits.clear();
  }
  // A SIGTERM request or stdio Stop ACK is NOT evidence of process exit.
  // Hold a local admission fence until the kernel reports the child exit.
  // This covers the direct child only, not escaped descendants: production
  // still requires separate verified process-tree containment.
  function shutdown(alreadyExited=false){
    if(clock){clearIntervalFn(clock);clock=null;}
    const target=child,session=current;
    const frozenTree=platform==='win32'&&Boolean(env.REMCP_WEBRTC_FROZEN_WORKER);
    child=null;current=null;active=false;inputEnabled=false;stdout='';
    rejectWaits();
    if(!target)return pendingExit?.promise??Promise.resolve(false);
    let confirmExit;
    const exited=new Promise(resolve=>{confirmExit=resolve;});
    const marker={target,promise:exited,session};
    pendingExit=marker;
    let escalation;
    const onExit=()=>{
      target.removeListener('exit',onExit);
      target.removeListener('close',onExit);
      if(escalation)clearTimeout(escalation);
      if(pendingExit===marker)pendingExit=null;
      lastExitedSession=session;
      confirmExit(true);
    };
    // Node may emit error + close without exit when spawning the worker fails.
    // An exit event alone proves only the direct launcher died: a capture
    // descendant may still hold the inherited stdout pipe. Require close
    // after all attached stdio drains on ALL platforms, including POSIX.
    // This remains weaker than independently verified cgroup/pidfd Stop.
    target.once('close',onExit);
    if(alreadyExited){
      onExit();
    }else if(frozenTree){
      // Closing the private stdio pipe makes the frozen child clean up its
      // capture and bootloader. Never first kill only the onefile parent:
      // abrupt TerminateProcess can orphan its still-capturing child.
      if(!target.killed){
        try{target.stdin.end();}catch{}
      }
      escalation=setTimeout(()=>{
        if(pendingExit!==marker)return;
        // Windows' system taskkill /T /F terminates the parent AND children.
        // The PID must come directly from this previously verified spawn.
        // On failure retain the local quarantine rather than granting Stop.
        try{
          void Promise.resolve(killProcessTree(target.pid,{env})).catch(()=>false);
        }catch{
          // Keep the admission fence until native stdout/pipes really close.
        }
      },terminationEscalationMs);
      escalation.unref?.();
    }else{
      // Only signal the child spawned by this bridge. SIGKILL is a bounded
      // escalation, not a Stop proof: never release the fence without exit.
      escalation=setTimeout(()=>{
        if(pendingExit!==marker)return;
        try{target.kill('SIGKILL');}catch{}
      },terminationEscalationMs);
      escalation.unref?.();
      if(!target.killed){
        try{target.stdin.end();target.kill('SIGTERM');}catch{}
      }
    }
    return exited;
  }
  function receive(chunk){
    stdout+=chunk.toString('utf8');
    if(Buffer.byteLength(stdout)>MAX_LINE*2)return shutdown();
    for(let index; (index=stdout.indexOf('\n'))!==-1;){
      const line=stdout.slice(0,index);stdout=stdout.slice(index+1);
      if(Buffer.byteLength(line)>MAX_LINE)return shutdown();
      let message;
      try{message=JSON.parse(line);}catch{return shutdown();}
      const entry=waits.get(message?.requestId);
      if(!entry)continue;
      waits.delete(message.requestId);
      clearTimeout(entry.timer);
      if(message.ok===true)entry.resolve(message);
      else {
        const code=['PermissionError','ValueError','WorkerFailed','Cancelled']
          .includes(message.error)?message.error:'InvalidResponse';
        entry.reject(new Error('WebRTC worker refused command: '+code));
      }
    }
  }
  function expired(){
    // The OS consent picker may remain pending for up to 45 seconds.
    // This longer bounded startup window applies ONLY until a media answer;
    // after negotiation the normal 45-second live heartbeat applies.
    return current!==null&&(now()-started>=MAX_AGE_MS||
      (active?now()-seen>=MAX_IDLE_MS:now()-started>=MAX_OFFER_MS));
  }
  function send(op,sid,args={},timeout=5000){
    if(!child||child.killed||!child.stdin.writable)
      return Promise.reject(new Error('WebRTC worker unavailable'));
    const requestId=++sequence;
    const message=JSON.stringify({requestId,op,session_id:sid,...args})+'\n';
    if(Buffer.byteLength(message)>MAX_LINE)
      return Promise.reject(new Error('WebRTC request too large'));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        waits.delete(requestId);
        reject(new Error('WebRTC worker request timed out'));
      },timeout);
      timer.unref?.();
      waits.set(requestId,{timer,resolve,reject});
      try{
        child.stdin.write(message,error=>{
          if(!error)return;
          if(!waits.delete(requestId))return;
          clearTimeout(timer);
          reject(new Error('WebRTC worker pipe write failed'));
        });
      }catch{
        waits.delete(requestId);
        clearTimeout(timer);
        reject(new Error('WebRTC worker pipe write failed'));
      }
    });
  }
  function start(){
    if(!workerAvailable(env,platform))
      throw new Error('WebRTC capture is not installed or not enabled');
    const source=workerSource(env,platform);
    const frozenExe=Boolean(env.REMCP_WEBRTC_FROZEN_WORKER);
    // Do not leak paired-device OAuth/agent credentials into an optional
    // native media subprocess. Only desktop-session and Python/GStreamer
    // environment required for OS ScreenCast may cross this boundary.
    const allowed=[
      'HOME','PATH','LANG','LC_ALL','LC_CTYPE','TZ',
      'XDG_RUNTIME_DIR','XDG_CURRENT_DESKTOP','XDG_SESSION_TYPE',
      'XDG_DATA_DIRS','DBUS_SESSION_BUS_ADDRESS','WAYLAND_DISPLAY',
      'DISPLAY','GDK_BACKEND','GI_TYPELIB_PATH','PYTHONPATH',
      'GST_PLUGIN_PATH','GST_PLUGIN_SYSTEM_PATH_1_0',
      'TMPDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA',
      'SystemRoot','WINDIR',
      'REMCP_WEBRTC_USE_PORTAL_GRANT','REMCP_WEBRTC_ALLOW_TEST_SOURCE',
    ];
    const workerEnv=Object.fromEntries(allowed.filter(key=>typeof env[key]==='string')
      .map(key=>[key,env[key]]));
    // aiortc may live in a Python venv while Ubuntu supplies GObject
    // introspection only as a distro package. Extend the worker's import
    // path, not the agent/system environment; never install with sudo.
    if(source==='portal'&&platform==='linux'&&existsSync('/usr/lib/python3/dist-packages')){
      const systemPath='/usr/lib/python3/dist-packages';
      const existing=String(workerEnv.PYTHONPATH||'').split(path.delimiter).filter(Boolean);
      if(!existing.includes(systemPath))existing.push(systemPath);
      workerEnv.PYTHONPATH=existing.join(path.delimiter);
    }
    if(platform==='win32'){
      // Only the trusted Node bridge supplies its own PID to the native
      // watchdog. No remote session/RPC field can override this value.
      workerEnv.REMCP_WEBRTC_AGENT_PID=String(process.pid);
    }
    if(frozenExe){
      // Freeze package imports and native plugin loaders. On Windows, also
      // force the DLL-search path to the trusted OS System32 directory.
      if(platform==='win32')
        workerEnv.PATH=path.win32.join(env.SystemRoot||'C:\\Windows','System32');
      for(const name of ['PYTHONPATH','GST_PLUGIN_PATH',
        'GST_PLUGIN_SYSTEM_PATH_1_0','GI_TYPELIB_PATH'])
        delete workerEnv[name];
    }
    const worker=spawnChild(
      frozenExe?env.REMCP_WEBRTC_FROZEN_WORKER:env.REMCP_WEBRTC_PYTHON,
      frozenExe?['--source',source]:
        [env.REMCP_WEBRTC_WORKER_SCRIPT,'--source',source],{
        stdio:['pipe','pipe','ignore'],shell:false,windowsHide:true,
        env:workerEnv,
      });
    child=worker;stdout='';
    worker.stdout.on('data',chunk=>{if(child===worker)receive(chunk);});
    worker.once('error',()=>{if(child===worker)shutdown();});
    // Exit never clears the Stop fence; the OS may still have descendants
    // holding stdio. Even after close a separate containment proof is needed
    // before production native-capture Stop can be considered verified.
    worker.once('exit',()=>{if(child===worker&&!frozenExe)shutdown();});
    worker.once('close',()=>{if(child===worker)shutdown(true);});
  }

  async function offer({session_id:sid,mode,sdp,input_control=false,video_profile},extra={}){
    if(!UUID.test(String(sid))||mode!=='view'||typeof sdp!=='string'||
       Buffer.byteLength(sdp)>MAX_SDP||sdp.length<100)
      throw new Error('Invalid view-only WebRTC offer');
    if(!stopRequest&&!child&&!pendingExit&&!control.pending)inputStopping=false;
    if(current!==null||child||pendingExit||control.pending||inputStopping||stopRequest)
      throw new Error('Another WebRTC session is active');
    if(video_profile!==undefined&&!['economy','balanced','smooth','sharp'].includes(video_profile))
      throw new Error('Invalid bounded video profile');
    if(typeof input_control!=='boolean')throw new Error('Invalid input consent');
    inputEnabled=input_control;inputStopping=false;inputEpoch=String(now())+':'+sid;
    lastExitedSession=null;
    current=sid;started=seen=now();active=false;
    let cancelled=false;
    const cancel=()=>{cancelled=true;shutdown();};
    extra.signal?.addEventListener('abort',cancel,{once:true});
    try{
      start();
      clock=setIntervalFn(()=>{if(expired())shutdown();},1000);
      clock.unref?.();
      // All three desktop OS consent pickers can take longer than 19s.
      // The entire pending session is still capped at 64s by expired().
      // Windows onefile extraction shares this budget; it cannot extend it.
      const offerTimeout=MAX_OFFER_MS-1_000;
      if(platform==='win32'&&env.REMCP_WEBRTC_WINDOWS_PRIVATE_TURN_QA==='1'){
        // Only the local owner-protected config file is trusted. The remote
        // caller can never supply relay destinations or TURN secrets.
        if(!env.REMCP_WEBRTC_FROZEN_WORKER)
          throw new Error('Windows private TURN requires frozen QA worker');
        const config=privateTurnReader({env,platform});
        const configured=await send('ice-config',sid,{config},offerTimeout);
        if(configured.sessionId!==sid)
          throw new Error('Invalid Windows private TURN acknowledgement');
      }
      if(extra.nativeIce){
        const config=validateDeviceIce(extra.nativeIce,now());
        const configured=await send('ice-config',sid,{config},offerTimeout);
        if(configured.sessionId!==sid)throw new Error('Invalid private device ICE acknowledgement');
      }
      const answer=await send('offer',sid,{sdp,input_control,
        ...(video_profile===undefined?{}:{video_profile})},offerTimeout);
      if(cancelled||!child||current!==sid||answer.sessionId!==sid||
         answer.type!=='answer'||typeof answer.sdp!=='string'||
         Buffer.byteLength(answer.sdp)>MAX_SDP||expired())
        throw new Error('Invalid WebRTC worker answer');
      active=true;seen=now();
      return jsonResult({sessionId:sid,type:'answer',sdp:answer.sdp,
        ...(typeof answer.cursorEmbedded==='boolean'?{cursorEmbedded:answer.cursorEmbedded}:{})});
    }catch(error){
      shutdown();
      throw error;
    }finally{
      extra.signal?.removeEventListener('abort',cancel);
    }
  }
  async function heartbeat({session_id:sid}){
    if(!UUID.test(String(sid))||sid!==current||!active||expired()){
      if(expired())shutdown();
      throw new Error('WebRTC viewer session is not active');
    }
    try{
      const reply=await send('heartbeat',sid,{},4000);
      if(reply.sessionId!==sid||!child||expired())
        throw new Error('Invalid WebRTC lease acknowledgement');
      seen=now();
      return jsonResult({ok:true,sessionId:sid});
    }catch(error){shutdown();throw error;}
  }
  async function stopCore(sid){
    if(!UUID.test(String(sid)))
      throw new Error('WebRTC viewer session not found');
    // The native peer may close first; an observed child exit confirms its
    // media peer is gone. Only that exact completed session can be ACKed.
    if(!child&&current===null&&!pendingExit&&!control.pending&&lastExitedSession===sid)
      return jsonResult({ok:true,sessionId:sid});
    if(sid!==current||!child)
      throw new Error('WebRTC viewer session not found');
    inputStopping=true;
    try{
      const reply=await send('stop',sid,{},4000);
      if(reply.sessionId!==sid)throw new Error('Invalid WebRTC stop acknowledgement');
    }catch{
      // The peer may close before Stop reaches its worker. A missing stdio
      // acknowledgement cannot override subsequent verified native exit.
    }
    const exited=shutdown();
    let timer;
    // PyInstaller onefile owns a bootstrapper plus a native media child.
    // Give bounded Windows taskkill /T escalation time to close the pipes;
    // the ordinary Python/Mac/Linux Stop limit remains unchanged.
    const stopBudget=platform==='win32'&&env.REMCP_WEBRTC_FROZEN_WORKER
      ? frozenStopExitTimeoutMs:stopExitTimeoutMs;
    const drained=Promise.all([lastExitedSession===sid?true:exited,control.drain().then(()=>true)])
      .then(results=>results.every(Boolean));
    const confirmed=await Promise.race([
      drained,
      new Promise(resolve=>{timer=setTimeout(()=>resolve(false),stopBudget);}),
    ]).finally(()=>clearTimeout(timer));
    if(!confirmed)
      throw new Error('WebRTC worker Stop unconfirmed: native process still running');
    inputStopping=false;
    return jsonResult({ok:true,sessionId:sid});
  }
  function stop({session_id:sid}){
    if(stopRequest){
      if(stopRequest.sid!==sid)return Promise.reject(new Error('WebRTC viewer session not found'));
      return stopRequest.promise;
    }
    const promise=stopCore(sid).finally(()=>{stopRequest=null;});
    stopRequest={sid,promise};return promise;
  }
  const state=()=>{
    if(expired())shutdown();
    if(!stopRequest&&!child&&!pendingExit&&!control.pending)inputStopping=false;
    return {sessionId:current??pendingExit?.session??(control.pending?lastExitedSession:null),active,inputEnabled,stopping:inputStopping||Boolean(pendingExit)||(!current&&control.pending>0),epoch:inputEpoch};
  };
  const control=createWebRtcSessionControl({state,now});
  // Do not expose the internal alreadyExited override to callers.
  return {offer,heartbeat,stop,control,status:()=>{const {epoch,...value}=state();return jsonResult(value);},shutdown:()=>shutdown(),
    get activeSession(){return current;},
    get hasSession(){return Boolean(state().sessionId);},
  };
}

const bridge=createDesktopWebRtcBridge();
// Existing-session lifecycle RPCs cannot grant capture or input. Keep Stop
// reachable while native exit is pending, even if discovery becomes unavailable.
export const desktopWebRtcSessionAvailable=()=>bridge.hasSession;
export const desktopWebRtcHandlers={
  desktop_webrtc_offer:(args,extra)=>bridge.offer(args,extra),
  desktop_webrtc_heartbeat:args=>bridge.heartbeat(args),
  desktop_webrtc_stop:args=>bridge.stop(args),
  desktop_webrtc_status:()=>bridge.status(),
  desktop_webrtc_control:(args,extra)=>bridge.control(args,extra),
};
