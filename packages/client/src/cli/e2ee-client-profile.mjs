import {createE2eeIdentity,exportE2eeIdentity,importE2eeIdentity,e2eeFingerprint} from '../agent-e2ee-crypto.mjs';
import {createE2eeVault} from './e2ee-vault.mjs';
import {withEncryptedClientVaultLock} from './e2ee-client-mutation.mjs';

export function encryptedClientEndpoint(value='https://mcp.remcp.site/mcp'){
  const url=new URL(String(value));
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||
      !['/mcp','/mcp/'].includes(url.pathname))throw new Error('An HTTPS MCP endpoint is required');
  url.pathname='/mcp';return url.href;
}
export async function loadEncryptedClient(){
  const vault=createE2eeVault({profile:'client'}),record=await vault.read();
  if(!record?.identity||!Array.isArray(record.devices)||record.version!==1)
    throw new Error('Run remcp e2ee client-init on this computer first');
  return {vault,record,identity:await importE2eeIdentity(record.identity)};
}
export async function manageEncryptedClient(action,flags={}){
  if(action==='client-init')return withEncryptedClientVaultLock(async()=>{
    const vault=createE2eeVault({profile:'client'}),record=await vault.read();
    if(record){
      const identity=await importE2eeIdentity(record.identity);
      return {publicKey:identity.publicKey,fingerprint:identity.fingerprint};
    }
    const identity=await createE2eeIdentity();
    await vault.write({version:1,identity:await exportE2eeIdentity(identity),devices:[],oauth:{}});
    return {publicKey:identity.publicKey,fingerprint:identity.fingerprint};
  });
  if(action==='client-devices'||action==='client-login'){
    const {vault,record}=await loadEncryptedClient();
    if(action==='client-devices')return record.devices;
    const pin=record.devices.find(item=>item.device===String(flags.device||''));
    if(!pin)throw new Error('Pin this device before authorizing encrypted MCP');
    const {connectEncryptedRelay}=await import('./e2ee-oauth.mjs');
    const relay=await connectEncryptedRelay({vault,pin,port:flags['oauth-port']?Number(flags['oauth-port']):42831});
    await relay.close();return {authorized:true,device:pin.device};
  }
  const device=String(flags.device||'');
  if(!/^[0-9a-f-]{36}$/i.test(device))throw new Error('Paired --device UUID is required');
  if(!['client-forget','client-pin'].includes(action))throw new Error('Unknown encrypted client action');
  return withEncryptedClientVaultLock(async()=>{
    const {vault,record}=await loadEncryptedClient();
    if(action==='client-forget'){
      record.devices=record.devices.filter(item=>item.device!==device);
    }else{
      const fingerprint=String(flags.fingerprint||'').toLowerCase(),publicKey=String(flags['public-key']||'');
      if(!/^[0-9a-f]{64}$/.test(fingerprint)||await e2eeFingerprint(publicKey)!==fingerprint)
        throw new Error('Device public key must match the independently confirmed full fingerprint');
      const server=encryptedClientEndpoint(flags.server);
      const issuer=new URL(server).hostname==='mcp.remcp.site'?'https://remcp.site':new URL(server).origin;
      if(record.devices.length>=32&&!record.devices.some(item=>item.device===device))
        throw new Error('Maximum 32 trusted devices');
      record.devices=[...record.devices.filter(item=>item.device!==device),
        {device,publicKey,fingerprint,server,issuer}];
    }
    await vault.write(record);
    return {action,device};
  });
}
