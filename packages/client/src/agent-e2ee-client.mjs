// Browser/stdio-client side. The supplied relay transport sees ciphertext only.
import { E2EE_PROTOCOL, E2EE_MESSAGE_LIMIT, e2eeFingerprint, sealE2eeMessage,
  sealE2eePacket, openE2eePacket, createE2eeReplayGuard } from './agent-e2ee-crypto.mjs';

const decode=new TextDecoder('utf-8',{fatal:true});
export function createE2eeDeviceClient({identity,deviceId,pinnedDevice,describe,dispatch}) {
  if(!identity?.keys||!pinnedDevice||typeof describe!=='function'||typeof dispatch!=='function')
    throw new Error('e2ee_client_configuration_required');
  const session=crypto.randomUUID(), replay=createE2eeReplayGuard();
  async function request(method,params,{signal}={}) {
    if(!['tools/list','tools/call'].includes(method))throw new Error('e2ee_method_denied');
    signal?.throwIfAborted();
    const descriptor=await describe({signal});
    if(descriptor?.version!==E2EE_PROTOCOL||descriptor.device!==deviceId||
        descriptor.fingerprint!==pinnedDevice||
        await e2eeFingerprint(descriptor.publicKey)!==pinnedDevice)
      throw new Error('e2ee_device_identity_changed');
    const call=crypto.randomUUID();
    const common={sender:identity,recipient:descriptor.publicKey,pinnedRecipient:pinnedDevice,
      device:deviceId,epoch:descriptor.epoch,session,call,direction:'request'};
    const packets=await sealE2eeMessage({...common,plaintext:JSON.stringify({method,params})});
    let response;
    for(let index=0;index<packets.length;index++){
      signal?.throwIfAborted();
      response=await dispatch(packets[index],{signal});
      if(index<packets.length-1&&response?.accepted!==true)
        throw new Error('e2ee_upload_not_acknowledged');
    }
    const opened=[], first=response?.packet;
    if(first?.chunk!==0||!Number.isSafeInteger(first.chunks)||first.chunks<1||first.chunks>64)
      throw new Error('e2ee_response_invalid');
    let total=0;
    for(let index=0;index<first.chunks;index++){
      signal?.throwIfAborted();
      const packet=index===0?first:(await dispatch(await sealE2eePacket({...common,
        plaintext:JSON.stringify({method:'result/pull',params:{index}})}),{signal}))?.packet;
      if(packet?.chunk!==index||packet.chunks!==first.chunks)throw new Error('e2ee_response_invalid');
      const clear=await openE2eePacket({receiver:identity,sender:descriptor.publicKey,
        pinnedSender:pinnedDevice,device:deviceId,epoch:descriptor.epoch,session,call,
        direction:'response',packet,replay});
      total+=clear.length;if(total>E2EE_MESSAGE_LIMIT)throw new Error('e2ee_response_too_large');
      opened.push(clear);
    }
    const joined=new Uint8Array(total);let offset=0;
    for(const part of opened){joined.set(part,offset);offset+=part.length;}
    const result=JSON.parse(decode.decode(joined));
    if(result.error)throw new Error(String(result.error.message||'e2ee_tool_failed'));
    if(!Object.hasOwn(result,'result'))throw new Error('e2ee_response_invalid');
    return result.result;
  }
  return Object.freeze({listTools:options=>request('tools/list',{},options),
    callTool:(params,options)=>request('tools/call',params,options)});
}
