import test from 'node:test';
import assert from 'node:assert/strict';
import {callAgentRuntimeTool} from '../src/agent-media-ice.mjs';
import {validateDeviceIce} from '../src/webrtc-device-ice-contract.mjs';
const sid='aaaaaaaa-1111-4111-8111-111111111111';
const config=()=>{const expiresAt=Math.floor(Date.now()/1000)+720;return {
 iceServers:[{urls:['turn:turn.remcp.site:3478?transport=tcp'],username:expiresAt+':'+'a'.repeat(32),credential:'A'.repeat(27)+'='}],
 expiresAt,ttlSeconds:720};};
test('agent fetches ICE as itself and forwards only validated local metadata to media runtime',async()=>{
 let captured,request;
 const ice=config();
 const result=await callAgentRuntimeTool({mcp:{callTool:async(p)=>{captured=p;return 'ok';}},
  params:{name:'desktop_webrtc_offer',arguments:{session_id:sid},_meta:{'remcp/native-ice':{evil:true}}},
  serverUrl:'https://remcp.site',deviceToken:'local-fixture-token',encrypted:true,
  fetchFn:async(url,options)=>{request={url:String(url),...options};return Response.json(ice);}});
 assert.equal(result,'ok');assert.equal(request.url,'https://remcp.site/api/agent-webrtc/native-ice');
 assert.equal(request.headers.Authorization,'Bearer local-fixture-token');
 assert.equal(request.redirect,'error');
 assert.deepEqual(JSON.parse(request.body),{session_id:sid,encrypted:true});
 assert.deepEqual(captured._meta,{'remcp/native-ice':ice});
});
test('ordinary calls cannot inject private metadata and never fetch TURN',async()=>{
 let captured;
 await callAgentRuntimeTool({mcp:{callTool:async p=>{captured=p;}},params:{
  name:'read_file',arguments:{path:'fixture'},_meta:{'remcp/native-ice':config()}},
  fetchFn:async()=>{throw Error('Must not fetch');}});
 assert.equal(Object.hasOwn(captured,'_meta'),false);
});
test('expired, private destination, duplicate and oversized ICE fail before capture dispatch',async()=>{
 for(const mutate of [
  c=>{c.expiresAt=1;},
  c=>{c.iceServers[0].urls=['turn:localhost:3478?transport=tcp'];},
  c=>{c.iceServers[0].urls=['turn:169.254.169.254:3478?transport=udp'];},
  c=>{c.iceServers[0].urls.push(c.iceServers[0].urls[0]);},
  c=>{c.injected=true;},
 ]){
  const ice=config();mutate(ice);assert.throws(()=>validateDeviceIce(ice));
 }
 let calls=0;
 await assert.rejects(callAgentRuntimeTool({mcp:{callTool:async()=>{calls++;}},
  params:{name:'desktop_webrtc_offer',arguments:{session_id:sid}},
  serverUrl:'https://remcp.site',deviceToken:'fixture',encrypted:true,
  fetchFn:async()=>new Response('x'.repeat(4097))}),/Device TURN configuration unavailable/);
 assert.equal(calls,0);
});

test('native ICE credential fetch refuses arbitrary URL schemes and embedded credentials',async()=>{
 let outbound=0,toolCalls=0;
 for(const serverUrl of [
   'ftp://127.0.0.1:21',
   'file://localhost/tmp/pairing',
   'https://fixture:secret@remcp.site',
   'http://remcp.site',
 ]){
   await assert.rejects(callAgentRuntimeTool({
     mcp:{callTool:async()=>{toolCalls++;return 'should not dispatch';}},
     params:{name:'desktop_webrtc_offer',arguments:{session_id:sid}},
     serverUrl,deviceToken:'fixture-token',
     fetchFn:async()=>{outbound++;return Response.json(config());},
   }));
 }
 assert.equal(outbound,0,'never send Bearer tokens to untrusted schemes or credentials');
 assert.equal(toolCalls,0);
});


test('unavailable TURN endpoint cancels its HTTP error body before rejecting capture',async()=>{
 let cancelled=false,dispatched=0;
 const body=new ReadableStream({
  start(controller){controller.enqueue(new TextEncoder().encode('unavailable'));},
  cancel(){cancelled=true;},
 });
 await assert.rejects(callAgentRuntimeTool({
  mcp:{callTool:async()=>{dispatched++;}},
  params:{name:'desktop_webrtc_offer',arguments:{session_id:sid}},
  serverUrl:'https://remcp.site',deviceToken:'synthetic-test-token',
  fetchFn:async()=>new Response(body,{status:503}),
 }),/Device TURN configuration unavailable/);
 assert.equal(cancelled,true,'the failed HTTP response stream must be cancelled');
 assert.equal(dispatched,0,'no native desktop capture may start on ICE error');
});


test('cancelled desktop ICE preparation never starts capture if transport ignores AbortSignal',async()=>{
 for(const alreadyAborted of [true,false]){
  const controller=new AbortController();
  if(alreadyAborted)controller.abort();
  let fetched=0,dispatched=0;
  await assert.rejects(callAgentRuntimeTool({
   mcp:{callTool:async()=>{dispatched++;return 'should not start';}},
   params:{name:'desktop_webrtc_offer',arguments:{session_id:sid}},
   options:{signal:controller.signal},serverUrl:'https://remcp.site',
   deviceToken:'synthetic-test-token',
   fetchFn:async()=>{
    fetched++;
    if(!alreadyAborted)controller.abort();
    return Response.json(config());
   },
  }),/Device TURN configuration unavailable|Abort/);
  assert.equal(dispatched,0,'stopped desktop session cannot start capture');
  assert.equal(fetched,alreadyAborted?0:1,
   'an already cancelled operation must not contact the TURN service');
 }
});


test('STOP during native ICE body read rejects late valid credentials',async()=>{
 const controller=new AbortController();
 const bytes=new TextEncoder().encode(JSON.stringify(config()));
 let reads=0,dispatched=0;
 const response={ok:true,body:{getReader:()=>({
  read:async()=>{
   if(reads++===0){controller.abort();return {done:false,value:bytes};}
   return {done:true};
  },
  cancel:async()=>{},
 })}};
 await assert.rejects(callAgentRuntimeTool({
  mcp:{callTool:async()=>{dispatched++;}},
  params:{name:'desktop_webrtc_offer',arguments:{session_id:sid}},
  options:{signal:controller.signal},
  serverUrl:'https://remcp.site',deviceToken:'synthetic-test-token',
  fetchFn:async()=>response,
 }),/Device TURN configuration unavailable/);
 assert.equal(reads,2,'read and parse a valid response before detecting late STOP');
 assert.equal(dispatched,0,'the late STOP must block native desktop capture');
});

test('ICE expiry enforces exact maximum TTL and clock skew',()=>{
  const now=1_800_000_000_000;
  const candidate=(ttl,offset)=>{
    const value=config();value.ttlSeconds=ttl;value.expiresAt=now/1000+offset;
    value.iceServers[0].username=value.expiresAt+':'+'a'.repeat(32);return value;
  };
  for(const validate of [validateDeviceIce]){
    for(const ttl of [120,720,900]){
      const max=candidate(ttl,ttl+15);
      assert.deepEqual(validate(max,now),max);
      assert.throws(()=>validate(candidate(ttl,ttl+16),now));
      assert.deepEqual(validate(candidate(ttl,60),now),candidate(ttl,60));
      assert.throws(()=>validate(candidate(ttl,59),now));
    }
    for(const ttl of [119,901,NaN,Infinity])assert.throws(()=>validate(candidate(ttl,120),now));
    for(const expiry of [NaN,Infinity,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1]){
      const value=candidate(900,915);value.expiresAt=expiry;
      assert.throws(()=>validate(value,now));
    }
  }
});


test('recording admission refuses a duration outside the remote deadline before capture',async()=>{
  let dispatched=0;
  const mcp={callTool:async()=>{dispatched++;return 'ok';}};
  const call=(duration,timeout)=>callAgentRuntimeTool({mcp,
    params:{name:'record_screen',arguments:{duration_seconds:duration}},options:{timeout}});
  await assert.rejects(call(120,110000),/maximum 70 seconds/);
  await assert.rejects(call(5,40000),/maximum 0 seconds/);
  assert.equal(dispatched,0);
  assert.equal(await call(70,110000),'ok');
  assert.equal(await call(120,160000),'ok');
  assert.equal(dispatched,2);
});
