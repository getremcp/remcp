import {createHash} from 'node:crypto';
import {createE2eeIdentity,exportE2eeIdentity,importE2eeIdentity,e2eeFingerprint} from '../agent-e2ee-crypto.mjs';
import {createE2eeVault} from './e2ee-vault.mjs';
import {withE2eeVaultMutation} from './e2ee-vault-lock.mjs';
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
export async function initializeDeviceE2ee(config,{directory=configDir,rotate=false,
  vault=createE2eeVault({directory})}={}) {
  if(!config?.deviceId)throw new Error('Pair this computer before initializing E2EE');
  return withE2eeVaultMutation(directory,async()=>{
    const existing=await vault.read();
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
  });
}
// An annotation supplied by a local tool server is not enough to grant
// read access. The device owner must independently name every allowed tool.
export function parseE2eePeerTools(mode,raw) {
  const tools=raw===undefined?undefined:String(raw).split(',');
  if(mode==='read'&&!tools)throw new Error('Read-only E2EE peers require an explicit --tools allowlist');
  if(tools&&(!tools.length||tools.length>64||
      tools.some(name=>!/^[_a-z0-9]{1,80}$/.test(name))||new Set(tools).size!==tools.length))
    throw new Error('Invalid tool allowlist');
  return tools;
}
export async function manageE2eePeer(config,action,flags,{directory=configDir,expectedDeviceKey,
  signal,assertActive,beginCommit,vault=createE2eeVault({directory})}={}) {
  if(!['trust','peers','revoke'].includes(action))throw new Error('Unknown E2EE peer action');
  const perform=async()=>{
    const record=await vault.read();
    if(!record||record.deviceId!==config.deviceId||record.pairing!==e2eePairingBinding(config))
      throw new Error('Initialize E2EE for this local pairing first');
    // A one-time browser code authenticates a specific device public key.
    // Reject local approval after rotation instead of trusting a new identity.
    if(expectedDeviceKey!==undefined&&record.identity?.publicKey!==expectedDeviceKey)
      throw new Error('E2EE device identity changed; request a fresh local approval');
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
      const tools=parseE2eePeerTools(mode,flags.tools);
      const peer={fingerprint,publicKey,mode,...(tools?{tools}:{}),
        label:String(flags.label||'Trusted client').slice(0,80)};
      record.peers=[...record.peers.filter(item=>item.fingerprint!==fingerprint),peer];
    }
    // Cancellation/expiry can arrive while awaiting the serialized vault
    // lock or key validation; never commit a grant after that point.
    signal?.throwIfAborted();
    if(beginCommit)beginCommit();else assertActive?.();
    await vault.write(record);
    return {action,fingerprint};
  };
  // Listing grants is read-only and should remain available to the owner
  // even if a previous mutation process crashed while holding its lock.
  return action==='peers'?perform():withE2eeVaultMutation(directory,perform);
}
