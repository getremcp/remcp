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
