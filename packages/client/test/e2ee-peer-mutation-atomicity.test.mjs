import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createE2eeIdentity} from '../src/agent-e2ee-crypto.mjs';
import {manageE2eePeer,e2eePairingBinding} from '../src/cli/e2ee-identity.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const config={deviceId:'aaaaaaaa-1111-4111-8111-111111111111',
  deviceToken:'isolated-synthetic-pairing',serverUrl:'https://remcp.site'};
function fakeVault(initial,slowFingerprint){
  let record=structuredClone(initial);
  let reads=0,writes=0;
  return {
    async read(){reads++;return structuredClone(record);},
    async write(next){
      // Without a cross-operation lock this stale write races with revoke.
      if(slowFingerprint&&next.peers.some(p=>p.fingerprint===slowFingerprint))
        await wait(40);
      writes++;record=structuredClone(next);
    },
    get:()=>structuredClone(record),
    stats:()=>({reads,writes}),
  };
}
const flags=identity=>({'public-key':identity.publicKey,
  fingerprint:identity.fingerprint,mode:'read',tools:'get_system_info'});

test('a simultaneous new trust cannot resurrect a revoked local peer',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'remcp-e2ee-peer-race-'));
  try{
    const previous=await createE2eeIdentity(),added=await createE2eeIdentity();
    const vault=fakeVault({version:1,deviceId:config.deviceId,
      pairing:e2eePairingBinding(config),identity:{publicKey:'test-device-only'},
      peers:[{...flags(previous),publicKey:previous.publicKey,mode:'read',
        tools:['get_system_info'],label:'previous'}]},added.fingerprint);
    await Promise.all([
      manageE2eePeer(config,'trust',flags(added),{directory,vault}),
      manageE2eePeer(config,'revoke',{fingerprint:previous.fingerprint},{directory,vault}),
    ]);
    assert.deepEqual(vault.get().peers.map(peer=>peer.fingerprint),[added.fingerprint],
      'a stale grant write must not resurrect the revoked peer');
    assert.equal(vault.stats().writes,2);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('two simultaneous first client grants are both persisted',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'remcp-e2ee-two-grants-'));
  try{
    const first=await createE2eeIdentity(),second=await createE2eeIdentity();
    const vault=fakeVault({version:1,deviceId:config.deviceId,
      pairing:e2eePairingBinding(config),identity:{publicKey:'test-device-only'},
      peers:[]},first.fingerprint);
    await Promise.all([
      manageE2eePeer(config,'trust',flags(first),{directory,vault}),
      manageE2eePeer(config,'trust',flags(second),{directory,vault}),
    ]);
    assert.deepEqual(new Set(vault.get().peers.map(p=>p.fingerprint)),
      new Set([first.fingerprint,second.fingerprint]),
      'neither peer approval may be lost');
    assert.equal(vault.stats().writes,2);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('aborted pending enrollment cannot persist a peer after a delayed vault read',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'remcp-e2ee-peer-cancel-'));
  let entered,release,writeCount=0;
  const readStarted=new Promise(resolve=>{entered=resolve;});
  const readReleased=new Promise(resolve=>{release=resolve;});
  const controller=new AbortController(),peer=await createE2eeIdentity();
  const vault={async read(){entered();await readReleased;return {version:1,deviceId:config.deviceId,
    pairing:e2eePairingBinding(config),identity:{publicKey:'test-device-only'},peers:[]};},
    async write(){writeCount++;}};
  try{
    const approval=manageE2eePeer(config,'trust',flags(peer),{
      directory,vault,signal:controller.signal});
    await readStarted;
    controller.abort(new Error('enrollment_cancelled'));
    release();
    await assert.rejects(approval,/enrollment_cancelled/);
    assert.equal(writeCount,0,'Cancelled approval cannot write a peer into the OS vault');
  }finally{release?.();await rm(directory,{recursive:true,force:true});}
});

test('approval records irreversible commit boundary immediately before owner vault write',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'remcp-e2ee-peer-write-'));
  const peer=await createE2eeIdentity();
  let entered,release,committing=false,commits=0;
  const started=new Promise(resolve=>{entered=resolve;});
  const held=new Promise(resolve=>{release=resolve;});
  const vault={read:async()=>({version:1,deviceId:config.deviceId,
    pairing:e2eePairingBinding(config),identity:{publicKey:'test-device-only'},peers:[]}),
    async write(){assert.equal(committing,true,'Write must not start before owner commit fence');
      entered();await held;commits++;}};
  try{
    const write=manageE2eePeer(config,'trust',flags(peer),{directory,vault,
      beginCommit:()=>{committing=true;}});
    await started;release();await write;
    assert.equal(commits,1);
  }finally{release?.();await rm(directory,{recursive:true,force:true});}
});

test('unknown management action cannot create an E2EE peer',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'remcp-e2ee-unknown-op-'));
  try{
    const client=await createE2eeIdentity();
    const vault=fakeVault({version:1,deviceId:config.deviceId,
      pairing:e2eePairingBinding(config),identity:{publicKey:'test-device-only'},peers:[]});
    await assert.rejects(manageE2eePeer(config,'other',flags(client),{directory,vault}),
      /Unknown E2EE peer action/);
    assert.equal(vault.stats().writes,0);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('stale vault mutation lock fails closed rather than reviving prior grants',async()=>{
  const {mkdir}=await import('node:fs/promises');
  const {withE2eeVaultMutation}=await import('../src/cli/e2ee-vault-lock.mjs');
  const directory=await mkdtemp(path.join(tmpdir(),'remcp-e2ee-peer-lock-'));
  try{
    await mkdir(path.join(directory,'.e2ee-vault-write.lock'),{mode:0o700});
    let entered=false;
    await assert.rejects(withE2eeVaultMutation(directory,async()=>{entered=true;},
      {timeoutMs:90,pollMs:10}),/vault write lock busy/);
    assert.equal(entered,false,'Never write while a lock is owned by another process');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('device identity rotation is serialized against a delayed old-key grant',async()=>{
  const {initializeDeviceE2ee}=await import('../src/cli/e2ee-identity.mjs');
  const {exportE2eeIdentity}=await import('../src/agent-e2ee-crypto.mjs');
  const directory=await mkdtemp(path.join(tmpdir(),'remcp-e2ee-peer-rotate-'));
  try{
    const old=await createE2eeIdentity(),newPeer=await createE2eeIdentity();
    const vault=fakeVault({version:1,deviceId:config.deviceId,
      pairing:e2eePairingBinding(config),identity:await exportE2eeIdentity(old),peers:[]});
    let beginRotation;
    const rotationEntered=new Promise(resolve=>{beginRotation=resolve;});
    const originalRead=vault.read;
    vault.read=async()=>{beginRotation();return originalRead();};
    const rotation=initializeDeviceE2ee(config,{directory,rotate:true,vault});
    // Establish that rotation already owns the OS lock before the late grant.
    await rotationEntered;
    const staleGrant=manageE2eePeer(config,'trust',flags(newPeer),{
      directory,vault,expectedDeviceKey:old.publicKey});
    await rotation;
    await assert.rejects(staleGrant,/identity changed/);
    assert.equal(vault.get().peers.length,0,
      'The old approval cannot follow device identity rotation');
    assert.notEqual(vault.get().identity.publicKey,old.publicKey);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('owner can list approved peers while a stale write lock blocks modifications',async()=>{
  const {mkdir}=await import('node:fs/promises');
  const directory=await mkdtemp(path.join(tmpdir(),'remcp-e2ee-locked-read-'));
  try{
    const identity=await createE2eeIdentity();
    const vault=fakeVault({version:1,deviceId:config.deviceId,
      pairing:e2eePairingBinding(config),identity:{publicKey:'test-device-only'},
      peers:[{fingerprint:identity.fingerprint,publicKey:identity.publicKey,
        mode:'read',tools:['get_system_info'],label:'owner-approved'}]});
    await mkdir(path.join(directory,'.e2ee-vault-write.lock'),{mode:0o700});
    const peers=await manageE2eePeer(config,'peers',{}, {directory,vault});
    assert.deepEqual(peers,[{fingerprint:identity.fingerprint,
      mode:'read',tools:['get_system_info'],label:'owner-approved'}]);
    assert.equal(vault.stats().writes,0);
  }finally{await rm(directory,{recursive:true,force:true});}
});
