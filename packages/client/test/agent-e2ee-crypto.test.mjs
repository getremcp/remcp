import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createE2eeIdentity, e2eeFingerprint, exportE2eeIdentity, importE2eeIdentity,
  sealE2eePacket, openE2eePacket, sealE2eeMessage, openE2eeMessage,
  createE2eeReplayGuard, E2EE_CHUNK_BYTES } from '../src/agent-e2ee-crypto.mjs';
const a=await createE2eeIdentity(), b=await createE2eeIdentity(), stranger=await createE2eeIdentity();
const metadata={device:'device-1234',session:'session-1234',call:'request-1234',direction:'request',epoch:'epoch-1234'};
const seal = (overrides={}) => sealE2eePacket({sender:a,recipient:b.publicKey,
  pinnedRecipient:b.fingerprint,...metadata,plaintext:'private command 日本語 Привет',...overrides});
const open = (packet,overrides={}) => openE2eePacket({receiver:b,sender:a.publicKey,
  pinnedSender:a.fingerprint,packet,...metadata,replay:createE2eeReplayGuard(),...overrides});

test('authenticated HPKE round trip keeps Unicode command out of relay-visible JSON',async()=>{
  const packet=await seal();
  assert.equal(new TextDecoder().decode(await open(packet)),'private command 日本語 Привет');
  assert.equal(JSON.stringify(packet).includes('private command'),false);
  assert.equal(JSON.stringify(packet).includes('Привет'),false);
});
test('wrong recipient or sender identity is denied before dispatch',async()=>{
  const packet=await seal();
  await assert.rejects(open(packet,{sender:stranger.publicKey,pinnedSender:stranger.fingerprint}));
  await assert.rejects(open(packet,{receiver:stranger}));
  await assert.rejects(seal({pinnedRecipient:stranger.fingerprint}));
});
test('an attacker cannot authenticate using another clients public identity metadata',async()=>{
  const imposter={...stranger,publicKey:a.publicKey,fingerprint:a.fingerprint};
  const packet=await seal({sender:imposter});
  await assert.rejects(open(packet));
});
test('all routing metadata and ciphertext are authenticated',async()=>{
  const packet=await seal();
  for(const key of ['device','session','call','direction','from','to','nonce','enc','ciphertext','issued','expires','chunk','chunks']){
    const modified=structuredClone(packet);
    modified[key]=typeof modified[key]==='number'?modified[key]+1:String(modified[key])+'A';
    await assert.rejects(open(modified),key);
  }
  await assert.rejects(open({...packet,unexpected:'private'}));
});
test('replay, expiry and future timestamps cannot execute twice',async()=>{
  const packet=await seal(), replay=createE2eeReplayGuard();
  await open(packet,{replay});
  await assert.rejects(open(packet,{replay}));
  await assert.rejects(open(packet,{now:packet.expires}));
  await assert.rejects(open(packet,{now:packet.issued-15001}));
});
test('large results are independently authenticated bounded chunks and preserve exact bytes',async()=>{
  const input=randomBytes(2*1024*1024+31);
  const packets=await sealE2eeMessage({sender:a,recipient:b.publicKey,pinnedRecipient:b.fingerprint,
    ...metadata,plaintext:input});
  assert.equal(packets.length,Math.ceil(input.length/E2EE_CHUNK_BYTES));
  const options={receiver:b,sender:a.publicKey,pinnedSender:a.fingerprint,...metadata};
  assert.deepEqual(Buffer.from(await openE2eeMessage({...options,packets,replay:createE2eeReplayGuard()})),input);
  await assert.rejects(openE2eeMessage({...options,packets:[...packets].reverse(),replay:createE2eeReplayGuard()}));
  await assert.rejects(openE2eeMessage({...options,packets:packets.slice(1),replay:createE2eeReplayGuard()}));
});
test('persistent identity restoration verifies the secret-public key binding',async()=>{
  const record=await exportE2eeIdentity(a), restored=await importE2eeIdentity(record);
  assert.equal(restored.fingerprint,a.fingerprint);
  assert.equal(await e2eeFingerprint(restored.publicKey),a.fingerprint);
  const wrong=await exportE2eeIdentity(stranger);
  await assert.rejects(importE2eeIdentity({...record,privateKey:wrong.privateKey}));
});
test('empty message is authenticated rather than an absent ciphertext',async()=>{
  const packet=await seal({plaintext:''});
  assert.equal((await open(packet)).length,0);
});
