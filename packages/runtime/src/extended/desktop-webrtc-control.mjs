// Input remains tied to a live, explicitly input-enabled local capture.
import {desktopHandlers} from './desktop.mjs';
import {jsonResult} from './common.mjs';
import {withFreshUiAfterAction} from './desktop-core.mjs';
import {createWindowsWebRtcInput} from './desktop-windows-webrtc-input.mjs';
import {parseWebRtcControlInput,primaryDisplay,toDeviceTool} from './webrtc-control-contract.mjs';
const MAX_PENDING=16,MAX_ACTION_WAIT_MS=2500,MAX_CONTINUOUS_WAIT_MS=350;
export function createWebRtcSessionControl({state,handlers=desktopHandlers,now=()=>performance.now(),
  fastInput=process.platform==='win32'&&handlers===desktopHandlers?createWindowsWebRtcInput():null}){
  let pendingCount=0,retirement=null;
  let queue=Promise.resolve(),lastEpoch='',lastSequence=0,display=null,checkedAt=0;
  const admitted=(sid,epoch)=>{const s=state();return s.sessionId===sid&&s.epoch===epoch&&s.active&&s.inputEnabled&&!s.stopping;};
  const control=({session_id:sid,input},extra={})=>{
    if(retirement)return Promise.reject(new Error('WebRTC input session unavailable'));
    if(pendingCount>=MAX_PENDING)return Promise.reject(new Error('WebRTC input queue full'));
    const epoch=state().epoch,parsed=parseWebRtcControlInput(input);
    // Admission is required both at submission and execution. A queued
    // command must not inherit consent or a replacement capture epoch.
    if(!parsed||!admitted(sid,epoch)||extra.signal?.aborted)
      return Promise.reject(new Error('WebRTC input session unavailable'));
    const receivedAt=now();
    const maxWait=parsed.kind==='scroll'||(parsed.kind==='pointer'&&parsed.op==='move')
      ?MAX_CONTINUOUS_WAIT_MS:MAX_ACTION_WAIT_MS;
    const requireFresh=()=>{
      if(now()-receivedAt>maxWait)throw new Error('Remote input expired before native dispatch');
    };
    pendingCount++;
    const execute=async()=>{
      if(!admitted(sid,epoch)||extra.signal?.aborted)throw new Error('WebRTC input session unavailable');
      if(lastEpoch!==epoch){lastEpoch=epoch;lastSequence=0;display=null;checkedAt=0;}
      if(parsed.seq<=lastSequence)throw new Error('WebRTC input sequence replay');
      lastSequence=parsed.seq;
      requireFresh();
      // The Windows worker receives only validated typed input; its fresh OS
      // session probe and current primary-display lookup run in the same process.
      if(fastInput?.supports(parsed)){
        await withFreshUiAfterAction(()=>{requireFresh();return fastInput.dispatch(parsed,extra);});
        if(!admitted(sid,epoch)||extra.signal?.aborted)throw new Error('WebRTC input session ended');
        return jsonResult({ok:true,seq:parsed.seq});
      }
      if(['pointer','drag','scroll'].includes(parsed.kind)&&(!display||now()-checkedAt>=3000)){
        const reply=await handlers.display_inventory({},extra);
        if(reply?.isError)throw new Error('Remote display unavailable');
        try{display=primaryDisplay(JSON.parse(reply.content.find(c=>c.type==='text').text));}catch{display=null;}
        if(!display)throw new Error('Remote display unavailable');
        checkedAt=now();
      }
      if(!admitted(sid,epoch)||extra.signal?.aborted)throw new Error('WebRTC input session ended');
      requireFresh();
      const tool=toDeviceTool(parsed,display),handler=tool&&handlers[tool.name];
      if(typeof handler!=='function')throw new Error('Remote input unavailable');
      const reply=await handler(tool.arguments,extra);
      // Native Stop/revocation may start while the OS input handler is
      // pending. The side effect cannot be undone, but stale success must
      // never cross the ended session or be replayed into its replacement.
      if(!admitted(sid,epoch)||extra.signal?.aborted)
        throw new Error('WebRTC input session ended');
      if(reply?.isError)throw new Error('Remote input failed');
      const result={ok:true,seq:parsed.seq};
      if(parsed.kind==='clipboard'&&parsed.op==='read'){
        const text=reply.content?.find(c=>c.type==='text')?.text;
        if(typeof text!=='string'||new TextEncoder().encode(text).length>65536||
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
          throw new Error('Remote clipboard unavailable or exceeds 64 KiB');
        result.text=text;
      }
      return jsonResult(result);
    };
    const pending=queue.then(execute).finally(()=>{pendingCount--;});queue=pending.catch(()=>{});return pending;
  };
  control.prepare=()=>{
    const s=state();
    if(!retirement&&s.active&&s.inputEnabled&&!s.stopping)fastInput?.prepare?.();
  };
  control.retire=()=>{
    if(!fastInput)return queue;
    if(!retirement){
      retirement=queue.then(()=>fastInput.close()).then(()=>{retirement=null;});
    }
    return retirement;
  };
  control.drain=()=>retirement??queue;
  Object.defineProperty(control,'pending',{get:()=>pendingCount+(retirement?1:0)});
  return control;
}
