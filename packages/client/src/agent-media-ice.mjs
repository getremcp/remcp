// Fetch relay credentials as the paired device, then hand them to its private stdio runtime.
import {validateDeviceIce} from './webrtc-device-ice-contract.mjs';
import {normalizedServerUrl} from './agent-utilities.mjs';
export async function callAgentRuntimeTool({mcp,params,options={},serverUrl,deviceToken,encrypted=false,fetchFn=fetch}){
  const safe={name:params?.name,arguments:params?.arguments};
  // The local tool supports 120 seconds, but a remote call must leave
  // room for startup, container finalization and returning its result.
  // Do not silently shorten a recording or start one that cannot fit.
  options.signal?.throwIfAborted();
  if(safe.name==='record_screen'&&Number.isFinite(options.timeout)){
    const raw=Number(safe.arguments?.duration_seconds);
    const seconds=Number.isFinite(raw)?Math.min(120,Math.max(1,Math.trunc(raw))):5;
    const maximum=Math.max(0,Math.min(120,Math.floor((options.timeout-40_000)/1000)));
    if(seconds>maximum)
      throw Error('Requested screen recording exceeds remote call budget; maximum '+maximum+' seconds for this connection. Use a shorter recording or local runtime.');
  }
  if(safe.name==='desktop_webrtc_offer'){
    const sid=safe.arguments?.session_id;
    if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sid||''))
      throw Error('Invalid native media session');
    const url=new URL('/api/agent-webrtc/native-ice',normalizedServerUrl(serverUrl));
    const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000);
    let config;
    try{
      // STOP must win even if an injected or misbehaving transport ignores
      // AbortSignal; never request credentials for an already stopped session.
      signal.throwIfAborted();
      const response=await fetchFn(url,{method:'POST',redirect:'error',signal,
        headers:{Authorization:'Bearer '+deviceToken,'Content-Type':'application/json'},
        body:JSON.stringify({session_id:sid,...(encrypted?{encrypted:true}:{})})});
      if(signal.aborted){
        if(response.body)await response.body.cancel().catch(()=>{});
        signal.throwIfAborted();
      }
      if(!response.ok){
        // A rejected ICE response can still carry a live error body. Close
        // it so failed capture requests cannot retain relay HTTP streams.
        if(response.body)await response.body.cancel().catch(()=>{});
        throw Error();
      }
      const reader=response.body.getReader();let length=0;const chunks=[];
      try{for(;;){const part=await reader.read();if(part.done)break;
        length+=part.value.length;if(length>4096)throw Error();chunks.push(part.value);}}
      finally{await reader.cancel().catch(()=>{});}
      const data=new Uint8Array(length);let offset=0;
      for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
      config=validateDeviceIce(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)));
      // A session can be cancelled while credentials are read or validated.
      signal.throwIfAborted();
    }catch{throw Error('Device TURN configuration unavailable; retry before starting capture');}
    safe._meta={'remcp/native-ice':config};
  }
  // Caller-provided metadata is always stripped, including for non-media calls.
  return mcp.callTool(safe,options);
}
