// First-party AI bridge enrollment: OAuth authenticates account ownership;
// independent native confirmation binds the keys. No relay reply grants trust.
import {createE2eeDeviceClient} from '../agent-e2ee-client.mjs';
import {createEnrollmentIntent} from '../e2ee-enrollment-code.mjs';
import {loadEncryptedClient,manageEncryptedClient,encryptedClientEndpoint} from './e2ee-client-profile.mjs';
import {connectEncryptedRelay} from './e2ee-oauth.mjs';
import {withEncryptedClientVaultLock} from './e2ee-client-mutation.mjs';

export async function prepareEncryptedMcpConnection(flags={},{
  load=loadEncryptedClient,initialize=()=>manageEncryptedClient('client-init'),
  connect=connectEncryptedRelay,report=text=>process.stderr.write(text+'\n'),
  delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=Date.now,
  mutate=withEncryptedClientVaultLock,
}={}){
  const deviceId=String(flags.device||'');
  if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(deviceId))
    throw new Error('A paired --device UUID is required');
  await initialize();
  const {vault,record,identity}=await load();
  const saved=record.devices.find(item=>item.device===deviceId);
  const server=encryptedClientEndpoint(flags.server);
  // A reconnect must honor the trusted endpoint. An explicit alternative
  // --server cannot silently bypass the pinned device/server association.
  if(saved&&flags.server!==undefined&&server!==encryptedClientEndpoint(saved.server))
    throw new Error('Encrypted device is pinned to another MCP server; forget and re-enroll deliberately');
  const provisional={device:deviceId,server,
    issuer:new URL(server).hostname==='mcp.remcp.site'?'https://remcp.site':new URL(server).origin};
  const pin=saved||provisional;
  const relay=await connect({vault,pin,port:flags['oauth-port']?Number(flags['oauth-port']):42831});
  let cancelPending=null;
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
    const fingerprint=saved?.fingerprint||descriptor.fingerprint;
    const client=createE2eeDeviceClient({identity,deviceId,pinnedDevice:fingerprint,
      describe:options=>forward('identity',undefined,options),
      dispatch:(packet,options)=>forward('packet',packet,options)});
    if(!saved){
      const {intent,code}=await createEnrollmentIntent({browser:identity,descriptor,device:deviceId,
        permission:'assistant',now:now()});
      report('ReMCP: compare '+code+' with the secure connection dialog on the device, then approve the AI desktop client.');
      // A failure/timeout must close a pending native approval prompt and
      // fence its nonce, not leave authorization possible after the CLI exits.
      cancelPending=()=>forward('cancel',intent);
      await forward('enroll',intent);
      const deadline=now()+120000;let verified=false;
      while(now()<deadline){
        try{
          const catalog=await client.listTools();
          if(!catalog?.tools?.some(tool=>tool.name==='get_system_info'))throw new Error('Missing scoped read grant');
          const result=await client.callTool({name:'get_system_info',arguments:{}});
          if(result?.isError||!result?.content?.some(item=>item.type==='text'&&item.text?.trim()))
            throw new Error('Encrypted device verification failed');
          verified=true;break;
        }catch(error){
          if(/identity_changed/.test(error?.message||''))throw error;
          await delay(1500);
        }
      }
      if(!verified)throw new Error('Encrypted AI client was not approved on the device');
      // OAuth may have refreshed tokens while consent was pending. Re-read the
      // vault and preserve those tokens; never replace a concurrently saved pin.
      await mutate(async()=>{
        const current=await vault.read();
        if(current?.identity?.publicKey!==identity.publicKey||!Array.isArray(current.devices)||
            current.devices.some(item=>item.device===deviceId)||current.devices.length>=32)
          throw new Error('Encrypted client identity or device pin changed during enrollment');
        await vault.write({...current,devices:[...current.devices,{...provisional,
          publicKey:descriptor.publicKey,fingerprint}]});
      });
      cancelPending=null;
      report('ReMCP: encrypted AI desktop connection verified. Future starts use the saved device key.');
    }
    await client.listTools();
    return {client,relay};
  }catch(error){
    if(cancelPending)try{await cancelPending();}catch{}
    await relay.close();throw error;
  }
}
