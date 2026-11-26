import test from 'node:test';
import assert from 'node:assert/strict';
import { createE2eeIdentity, sealE2eeMessage } from '../src/agent-e2ee-crypto.mjs';
import { createAgentE2eeEndpoint } from '../src/agent-e2ee-endpoint.mjs';

function gate(){let release;const promise=new Promise(r=>{release=r;});return {promise,release};}
async function fixture(t,{listGate,callGate,callTimeoutMs=110000}={}){
  const device=await createE2eeIdentity(), owner=await createE2eeIdentity();
  const listEntered=gate(),callEntered=gate();let calls=0,clock=Date.now(),monotonic=0,toolTimeout;
  let peer={publicKey:owner.publicKey,fingerprint:owner.fingerprint,mode:'control'};
  const endpoint=createAgentE2eeEndpoint({identity:device,deviceId:'synthetic-device',now:()=>clock,monotonicNow:()=>monotonic,getPeer:async()=>peer,
    getRuntimeState:()=>({callTimeoutMs,mcp:{listTools:async()=>{listEntered.release();if(listGate)await listGate.promise;return {tools:[{name:'synthetic'}]};},
      callTool:async(_params,options)=>{toolTimeout=options.timeout;calls++;callEntered.release();if(callGate)await callGate.promise;return {ok:true};}}})});
  t.after(()=>endpoint.close());
  async function packet(call='synthetic-call'){
    return (await sealE2eeMessage({sender:owner,recipient:device.publicKey,pinnedRecipient:device.fingerprint,
      device:'synthetic-device',epoch:endpoint.identity().epoch,session:'synthetic-session',call,direction:'request',
      now:clock,plaintext:JSON.stringify({method:'tools/call',params:{name:'synthetic'}})}))[0];
  }
  return {endpoint,packet,listEntered,callEntered,revoke:()=>{peer=null;},advance:ms=>{clock+=ms;},advanceMonotonic:ms=>{monotonic+=ms;},toolTimeout:()=>toolTimeout,calls:()=>calls};
}
test('peer revoked while runtime catalog is pending never dispatches tool',async t=>{
  const blocked=gate(),f=await fixture(t,{listGate:blocked});
  const request=f.endpoint.handle(await f.packet());const rejected=assert.rejects(request,/rejected/);
  await f.listEntered.promise;f.revoke();blocked.release();await rejected;
  assert.equal(f.calls(),0);
});
test('endpoint close while catalog is pending blocks dispatch and response',async t=>{
  const blocked=gate(),f=await fixture(t,{listGate:blocked});
  const request=f.endpoint.handle(await f.packet());const rejected=assert.rejects(request,/closed|rejected/);
  await f.listEntered.promise;f.endpoint.close();blocked.release();await rejected;
  assert.equal(f.calls(),0);
});
test('a running call remains reserved across replay TTL and cannot execute twice',async t=>{
  const blocked=gate(),f=await fixture(t,{callGate:blocked});
  const request=f.endpoint.handle(await f.packet());
  await f.callEntered.promise;f.advance(180000);
  try{await assert.rejects(f.endpoint.handle(await f.packet()),/rejected/);assert.equal(f.calls(),1);}
  finally{blocked.release();await request;}
});
test('worst-case response reservations bound active runtime work even when adapters ignore cancellation',async t=>{
  const blocked=gate(),f=await fixture(t,{callGate:blocked});
  const packets=await Promise.all(Array.from({length:24},(_,i)=>f.packet('synthetic-call-'+i)));
  const work=packets.map(p=>f.endpoint.handle(p).then(()=>true,()=>false));
  try{
    const deadline=Date.now()+2000;
    while(f.calls()<2&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
    await new Promise(r=>setTimeout(r,100));
    assert.equal(f.calls(),2);
  }finally{blocked.release();}
  const results=await Promise.all(work);
  assert.equal(results.filter(Boolean).length,2);
});

test('packet admission is bounded before any OS vault lookup, even if it stalls',async t=>{
  const identity=await createE2eeIdentity(),blocked=gate();
  let reads=0;
  const endpoint=createAgentE2eeEndpoint({identity,deviceId:'synthetic-device',
    getPeer:async()=>{reads++;await blocked.promise;return null;},
    getRuntimeState:()=>{throw Error('must not execute');}});
  t.after(()=>endpoint.close());
  const work=Array.from({length:40},()=>endpoint.handle({from:'synthetic-peer'}).then(()=>false,()=>true));
  try{
    assert.equal(reads,32,'bound work before native vault calls or decryption');
  }finally{blocked.release();}
  assert.ok((await Promise.all(work)).every(Boolean));
  await assert.rejects(endpoint.handle({from:'synthetic-peer'}),/rejected/);
  assert.equal(reads,33,'completed failures must release admission capacity');
});


test('slow E2EE catalog consumes the runtime budget rather than resetting it',async t=>{
  const blocked=gate(),f=await fixture(t,{listGate:blocked,callTimeoutMs:10000});
  const request=f.endpoint.handle(await f.packet());
  await f.listEntered.promise;f.advanceMonotonic(7000);blocked.release();
  await request;
  assert.equal(f.calls(),1);assert.equal(f.toolTimeout(),3000);
});
test('expired E2EE catalog budget prevents a late native side effect',async t=>{
  const blocked=gate(),f=await fixture(t,{listGate:blocked,callTimeoutMs:10000});
  const request=f.endpoint.handle(await f.packet());
  await f.listEntered.promise;f.advanceMonotonic(10001);blocked.release();
  await request;
  assert.equal(f.calls(),0);
});
