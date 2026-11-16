import test from 'node:test';
import assert from 'node:assert/strict';
import {createE2eeIdentity,sealE2eeMessage,sealE2eePacket,openE2eePacket,
  createE2eeReplayGuard} from '../src/agent-e2ee-crypto.mjs';
import {createAgentE2eeEndpoint} from '../src/agent-e2ee-endpoint.mjs';
import {createE2eeDeviceClient} from '../src/agent-e2ee-client.mjs';
const deviceId='device-1234';
async function fixture({mode='control',tools,invoke}={}){
  const device=await createE2eeIdentity(),owner=await createE2eeIdentity(),calls=[],wire=[];
  let peer={publicKey:owner.publicKey,fingerprint:owner.fingerprint,mode,tools};
  const endpoint=createAgentE2eeEndpoint({identity:device,deviceId,getPeer:async()=>peer,
    getRuntimeState:()=>({runtimeDown:false,mcp:{
      listTools:async()=>({tools:[{name:'read',annotations:{readOnlyHint:true}},
        {name:'write',annotations:{readOnlyHint:false}},{name:'unknown'}]}),
      callTool:async(args,options)=>{
        calls.push(args);return invoke?invoke(args,options):{content:[{type:'text',text:args.arguments.text}]};
      }}})});
  const client=createE2eeDeviceClient({identity:owner,deviceId,pinnedDevice:device.fingerprint,
    describe:async()=>endpoint.identity(),dispatch:async(packet,options)=>{
      wire.push(JSON.stringify(packet));const response=await endpoint.handle(packet,options);
      wire.push(JSON.stringify(response));return response;
    }});
  const packet=async(body,overrides={})=>(await sealE2eeMessage({
    sender:owner,recipient:device.publicKey,pinnedRecipient:device.fingerprint,device:deviceId,
    epoch:endpoint.identity().epoch,session:'session-1234',call:'call-1234',direction:'request',
    plaintext:JSON.stringify(body),...overrides}))[0];
  return {device,owner,calls,wire,endpoint,client,packet,setPeer:value=>{peer=value;}};
}
test('real endpoint executes an encrypted request and no plaintext reaches relay',async()=>{
  const f=await fixture(),secret='private 日本語 Привет';
  const result=await f.client.callTool({name:'write',arguments:{text:secret}});
  assert.equal(result.content[0].text,secret);assert.equal(f.calls.length,1);
  assert.ok(f.wire.every(value=>!value.includes(secret)&&!value.includes('"name":"write"')));
});
test('read grant filters tools and denies control including unannotated tools',async()=>{
  const f=await fixture({mode:'read'});
  assert.deepEqual((await f.client.listTools()).tools.map(t=>t.name),['read']);
  await assert.rejects(f.client.callTool({name:'write',arguments:{text:'x'}}),/tool_not_authorized/);
  await assert.rejects(f.client.callTool({name:'unknown'}),/tool_not_authorized/);
  assert.equal(f.calls.length,0);
});
test('a live client downgraded from control to read loses write access immediately',async()=>{
  const f=await fixture({mode:'control'});
  assert.equal((await f.client.listTools()).tools.some(t=>t.name==='write'),true);
  f.setPeer({publicKey:f.owner.publicKey,fingerprint:f.owner.fingerprint,mode:'read'});
  assert.deepEqual((await f.client.listTools()).tools.map(t=>t.name),['read']);
  await assert.rejects(f.client.callTool({name:'write',arguments:{text:'must not write'}}),/tool_not_authorized/);
  assert.equal(f.calls.length,0);
});
test('per-peer allowlist applies to both catalog and actual calls',async()=>{
  const f=await fixture({tools:['read']});
  assert.equal((await f.client.listTools()).tools.length,1);
  await assert.rejects(f.client.callTool({name:'write'}),/tool_not_authorized/);
});
test('authenticated replay and fresh ciphertext with the same call ID execute once',async()=>{
  const f=await fixture(),body={method:'tools/call',params:{name:'write',arguments:{text:'once'}}};
  const p=await f.packet(body);await f.endpoint.handle(p);
  await assert.rejects(f.endpoint.handle(p),/rejected/);
  await assert.rejects(f.endpoint.handle(await f.packet(body)),/rejected/);
  assert.equal(f.calls.length,1);
});
test('device boot epoch rejects old commands even when replay state is fresh',async()=>{
  const f=await fixture(),old=await f.packet({method:'tools/call',params:{name:'write'}});
  const restarted=createAgentE2eeEndpoint({identity:f.device,deviceId,
    getPeer:async()=>({publicKey:f.owner.publicKey,fingerprint:f.owner.fingerprint,mode:'control'}),
    getRuntimeState:()=>{throw new Error('must not execute');}});
  await assert.rejects(restarted.handle(old),/rejected/);assert.equal(f.calls.length,0);
});
test('large uploads and pulled results preserve complete bytes without repeating tools',async()=>{
  const f=await fixture(),text='long日本語'.repeat(120000);
  const result=await f.client.callTool({name:'write',arguments:{text}});
  assert.equal(result.content[0].text,text);assert.equal(f.calls.length,1);
  assert.ok(f.wire.length>8);assert.ok(f.wire.every(value=>value.length<280*1024));
});
test('revoked peer cannot fetch cached results',async()=>{
  const f=await fixture(),p=await f.packet({method:'tools/list',params:{}});
  await f.endpoint.handle(p);f.setPeer(null);
  const pull=await f.packet({method:'result/pull',params:{index:0}});
  await assert.rejects(f.endpoint.handle(pull),/rejected/);
});
test('wrong trusted device pin is denied before sending a command',async()=>{
  const f=await fixture(),other=await createE2eeIdentity();
  const client=createE2eeDeviceClient({identity:f.owner,deviceId,pinnedDevice:other.fingerprint,
    describe:async()=>f.endpoint.identity(),dispatch:()=>{throw new Error('must not dispatch');}});
  await assert.rejects(client.listTools(),/identity_changed/);
});
test('cancellation reaches the local runtime and error content stays encrypted',async()=>{
  const controller=new AbortController();
  const f=await fixture({invoke:async(_args,{signal})=>{
    controller.abort();signal.throwIfAborted();
  }});
  const p=await f.packet({method:'tools/call',params:{name:'write',arguments:{text:'secret'}}});
  const result=await f.endpoint.handle(p,{signal:controller.signal});
  assert.ok(!JSON.stringify(result).includes('cancelled'));
  const clear=await openE2eePacket({receiver:f.owner,sender:f.device.publicKey,
    pinnedSender:f.device.fingerprint,packet:result.packet,device:deviceId,
    epoch:f.endpoint.identity().epoch,session:p.session,call:p.call,
    direction:'response',replay:createE2eeReplayGuard()});
  assert.equal(JSON.parse(new TextDecoder().decode(clear)).error.message,'cancelled');
});
