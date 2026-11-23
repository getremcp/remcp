import test from 'node:test';
import assert from 'node:assert/strict';
import {createE2eeIdentity,sealE2eeMessage,sealE2eePacket,openE2eePacket,
  createE2eeReplayGuard} from '../src/agent-e2ee-crypto.mjs';
import {createAgentE2eeEndpoint} from '../src/agent-e2ee-endpoint.mjs';
import {createE2eeDeviceClient} from '../src/agent-e2ee-client.mjs';
import {AI_DESKTOP_E2EE_TOOLS} from '../src/cli/e2ee-native-enrollment.mjs';
const deviceId='device-1234';
async function fixture({mode='control',tools,invoke,catalog}={}){
  const device=await createE2eeIdentity(),owner=await createE2eeIdentity(),calls=[],wire=[];
  let peer={publicKey:owner.publicKey,fingerprint:owner.fingerprint,mode,tools};
  const endpoint=createAgentE2eeEndpoint({identity:device,deviceId,getPeer:async()=>peer,
    getRuntimeState:()=>({runtimeDown:false,mcp:{
      listTools:async()=>({tools:catalog||[{name:'get_system_info',annotations:{readOnlyHint:true}},
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
  const f=await fixture({mode:'read',tools:['get_system_info']});
  assert.deepEqual((await f.client.listTools()).tools.map(t=>t.name),['get_system_info']);
  await assert.rejects(f.client.callTool({name:'write',arguments:{text:'x'}}),/tool_not_authorized/);
  await assert.rejects(f.client.callTool({name:'unknown'}),/tool_not_authorized/);
  assert.equal(f.calls.length,0);
});
test('read-only E2EE hard-denies desktop control despite a mistaken readOnlyHint',async()=>{
  const harmless=['get_system_info','desktop_webrtc_status'];
  const dangerous=AI_DESKTOP_E2EE_TOOLS.filter(name=>!harmless.includes(name));
  assert.equal(dangerous.length,22,'review new AI desktop tools before allowing read-mode access');
  const catalog=AI_DESKTOP_E2EE_TOOLS.map(name=>({name,
    annotations:{readOnlyHint:true}}));
  const f=await fixture({mode:'read',tools:catalog.map(tool=>tool.name),catalog});
  assert.deepEqual((await f.client.listTools()).tools.map(tool=>tool.name),
    ['get_system_info','desktop_webrtc_status']);
  for(const name of dangerous){
    await assert.rejects(f.client.callTool({name,arguments:{session_id:'invalid-synthetic-test'}}),
      /tool_not_authorized/,name+' should never be allowed to read-only peers');
  }
  assert.equal(f.calls.length,0,'no control-capable runtime handler may execute');
  const approved=await fixture({mode:'control',tools:['desktop_webrtc_offer'],catalog});
  assert.deepEqual((await approved.client.listTools()).tools.map(tool=>tool.name),
    ['desktop_webrtc_offer']);
  await approved.client.callTool({name:'desktop_webrtc_offer',
    arguments:{text:'synthetic-consented-only'}});
  assert.equal(approved.calls.length,1,'separate explicit control grant must keep working');
});
test('a live client downgraded from control to read loses write access immediately',async()=>{
  const f=await fixture({mode:'control'});
  assert.equal((await f.client.listTools()).tools.some(t=>t.name==='write'),true);
  f.setPeer({publicKey:f.owner.publicKey,fingerprint:f.owner.fingerprint,mode:'read',tools:['get_system_info']});
  assert.deepEqual((await f.client.listTools()).tools.map(t=>t.name),['get_system_info']);
  await assert.rejects(f.client.callTool({name:'write',arguments:{text:'must not write'}}),/tool_not_authorized/);
  assert.equal(f.calls.length,0);
});
test('per-peer allowlist applies to both catalog and actual calls',async()=>{
  const f=await fixture({tools:['get_system_info']});
  assert.equal((await f.client.listTools()).tools.length,1);
  await assert.rejects(f.client.callTool({name:'write'}),/tool_not_authorized/);
});
test('a read-only annotation cannot authorize a tool without an explicit owner grant',async()=>{
  const f=await fixture({mode:'read'});
  assert.deepEqual((await f.client.listTools()).tools,[]);
  await assert.rejects(f.client.callTool({name:'get_system_info',arguments:{text:'secret'}}),/tool_not_authorized/);
  assert.equal(f.calls.length,0);
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

// Even a malformed runtime catalog and an overly broad saved "read" tool
// list must never turn arbitrary terminal/file handlers into read authority.
test('E2EE read mode rejects unfamiliar tools with forged readOnlyHint',async()=>{
  const safe=['get_system_info','desktop_webrtc_status'];
  const unsafe=['start_process','write_file','delete_file','read_file'];
  const catalog=[...safe,...unsafe].map(name=>({name,
    annotations:{readOnlyHint:true,destructiveHint:false}}));
  const f=await fixture({mode:'read',tools:catalog.map(x=>x.name),catalog});
  assert.deepEqual((await f.client.listTools()).tools.map(x=>x.name),safe);
  for(const name of unsafe){
    await assert.rejects(f.client.callTool({name,arguments:{text:'synthetic-no-os-effect'}}),
      /tool_not_authorized/,name+' must not enter runtime from read scope');
  }
  assert.equal(f.calls.length,0,'unexpected tools must not reach the runtime');
  const readOnly=await fixture({mode:'read',tools:safe,catalog});
  assert.deepEqual((await readOnly.client.listTools()).tools.map(x=>x.name),safe);
  await readOnly.client.callTool({name:'get_system_info',arguments:{text:'test-only'}});
  assert.equal(readOnly.calls.length,1,'explicitly approved basic read remains available');
});
