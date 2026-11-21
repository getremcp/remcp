// Device-side endpoint for opaque, authenticated tool traffic. No relay decryption key.
import { randomUUID } from 'node:crypto';
import { E2EE_PROTOCOL, E2EE_MESSAGE_LIMIT, openE2eePacket, sealE2eeMessage,
  createE2eeReplayGuard } from './agent-e2ee-crypto.mjs';
import {checkEnrollmentIntent,validEnrollmentCode,ENROLL_TTL_MS} from './e2ee-enrollment-code.mjs';

const encode=new TextEncoder(), decode=new TextDecoder('utf-8',{fatal:true});
const deny=()=>{throw new Error('e2ee_request_rejected');};
const TTL=120000, BUFFER_LIMIT=32*1024*1024, CALL_LIMIT=2048;
export function createAgentE2eeEndpoint({identity,deviceId,getPeer,getRuntimeState,invokeRuntimeTool,now=Date.now}) {
  if(!identity?.keys||typeof getPeer!=='function'||typeof getRuntimeState!=='function')deny();
  const epoch=randomUUID(), replay=createE2eeReplayGuard();
  const uploads=new Map(), results=new Map(), executed=new Map();
  // Pending offers are not authority. Only an explicit owner-local socket
  // confirmation may persist the limited read grant to the OS vault.
  const pendingEnrollments=new Map(),seenEnrollments=new Map(),approvals=new Map(),
    commitReceipts=new Map();
  let enrollmentListening=false,enrollmentHandler=null,enrollmentCancelHandler=null;
  let buffered=0,closed=false;
  const key=p=>JSON.stringify([p.from,p.session,p.call]);
  function sweep() {
    const time=now();
    for(const map of [uploads,results])for(const [id,item] of map)if(item.expires<=time){
      buffered-=item.bytes;map.delete(id);
    }
    for(const [id,expiry] of executed)if(expiry<=time)executed.delete(id);
    for(const [id,item] of pendingEnrollments)if(item.expires<=time)pendingEnrollments.delete(id);
    for(const [id,expiry] of seenEnrollments)if(expiry<=time)seenEnrollments.delete(id);
    for(const [id,item] of commitReceipts)if(item.expires<=time)commitReceipts.delete(id);
  }
  async function peerFor(p) {
    if(closed)deny();
    const peer=await getPeer(p?.from);
    if(!peer||peer.fingerprint!==p.from||!['read','control'].includes(peer.mode)||
        typeof peer.publicKey!=='string'||
        (peer.tools!==undefined&&(!Array.isArray(peer.tools)||peer.tools.length>64||
          peer.tools.some(name=>typeof name!=='string'||!/^[_a-z0-9]{1,80}$/.test(name)))))deny();
    return peer;
  }
  // A tool's readOnlyHint is advisory metadata, not a permission grant. A
  // read-only peer needs a separately approved, local per-tool allowlist too.
  const allowed=(tool,peer)=>Boolean(tool&&(
    peer.mode==='control'
      ?(!peer.tools||peer.tools.includes(tool.name))
      :(Array.isArray(peer.tools)&&peer.tools.includes(tool.name)&&
        tool.annotations?.readOnlyHint===true)));
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
    // The agent calls this only once the owner-private local approval socket
    // is actually listening; no approval is possible through the remote RPC.
    setEnrollmentListening:value=>{enrollmentListening=value===true;},
    setEnrollmentHandler:handler=>{enrollmentHandler=typeof handler==='function'?handler:null;},
    setEnrollmentCancelHandler:handler=>{enrollmentCancelHandler=typeof handler==='function'?handler:null;},
    rejectEnrollment:code=>pendingEnrollments.delete(code),
    async offerEnrollment(intent){
      if(closed||!enrollmentListening)deny();
      sweep();
      const code=await checkEnrollmentIntent(intent,{device:deviceId,
        publicKey:identity.publicKey,fingerprint:identity.fingerprint,epoch,now:now()});
      if(pendingEnrollments.size+approvals.size>=8||seenEnrollments.size>=128||
          pendingEnrollments.has(code)||approvals.has(code)||seenEnrollments.has(intent.nonce))deny();
      const expires=Math.min(intent.createdAt+ENROLL_TTL_MS,now()+ENROLL_TTL_MS);
      seenEnrollments.set(intent.nonce,expires);
      pendingEnrollments.set(code,{intent,expires});
      if(enrollmentHandler)void Promise.resolve().then(()=>{
        // A cancellation may arrive before the queued native dialog starts.
        if(pendingEnrollments.has(code))return enrollmentHandler({intent,code});
      }).catch(()=>{pendingEnrollments.delete(code);});
      // Never return a verification code from the server. The browser derives
      // it independently from its own key, device descriptor and nonce.
      return {pending:true};
    },
    pendingEnrollments:()=>{
      sweep();return [...pendingEnrollments.values()].map(({intent,expires})=>({
        fingerprint:intent.fingerprint,expires}));
    },
    async cancelEnrollment(intent){
      if(closed||!enrollmentListening)deny();
      sweep();
      const code=await checkEnrollmentIntent(intent,{device:deviceId,
        publicKey:identity.publicKey,fingerprint:identity.fingerprint,epoch,now:now()});
      const entry=pendingEnrollments.get(code),approval=approvals.get(code),
        receipt=commitReceipts.get(code);
      const active=entry?.intent||approval?.intent||receipt?.intent;
      if(active&&(active.nonce!==intent.nonce||
          active.publicKey!==intent.publicKey))deny();
      // A started vault write may have committed even if its acknowledgement
      // was lost. Cancelling its old nonce must never claim remote revocation.
      if(receipt)return {cancelled:false};
      // Before vault commit, cancellation fences the owner grant. Once the
      // irreversible OS-vault write begins, cancellation cannot revoke it.
      if(approval&&!approval.committing)
        approval.controller.abort(new Error('enrollment_cancelled'));
      // A signed-in browser can cancel its own offer, including when the
      // cancel races ahead of the offer. The nonce tombstone blocks replays.
      if(seenEnrollments.size>=128&&!seenEnrollments.has(intent.nonce))deny();
      seenEnrollments.set(intent.nonce,intent.createdAt+ENROLL_TTL_MS);
      pendingEnrollments.delete(code);
      if(entry&&enrollmentCancelHandler){try{enrollmentCancelHandler(code);}catch{}}
      // This only cancels pending enrollment; an already committed owner
      // grant must be separately revoked on the local device.
      return {cancelled:approval?.committing!==true};
    },
    async approveEnrollment(code,persist){
      sweep();
      if(closed||!enrollmentListening||!validEnrollmentCode(code)||typeof persist!=='function')deny();
      const entry=pendingEnrollments.get(code);
      if(!entry)deny();
      // Claim exactly once before vault I/O. A timeout or failure must not
      // allow a concurrent process to authorize the same request again.
      pendingEnrollments.delete(code);
      const controller=new AbortController();
      const assertActive=()=>{
        controller.signal.throwIfAborted();
        if(closed||now()>=entry.expires)deny();
      };
      const approval={intent:entry.intent,controller,committing:false};
      const beginCommit=()=>{
        assertActive();approval.committing=true;
        // Record before the irreversible owner-vault operation: a write may
        // succeed even if the vault API later loses its acknowledgement.
        commitReceipts.set(code,{intent:entry.intent,expires:entry.expires});
      };
      approvals.set(code,approval);
      try{
        assertActive();
        await persist(entry.intent,{signal:controller.signal,assertActive,beginCommit});
        // A completed write is not undone by a late cancellation. Only a
        // grant that has not entered commit may still be rejected here.
        if(!approval.committing){
          assertActive();
          commitReceipts.set(code,{intent:entry.intent,expires:entry.expires});
        }
        return {approved:true};
      }finally{approvals.delete(code);}
    },
    close(){closed=true;enrollmentListening=false;enrollmentHandler=null;enrollmentCancelHandler=null;
      for(const approval of approvals.values())if(!approval.committing)
        approval.controller.abort(new Error('enrollment_closed'));
      approvals.clear();pendingEnrollments.clear();seenEnrollments.clear();
      commitReceipts.clear();
      uploads.clear();results.clear();executed.clear();buffered=0;},
  });
}
