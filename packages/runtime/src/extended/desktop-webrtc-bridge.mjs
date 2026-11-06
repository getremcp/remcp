// Explicitly opt-in Linux proof: ReMCP device RPC -> isolated aiortc worker
// via stdio, never a public/native HTTP listener. No OS permission bypass.
// Not an installed production runtime feature.
import {spawn} from 'node:child_process';
import {existsSync,lstatSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {jsonResult} from './common.mjs';

const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_SDP=60_000, MAX_LINE=70_000;
const MAX_IDLE_MS=45_000, MAX_AGE_MS=600_000;
const SOURCE=new Set(['portal','synthetic','gst-test']);

function trustedLocalFile(filename){
  if(!filename||!path.isAbsolute(filename)||!existsSync(filename))return false;
  try{
    const info=lstatSync(filename);
    return info.isFile()&&!info.isSymbolicLink()&&(info.mode&0o022)===0&&
      (typeof process.getuid!=='function'||info.uid===process.getuid()||info.uid===0);
  }catch{return false;}
}

export function webRtcWorkerAvailable(env=process.env,platform=process.platform){
  if(platform!=='linux'||env.REMCP_WEBRTC_RUNTIME_PILOT!=='1')return false;
  if(!trustedLocalFile(env.REMCP_WEBRTC_WORKER_SCRIPT)||
     !path.isAbsolute(env.REMCP_WEBRTC_PYTHON||''))return false;
  const source=env.REMCP_WEBRTC_DEV_SOURCE||'portal';
  if(!SOURCE.has(source))return false;
  if(source!=='portal'&&env.REMCP_WEBRTC_ALLOW_TEST_SOURCE!=='1')return false;
  return existsSync(env.REMCP_WEBRTC_PYTHON);
}

export function createDesktopWebRtcBridge({
  env=process.env,platform=process.platform,spawnChild=spawn,
  now=Date.now,setIntervalFn=setInterval,clearIntervalFn=clearInterval,
  stopExitTimeoutMs=5_000,terminationEscalationMs=3_000,
}={}){
  if(!Number.isSafeInteger(stopExitTimeoutMs)||stopExitTimeoutMs<100||
     stopExitTimeoutMs>10_000||
     !Number.isSafeInteger(terminationEscalationMs)||
     terminationEscalationMs<100||terminationEscalationMs>10_000)
    throw new RangeError('Invalid WebRTC native Stop exit deadline');
  let child=null, current=null, active=false, started=0, seen=0;
  let stdout='', sequence=0, clock=null, pendingExit=null;
  let lastExitedSession=null;
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
    child=null;current=null;active=false;stdout='';
    rejectWaits();
    if(!target)return pendingExit?.promise??Promise.resolve(false);
    let confirmExit;
    const exited=new Promise(resolve=>{confirmExit=resolve;});
    const marker={target,promise:exited};
    pendingExit=marker;
    let escalation;
    const onExit=()=>{
      target.removeListener('exit',onExit);
      if(escalation)clearTimeout(escalation);
      if(pendingExit===marker)pendingExit=null;
      lastExitedSession=session;
      confirmExit(true);
    };
    target.once('exit',onExit);
    if(alreadyExited||target.exitCode!==null&&target.exitCode!==undefined||
       target.signalCode!==null&&target.signalCode!==undefined){
      onExit();
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
    return current!==null&&(now()-seen>=MAX_IDLE_MS||now()-started>=MAX_AGE_MS);
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
    if(!webRtcWorkerAvailable(env,platform))
      throw new Error('WebRTC capture is not installed or not enabled');
    const source=env.REMCP_WEBRTC_DEV_SOURCE||'portal';
    // Do not leak paired-device OAuth/agent credentials into an optional
    // native media subprocess. Only desktop-session and Python/GStreamer
    // environment required for OS ScreenCast may cross this boundary.
    const allowed=[
      'HOME','PATH','LANG','LC_ALL','LC_CTYPE','TZ',
      'XDG_RUNTIME_DIR','XDG_CURRENT_DESKTOP','XDG_SESSION_TYPE',
      'XDG_DATA_DIRS','DBUS_SESSION_BUS_ADDRESS','WAYLAND_DISPLAY',
      'DISPLAY','GDK_BACKEND','GI_TYPELIB_PATH','PYTHONPATH',
      'GST_PLUGIN_PATH','GST_PLUGIN_SYSTEM_PATH_1_0',
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
    const worker=spawnChild(env.REMCP_WEBRTC_PYTHON,
      [env.REMCP_WEBRTC_WORKER_SCRIPT,'--source',source],{
        stdio:['pipe','pipe','ignore'],shell:false,windowsHide:true,
        env:workerEnv,
      });
    child=worker;stdout='';
    worker.stdout.on('data',chunk=>{if(child===worker)receive(chunk);});
    worker.once('error',()=>{if(child===worker)shutdown();});
    worker.once('exit',()=>{if(child===worker)shutdown(true);});
  }

  async function offer({session_id:sid,mode,sdp},extra={}){
    if(!UUID.test(String(sid))||mode!=='view'||typeof sdp!=='string'||
       Buffer.byteLength(sdp)>MAX_SDP||sdp.length<100)
      throw new Error('Invalid view-only WebRTC offer');
    if(current!==null||child||pendingExit)
      throw new Error('Another WebRTC session is active');
    lastExitedSession=null;
    current=sid;started=seen=now();active=false;
    let cancelled=false;
    const cancel=()=>{cancelled=true;shutdown();};
    extra.signal?.addEventListener('abort',cancel,{once:true});
    try{
      start();
      clock=setIntervalFn(()=>{if(expired())shutdown();},1000);
      clock.unref?.();
      const answer=await send('offer',sid,{sdp},19_000);
      if(cancelled||!child||current!==sid||answer.sessionId!==sid||
         answer.type!=='answer'||typeof answer.sdp!=='string'||
         Buffer.byteLength(answer.sdp)>MAX_SDP||expired())
        throw new Error('Invalid WebRTC worker answer');
      active=true;seen=now();
      return jsonResult({sessionId:sid,type:'answer',sdp:answer.sdp});
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
  async function stop({session_id:sid}){
    if(!UUID.test(String(sid))||sid!==current||!child)
      throw new Error('WebRTC viewer session not found');
    try{
      const reply=await send('stop',sid,{},4000);
      if(reply.sessionId!==sid)throw new Error('Invalid WebRTC stop acknowledgement');
    }catch(error){shutdown();throw error;}
    const exited=shutdown();
    let timer;
    const confirmed=lastExitedSession===sid||await Promise.race([
      exited,
      new Promise(resolve=>{timer=setTimeout(()=>resolve(false),stopExitTimeoutMs);}),
    ]).finally(()=>clearTimeout(timer));
    if(!confirmed)
      throw new Error('WebRTC worker Stop unconfirmed: native process still running');
    return jsonResult({ok:true,sessionId:sid});
  }
  // Do not expose the internal alreadyExited override to callers.
  return {offer,heartbeat,stop,shutdown:()=>shutdown(),
    get activeSession(){return current;},
  };
}

const bridge=createDesktopWebRtcBridge();
export const desktopWebRtcHandlers={
  desktop_webrtc_offer:(args,extra)=>bridge.offer(args,extra),
  desktop_webrtc_heartbeat:args=>bridge.heartbeat(args),
  desktop_webrtc_stop:args=>bridge.stop(args),
};
