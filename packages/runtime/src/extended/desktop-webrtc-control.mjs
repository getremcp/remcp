// Input remains tied to a live, explicitly input-enabled local capture.
import {desktopHandlers} from './desktop.mjs';
import {jsonResult} from './common.mjs';
import {parseWebRtcControlInput,primaryDisplay,toDeviceTool} from './webrtc-control-contract.mjs';
export function createWebRtcSessionControl({state,handlers=desktopHandlers,now=Date.now}){
  let pendingCount=0;
  let queue=Promise.resolve(),lastEpoch='',lastSequence=0,display=null,checkedAt=0;
  const admitted=(sid,epoch)=>{const s=state();return s.sessionId===sid&&s.epoch===epoch&&s.active&&s.inputEnabled&&!s.stopping;};
  const control=({session_id:sid,input},extra={})=>{
    if(pendingCount>=64)return Promise.reject(new Error('WebRTC input queue full'));
    const epoch=state().epoch,parsed=parseWebRtcControlInput(input);
    // Admission is required both at submission and execution. A queued
    // command must not inherit consent or a replacement capture epoch.
    if(!parsed||!admitted(sid,epoch)||extra.signal?.aborted)
      return Promise.reject(new Error('WebRTC input session unavailable'));
    pendingCount++;
    const execute=async()=>{
      if(!admitted(sid,epoch)||extra.signal?.aborted)throw new Error('WebRTC input session unavailable');
      if(lastEpoch!==epoch){lastEpoch=epoch;lastSequence=0;display=null;checkedAt=0;}
      if(parsed.seq<=lastSequence)throw new Error('WebRTC input sequence replay');
      lastSequence=parsed.seq;
      if(['pointer','drag','scroll'].includes(parsed.kind)&&(!display||now()-checkedAt>=3000)){
        const reply=await handlers.display_inventory({},extra);
        if(reply?.isError)throw new Error('Remote display unavailable');
        try{display=primaryDisplay(JSON.parse(reply.content.find(c=>c.type==='text').text));}catch{display=null;}
        if(!display)throw new Error('Remote display unavailable');
        checkedAt=now();
      }
      if(!admitted(sid,epoch)||extra.signal?.aborted)throw new Error('WebRTC input session ended');
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
  control.drain=()=>queue;
  Object.defineProperty(control,'pending',{get:()=>pendingCount});
  return control;
}
