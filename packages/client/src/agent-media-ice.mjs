// Fetch relay credentials as the paired device, then hand them to its private stdio runtime.
import {validateDeviceIce} from './webrtc-device-ice-contract.mjs';
export async function callAgentRuntimeTool({mcp,params,options={},serverUrl,deviceToken,encrypted=false,fetchFn=fetch}){
  const safe={name:params?.name,arguments:params?.arguments};
  if(safe.name==='desktop_webrtc_offer'){
    const sid=safe.arguments?.session_id;
    if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sid||''))
      throw Error('Invalid native media session');
    const url=new URL('/api/agent-webrtc/native-ice',serverUrl);
    if(url.protocol!=='https:'&&url.hostname!=='127.0.0.1'&&url.hostname!=='localhost')
      throw Error('Device ICE requires verified HTTPS');
    const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000);
    let config;
    try{
      const response=await fetchFn(url,{method:'POST',redirect:'error',signal,
        headers:{Authorization:'Bearer '+deviceToken,'Content-Type':'application/json'},
        body:JSON.stringify({session_id:sid,...(encrypted?{encrypted:true}:{})})});
      if(!response.ok)throw Error();
      const reader=response.body.getReader();let length=0;const chunks=[];
      try{for(;;){const part=await reader.read();if(part.done)break;
        length+=part.value.length;if(length>4096)throw Error();chunks.push(part.value);}}
      finally{await reader.cancel().catch(()=>{});}
      const data=new Uint8Array(length);let offset=0;
      for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
      config=validateDeviceIce(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)));
    }catch{throw Error('Device TURN configuration unavailable; retry before starting capture');}
    safe._meta={'remcp/native-ice':config};
  }
  // Caller-provided metadata is always stripped, including for non-media calls.
  return mcp.callTool(safe,options);
}
