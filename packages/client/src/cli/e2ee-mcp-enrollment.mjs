// First-party AI bridge enrollment: OAuth authenticates account ownership;
// independent native confirmation binds the keys. No relay reply grants trust.
import {createE2eeDeviceClient} from '../agent-e2ee-client.mjs';
import {createEnrollmentIntent,ENROLL_TTL_MS} from '../e2ee-enrollment-code.mjs';
import {loadEncryptedClient,manageEncryptedClient,encryptedClientEndpoint} from './e2ee-client-profile.mjs';
import {connectEncryptedRelay} from './e2ee-oauth.mjs';
import {withEncryptedClientVaultLock} from './e2ee-client-mutation.mjs';
import {nativeEnrollmentDialog} from './e2ee-native-enrollment.mjs';
import {setTimeout as sleep} from 'node:timers/promises';

export async function prepareEncryptedMcpConnection(flags={},{
  load=loadEncryptedClient,initialize=()=>manageEncryptedClient('client-init'),
  connect=connectEncryptedRelay,report=text=>process.stderr.write(text+'\n'),
  delay=(ms,signal)=>sleep(ms,undefined,{signal}),now=Date.now,
  compare=(code,options)=>nativeEnrollmentDialog(code,{...options,comparison:true}),
  mutate=withEncryptedClientVaultLock,
}={}){
  const deviceId=String(flags.device||'');
  if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(deviceId))
    throw new Error('A paired --device UUID is required');
  await initialize();
  const {vault,record,identity}=await load();
  const saved=record.devices.find(item=>item.device===deviceId);
  const pending=record.pendingDevices?.find(item=>item.device===deviceId);
  const existing=saved||pending;
  const server=encryptedClientEndpoint(flags.server);
  // A reconnect must honor the trusted endpoint. An explicit alternative
  // --server cannot silently bypass the pinned device/server association.
  if(existing&&flags.server!==undefined&&server!==encryptedClientEndpoint(existing.server))
    throw new Error('Encrypted device is pinned to another MCP server; forget and re-enroll deliberately');
  const provisional={device:deviceId,server,
    issuer:new URL(server).hostname==='mcp.remcp.site'?'https://remcp.site':new URL(server).origin};
  const pin=existing||provisional;
  const relay=await connect({vault,pin,port:flags['oauth-port']?Number(flags['oauth-port']):42831});
  let cancelPending=null,candidate=null,approval=null,approvalTimer=null;
  try{
    const forward=async(operation,value,{signal}={})=>{
      const result=await relay.callTool({name:'e2ee_transport',arguments:{device:deviceId,operation,
        ...(operation==='packet'?{packet:value}:['enroll','cancel'].includes(operation)?{intent:value}:{})}},
        {signal,timeout:operation==='cancel'?8000:120000});
      if(result?.isError)throw new Error('Encrypted device transport unavailable');
      const data=result?.structuredContent?.data;
      if(!data)throw new Error('Encrypted transport returned an invalid response');
      return data;
    };
    const descriptor=saved?null:await forward('identity');
    if(pending&&!saved&&(descriptor.fingerprint!==pending.fingerprint||
        descriptor.publicKey!==pending.publicKey))
      throw new Error('Encrypted pending device identity changed; forget and re-enroll deliberately');
    const fingerprint=existing?.fingerprint||descriptor.fingerprint;
    const client=createE2eeDeviceClient({identity,deviceId,pinnedDevice:fingerprint,
      describe:options=>forward('identity',undefined,options),
      dispatch:(packet,options)=>forward('packet',packet,options)});
    const verify=async(signal)=>{
      const catalog=await client.listTools({signal});
      if(!catalog?.tools?.some(tool=>tool.name==='get_system_info'&&tool.annotations?.readOnlyHint===true))throw new Error('Missing scoped read grant');
      const result=await client.callTool({name:'get_system_info',arguments:{}},{signal});
      if(result?.isError||!result?.content?.some(item=>item.type==='text'&&item.text?.trim()))
        throw new Error('Encrypted device verification failed');
    };
    if(!saved){
      let verified=false;
      if(pending){
        // A crash or failed final vault write may have left an approved grant.
        // Recover only after proof of possession of the exact candidate key.
        try{await verify();verified=true;}catch(error){
          if(/identity_changed/.test(error?.message||''))throw error;
          if(now()<pending.expiresAt)throw new Error('Encrypted enrollment is pending; retry after approval or expiry');
        }
      }
      if(verified){
        if(pending.localComparison!==true)
          throw new Error('Encrypted enrollment has no durable local comparison; revoke the grant locally and deliberately re-enroll');
        candidate=pending;
      }
      else{
        const {intent,code}=await createEnrollmentIntent({browser:identity,descriptor,device:deviceId,
          permission:'assistant',now:now()});
        candidate={...provisional,server:pin.server,issuer:pin.issuer,
          publicKey:descriptor.publicKey,fingerprint,nonce:intent.nonce,
          expiresAt:intent.createdAt+ENROLL_TTL_MS};
        // Durable recovery record before the owner can possibly approve.
        // This is NOT a trusted pin and is never used without encrypted proof.
        await mutate(async()=>{
          const current=await vault.read();
          const previous=current?.pendingDevices||[];
          const prior=previous.find(item=>item.device===deviceId);
          if(current?.identity?.publicKey!==identity.publicKey||!Array.isArray(current.devices)||
              current.devices.some(item=>item.device===deviceId)||
              prior?.nonce!==pending?.nonce||
              current.devices.length+previous.filter(item=>item.device!==deviceId).length>=32)
            throw new Error('Encrypted client identity or device pin changed during enrollment');
          await vault.write({...current,pendingDevices:[...previous.filter(item=>item.device!==deviceId),candidate]});
        });
        report('ReMCP: compare the codes in the local ReMCP window and on the paired device.');
        approval=new AbortController();const {signal}=approval;
        const deadline=Math.min(candidate.expiresAt,now()+120000);
        const declined=()=>approval.abort(new Error('AI client comparison declined or unavailable'));
        // A known unoffered candidate can be discarded without a relay cancellation.
        cancelPending=async()=>({cancelled:true});
        const confirmation=Promise.resolve(compare(code,{signal})).then(ok=>{
          if(ok!==true)declined();return ok===true;
        },()=>{declined();return false;});
        approvalTimer=setTimeout(()=>approval.abort(new Error('Encrypted AI client was not approved on the device')),Math.max(1,deadline-now()));
        approvalTimer.unref?.();
        await Promise.resolve();signal.throwIfAborted();
        if(now()>=deadline)throw new Error('Encrypted AI client comparison expired');
        cancelPending=()=>forward('cancel',intent);
        await forward('enroll',intent,{signal});
        while(now()<deadline){
          signal.throwIfAborted();
          try{await verify(signal);verified=true;break;}
          catch(error){
            signal.throwIfAborted();
            if(/identity_changed/.test(error?.message||''))throw error;
            await delay(1500,signal);
          }
        }
        if(!verified)throw new Error('Encrypted AI client was not approved on the device');
        // Wait for explicit local approval even when the remote grant arrived first.
        await new Promise((resolve,reject)=>{
          const abort=()=>reject(signal.reason);
          signal.addEventListener('abort',abort,{once:true});
          confirmation.then(ok=>ok?resolve():reject(signal.reason||new Error('AI client comparison declined or unavailable')))
            .finally(()=>signal.removeEventListener('abort',abort));
          if(signal.aborted)abort();
        });
        signal.throwIfAborted();
        if(now()>=deadline)throw new Error('Encrypted AI client comparison expired');
        // Persist local consent against the exact pending nonce and keys. A crash
        // after this write can recover only with independent encrypted proof.
        await mutate(async()=>{
          const current=await vault.read(),previous=current?.pendingDevices||[];
          const prior=previous.find(item=>item.device===deviceId);
          signal.throwIfAborted();
          if(current?.identity?.publicKey!==identity.publicKey||!Array.isArray(current.devices)||
              current.devices.some(item=>item.device===deviceId)||!prior||
              ['nonce','fingerprint','publicKey','server','issuer','expiresAt'].some(key=>prior[key]!==candidate[key]))
            throw new Error('Encrypted client identity or device pin changed during comparison');
          candidate={...candidate,localComparison:true};
          await vault.write({...current,pendingDevices:previous.map(item=>item.device===deviceId?candidate:item)});
        });
      }
      // Preserve concurrent OAuth refresh and only promote the exact candidate.
      await mutate(async()=>{
        const current=await vault.read();
        const previous=current?.pendingDevices||[];
        const prior=previous.find(item=>item.device===deviceId);
        approval?.signal.throwIfAborted();
        if(current?.identity?.publicKey!==identity.publicKey||!Array.isArray(current.devices)||
            current.devices.some(item=>item.device===deviceId)||current.devices.length>=32||
            prior?.nonce!==candidate.nonce||prior.fingerprint!==candidate.fingerprint||
            prior.publicKey!==candidate.publicKey||prior.localComparison!==true||candidate.localComparison!==true||
            prior.server!==candidate.server||prior.issuer!==candidate.issuer)
          throw new Error('Encrypted client identity or device pin changed during enrollment');
        const {nonce,expiresAt,localComparison,...trusted}=candidate;
        await vault.write({...current,pendingDevices:previous.filter(item=>item.device!==deviceId),
          devices:[...current.devices,trusted]});
      });
      cancelPending=null;clearTimeout(approvalTimer);
      report('ReMCP: encrypted AI desktop connection verified. Future starts use the saved device key.');
    }
    await client.listTools();
    return {client,relay};
  }catch(error){
    const cause=approval?.signal.aborted?approval.signal.reason:error;
    approval?.abort();
    if(cancelPending)try{
      const result=await cancelPending();
      if(result?.cancelled===true){
        // Only an acknowledged pre-commit cancellation permits removal.
        await mutate(async()=>{
          const current=await vault.read();
          if(current?.identity?.publicKey!==identity.publicKey)return;
          const previous=current.pendingDevices||[];
          if(previous.some(item=>item.device===deviceId&&item.nonce===candidate?.nonce)){
            const remaining=previous.filter(item=>item.device!==deviceId||item.nonce!==candidate.nonce);
            // A new cancelled offer cannot prove that an older ambiguous
            // approval did not commit. Retain the older recovery record.
            await vault.write({...current,pendingDevices:pending?[...remaining,pending]:remaining});
          }
        });
      }else report('ReMCP: device approval may have committed; recovery key retained in the client vault.');
    }catch{report('ReMCP: enrollment cancellation unconfirmed; recovery key retained in the client vault.');}
    await relay.close();throw cause;
  }finally{clearTimeout(approvalTimer);approval?.abort();}
}
