import {createHash} from 'node:crypto';
import {createE2eeIdentity,exportE2eeIdentity,importE2eeIdentity,e2eeFingerprint} from '../agent-e2ee-crypto.mjs';
import {createE2eeVault} from './e2ee-vault.mjs';
import {configDir} from './env.mjs';

export function e2eePairingBinding(config){
  if(!config?.deviceId||typeof config.deviceToken!=='string'||!config.deviceToken||!config.serverUrl)
    throw new Error('A complete local device pairing is required for E2EE');
  return createHash('sha256').update(JSON.stringify([
    'remcp-device-pairing-v1',config.deviceId,new URL(config.serverUrl).href,config.deviceToken,
  ])).digest('hex');
}
// Each record (secret key and pinned client grants) is stored together in the
// OS vault. A relay/database write cannot add an authorized encryption peer.
export async function loadDeviceE2eeProfile(config,{directory=configDir}={}) {
  if(config?.e2eeIdentity!==true)return null;
  const vault=createE2eeVault({directory});
  const record=await vault.read();
  if(!record?.identity||record.deviceId!==config.deviceId||record.pairing!==e2eePairingBinding(config)||!Array.isArray(record.peers))
    throw new Error('E2EE identity missing from OS vault; refusing transport downgrade');
  const identity=await importE2eeIdentity(record.identity);
  return {identity,getPeer:async fingerprint=>{
    const current=await vault.read();
    if(current?.deviceId!==config.deviceId||current.pairing!==e2eePairingBinding(config)||
        current.identity?.publicKey!==identity.publicKey)return null;
    return current.peers?.find(peer=>peer.fingerprint===fingerprint)||null;
  }};
}
export async function initializeDeviceE2ee(config,{directory=configDir,rotate=false}={}) {
  if(!config?.deviceId)throw new Error('Pair this computer before initializing E2EE');
  const vault=createE2eeVault({directory}),existing=await vault.read();
  if(existing&&!rotate){
    if(existing.deviceId!==config.deviceId||existing.pairing!==e2eePairingBinding(config))
      throw new Error('OS vault belongs to another pairing; use local remcp e2ee rotate to revoke old peers');
    const identity=await importE2eeIdentity(existing.identity);
    return {publicKey:identity.publicKey,fingerprint:identity.fingerprint};
  }
  const identity=await createE2eeIdentity();
  await vault.write({version:1,deviceId:config.deviceId,pairing:e2eePairingBinding(config),
    identity:await exportE2eeIdentity(identity),peers:[]});
  return {publicKey:identity.publicKey,fingerprint:identity.fingerprint};
}
export async function manageE2eePeer(config,action,flags,{directory=configDir}={}) {
  const vault=createE2eeVault({directory}),record=await vault.read();
  if(!record||record.deviceId!==config.deviceId||record.pairing!==e2eePairingBinding(config))
    throw new Error('Initialize E2EE for this local pairing first');
  if(action==='peers')return record.peers.map(({publicKey,...peer})=>peer);
  const fingerprint=String(flags.fingerprint||'').toLowerCase();
  if(!/^[0-9a-f]{64}$/.test(fingerprint))throw new Error('An independently verified full fingerprint is required');
  if(action==='revoke'){
    record.peers=record.peers.filter(peer=>peer.fingerprint!==fingerprint);
  }else{
    const publicKey=String(flags['public-key']||''),mode=String(flags.mode||'read');
    if(await e2eeFingerprint(publicKey)!==fingerprint)throw new Error('Public key does not match confirmed fingerprint');
    if(!['read','control'].includes(mode))throw new Error('Peer mode must be read or control');
    if(record.peers.length>=32&&!record.peers.some(peer=>peer.fingerprint===fingerprint))
      throw new Error('Maximum 32 encryption peers');
    const tools=flags.tools?String(flags.tools).split(','):undefined;
    if(tools&&(!tools.length||tools.some(name=>!/^[_a-z0-9]{1,80}$/.test(name))))
      throw new Error('Invalid tool allowlist');
    const peer={fingerprint,publicKey,mode,...(tools?{tools}:{}),
      label:String(flags.label||'Trusted client').slice(0,80)};
    record.peers=[...record.peers.filter(item=>item.fingerprint!==fingerprint),peer];
  }
  await vault.write(record);
  return {action,fingerprint};
}
