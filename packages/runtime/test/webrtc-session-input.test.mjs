import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebRtcSessionControl} from '../src/extended/desktop-webrtc-control.mjs';
const sid='aaaaaaaa-1111-4111-8111-111111111111';
const result=data=>({content:[{type:'text',text:JSON.stringify(data)}]});
function fixture(overrides={}){
  let state={sessionId:sid,epoch:'first',active:true,inputEnabled:true,stopping:false},calls=[];
  const handlers={display_inventory:async()=>result([{primary:true,x:-100,y:20,width:800,height:600}]),
    pointer:async args=>{calls.push(args);return result({ok:true});},
    type_text:async args=>{calls.push(args);return result({ok:true});},...overrides};
  const control=createWebRtcSessionControl({state:()=>state,handlers});
  return {control,calls,set:patch=>{state={...state,...patch};}};
}
test('input requires explicit live session consent and rejects other sessions and sequence replay',async()=>{
  const f=fixture();
  await assert.rejects(f.control({session_id:'other-session',input:{seq:1,kind:'text',text:'private'}}));
  f.set({inputEnabled:false});
  await assert.rejects(f.control({session_id:sid,input:{seq:1,kind:'text',text:'private'}}));
  f.set({inputEnabled:true});
  await f.control({session_id:sid,input:{seq:1,kind:'text',text:'Привет'}});
  await assert.rejects(f.control({session_id:sid,input:{seq:1,kind:'text',text:'duplicate'}}),/sequence replay/);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].text,'Привет');
});
test('normalized pointer uses the current native primary display, including negative origin',async()=>{
  const f=fixture();await f.control({session_id:sid,input:{seq:1,kind:'pointer',op:'click',button:'left',x:1,y:0}});
  assert.deepEqual(f.calls,[{action:'click',x:699,y:20,button:'left'}]);
});
test('Stop while display discovery waits prevents the input and drains its ownership fence',async()=>{
  let ready,discovered;
  const started=new Promise(resolve=>{discovered=resolve;});
  const pending=new Promise(resolve=>{ready=resolve;});
  const f=fixture({display_inventory:async()=>{discovered();await pending;return result([{primary:true,x:0,y:0,width:800,height:600}]);}});
  const call=f.control({session_id:sid,input:{seq:1,kind:'pointer',op:'move',x:0,y:0}});
  await started;f.set({stopping:true});assert.equal(f.control.pending,1);
  ready();await assert.rejects(call,/session ended/);await f.control.drain();
  assert.equal(f.control.pending,0);assert.equal(f.calls.length,0);
});
test('queued actions cannot run after capture expiry or Stop, and unknown payloads cannot select tools',async()=>{
  const f=fixture();f.set({active:false});
  await assert.rejects(f.control({session_id:sid,input:{seq:1,kind:'text',text:'blocked'}}));
  f.set({active:true});
  await assert.rejects(f.control({session_id:sid,input:{seq:2,kind:'text',text:'blocked',tool:'start_process'}}));
  assert.equal(f.calls.length,0);
});

test('native clipboard text stays literal, preserves CRLF and rejects oversize without content in errors',async()=>{
  const original='{"literal":"clipboard"}\r\nПривет';
  const f=fixture({clipboard:async()=>({content:[{type:'text',text:original}]})});
  const reply=await f.control({session_id:sid,input:{seq:1,kind:'clipboard',op:'read'}});
  assert.equal(JSON.parse(reply.content[0].text).text,original);
  const g=fixture({clipboard:async()=>({content:[{type:'text',text:'private-'.repeat(700)}]})});
  await assert.rejects(g.control({session_id:sid,input:{seq:1,kind:'clipboard',op:'read'}}),error=>
    error.message.includes('4 KiB')&&!error.message.includes('private-'));
});
