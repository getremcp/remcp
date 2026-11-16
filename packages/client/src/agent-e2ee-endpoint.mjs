// Device-side endpoint for opaque, authenticated tool traffic. No relay decryption key.
import { randomUUID } from 'node:crypto';
import { E2EE_PROTOCOL, E2EE_MESSAGE_LIMIT, openE2eePacket, sealE2eeMessage,
  createE2eeReplayGuard } from './agent-e2ee-crypto.mjs';

const encode=new TextEncoder(), decode=new TextDecoder('utf-8',{fatal:true});
const deny=()=>{throw new Error('e2ee_request_rejected');};
const TTL=120000, BUFFER_LIMIT=32*1024*1024, CALL_LIMIT=2048;
export function createAgentE2eeEndpoint({identity,deviceId,getPeer,getRuntimeState,invokeRuntimeTool,now=Date.now}) {
  if(!identity?.keys||typeof getPeer!=='function'||typeof getRuntimeState!=='function')deny();
  const epoch=randomUUID(), replay=createE2eeReplayGuard();
  const uploads=new Map(), results=new Map(), executed=new Map();
  let buffered=0,closed=false;
  const key=p=>JSON.stringify([p.from,p.session,p.call]);
  function sweep() {
    const time=now();
    for(const map of [uploads,results])for(const [id,item] of map)if(item.expires<=time){
      buffered-=item.bytes;map.delete(id);
    }
    for(const [id,expiry] of executed)if(expiry<=time)executed.delete(id);
  }
  async function peerFor(p) {
    if(closed)deny();
    const peer=await getPeer(p?.from);
    if(!peer||peer.fingerprint!==p.from||!['read','control'].includes(peer.mode)||
        typeof peer.publicKey!=='string')deny();
    return peer;
  }
  const allowed=(tool,peer)=>tool&&(!peer.tools||peer.tools.includes(tool.name))&&
    (peer.mode==='control'||tool.annotations?.readOnlyHint===true);
  async function dispatch(request,peer,signal) {
    const {mcp,runtimeDown,callTimeoutMs=110000}=getRuntimeState();
    if(!mcp||runtimeDown)throw new Error('runtime_unavailable');
    if(signal?.aborted)throw new Error('cancelled');
    const options={timeout:callTimeoutMs,signal};
    const catalog=await mcp.listTools(undefined,options);
    const tools=(catalog?.tools||[]).filter(tool=>allowed(tool,peer));
    if(request.method==='tools/list')return {...catalog,tools};
    if(request.method!=='tools/call'||typeof request.params?.name!=='string'||
        !tools.some(tool=>tool.name===request.params.name))throw new Error('tool_not_authorized');
    const params={name:request.params.name,arguments:request.params.arguments};
    return invokeRuntimeTool?invokeRuntimeTool(mcp,params,options):mcp.callTool(params,options);
  }
  async function handle(packet,{signal}={}) {
    sweep();
    const peer=await peerFor(packet);
    const clear=await openE2eePacket({receiver:identity,sender:peer.publicKey,
      pinnedSender:peer.fingerprint,packet,device:deviceId,session:packet.session,
      call:packet.call,direction:'request',epoch,replay,now:now()});
    const id=key(packet);
    // Pulls are authenticated too. They retrieve only this peer/session/call.
    // A relay cannot execute a tool by manufacturing or replaying a pull.
    if(packet.chunks===1){
      let pull;try{pull=JSON.parse(decode.decode(clear));}catch{ /* full request validated below */ }
      if(pull?.method==='result/pull'){
        if(Object.keys(pull).sort().join(',')!=='method,params'||
            !Number.isSafeInteger(pull.params?.index))deny();
        const saved=results.get(id), selected=saved?.packets[pull.params.index];
        if(!selected||pull.params.index<0)deny();
        if(JSON.stringify(await peerFor(packet))!==saved.policy)deny();
        return {packet:selected};
      }
    }
    if(executed.has(id))deny();
    let upload=uploads.get(id);
    if(!upload){
      if(packet.chunk!==0||uploads.size>=32||buffered+clear.length>BUFFER_LIMIT)deny();
      upload={parts:[],bytes:0,chunks:packet.chunks,expires:packet.expires};
      uploads.set(id,upload);
    }
    if(packet.chunk!==upload.parts.length||packet.chunks!==upload.chunks||
        upload.bytes+clear.length>E2EE_MESSAGE_LIMIT||buffered+clear.length>BUFFER_LIMIT)deny();
    upload.parts.push(clear);upload.bytes+=clear.length;buffered+=clear.length;
    upload.expires=Math.min(upload.expires,packet.expires);
    if(upload.parts.length<upload.chunks)return {accepted:true};
    uploads.delete(id);buffered-=upload.bytes;
    if(executed.size>=CALL_LIMIT)deny();
    // Reserve synchronously before awaiting the runtime: concurrent fresh
    // ciphertext for the same call ID must never repeat a side effect.
    executed.set(id,now()+TTL+15000);
    let result;
    try {
      const body=new Uint8Array(upload.bytes);let offset=0;
      for(const part of upload.parts){body.set(part,offset);offset+=part.length;}
      const request=JSON.parse(decode.decode(body));
      if(!request||Object.keys(request).some(name=>!['method','params'].includes(name)))deny();
      result={result:await dispatch(request,await peerFor(packet),signal)};
    } catch(error) {
      result={error:{message:signal?.aborted?'cancelled':String(error?.message||'tool_failed').slice(0,512)}};
    }
    const currentPeer=await peerFor(packet);
    if(JSON.stringify(currentPeer)!==JSON.stringify(peer))deny();
    let plaintext=encode.encode(JSON.stringify(result));
    if(plaintext.length>E2EE_MESSAGE_LIMIT)
      plaintext=encode.encode(JSON.stringify({error:{message:'e2ee_result_too_large'}}));
    const packets=await sealE2eeMessage({sender:identity,recipient:peer.publicKey,
      pinnedRecipient:peer.fingerprint,device:deviceId,session:packet.session,call:packet.call,
      direction:'response',epoch,plaintext,now:now()});
    const bytes=encode.encode(JSON.stringify(packets)).length;
    if(buffered+bytes>BUFFER_LIMIT)deny();
    results.set(id,{packets,bytes,policy:JSON.stringify(peer),expires:now()+TTL});buffered+=bytes;
    return {packet:packets[0]};
  }
  return Object.freeze({
    identity:()=>({version:E2EE_PROTOCOL,device:deviceId,publicKey:identity.publicKey,
      fingerprint:identity.fingerprint,epoch}),
    handle,
    close(){closed=true;uploads.clear();results.clear();executed.clear();buffered=0;},
  });
}
