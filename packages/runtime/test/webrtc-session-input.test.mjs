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

test('native clipboard preserves literal CRLF, enforces 64 KiB UTF-8 and never leaks oversized content',async()=>{
  const original='{"literal":"clipboard"}\r\nПривет';
  const f=fixture({clipboard:async()=>({content:[{type:'text',text:original}]})});
  const reply=await f.control({session_id:sid,input:{seq:1,kind:'clipboard',op:'read'}});
  assert.equal(JSON.parse(reply.content[0].text).text,original);
  for(const [value,allowed] of [
    ['private-'.repeat(700),true],
    ['x'.repeat(65_536),true],
    ['x'.repeat(65_537),false],
    ['ж'.repeat(32_768),true],
    ['ж'.repeat(32_769),false],
  ]){
    const g=fixture({clipboard:async()=>({content:[{type:'text',text:value}]})});
    const input={session_id:sid,input:{seq:1,kind:'clipboard',op:'read'}};
    if(allowed){
      const accepted=await g.control(input);
      assert.equal(JSON.parse(accepted.content[0].text).text,value);
    }else{
      await assert.rejects(g.control(input),error=>
        error.message.includes('64 KiB')&&!error.message.includes(value.slice(0,12)));
    }
  }
});

test('Stop during an in-flight native input never acknowledges stale success',async()=>{
  let unblock,entered;
  const hold=new Promise(resolve=>{unblock=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  let dispatched=0;
  const f=fixture({type_text:async()=>{
    dispatched++;entered();await hold;return result({ok:true});
  }});
  const call=f.control({session_id:sid,input:{seq:1,kind:'text',text:'synthetic'}});
  try{
    await started;
    f.set({stopping:true});
    unblock();
    await assert.rejects(call,/WebRTC input session ended/);
    await f.control.drain();
    assert.equal(dispatched,1,'the already dispatched side effect cannot be undone');
    assert.equal(f.control.pending,0);
  }finally{unblock();}
});

for(const [name,revoke] of [
  ['input permission revoked',(f)=>f.set({inputEnabled:false})],
  ['capture epoch replaced',(f)=>f.set({epoch:'replacement'})],
  ['RPC signal aborted',(_f,controller)=>controller.abort()],
]){
  test('in-flight native input refuses stale acknowledgement when '+name,async()=>{
    let unblock,entered;
    const hold=new Promise(resolve=>{unblock=resolve;});
    const started=new Promise(resolve=>{entered=resolve;});
    const f=fixture({type_text:async()=>{entered();await hold;return result({ok:true});}});
    const controller=new AbortController();
    const call=f.control({session_id:sid,input:{seq:1,kind:'text',text:'synthetic'}},
      {signal:controller.signal});
    try{
      await started;
      revoke(f,controller);
      unblock();
      await assert.rejects(call,/WebRTC input session ended/);
      await f.control.drain();
      assert.equal(f.control.pending,0);
    }finally{unblock();}
  });
}

test('pending native clipboard read never releases clipboard bytes after Stop',async()=>{
  const syntheticClipboard='synthetic-private-clipboard-payload-not-user-data';
  let entered,unblock;
  const started=new Promise(resolve=>{entered=resolve;});
  const blocked=new Promise(resolve=>{unblock=resolve;});
  const f=fixture({clipboard:async()=>{
    entered();await blocked;
    return {content:[{type:'text',text:syntheticClipboard}]};
  }});
  const pending=f.control({session_id:sid,input:{seq:1,kind:'clipboard',op:'read'}});
  try{
    await started;
    f.set({stopping:true});
    unblock();
    await assert.rejects(pending,error=>
      /WebRTC input session ended/.test(error.message)&&
      !error.message.includes(syntheticClipboard));
    await f.control.drain();
    assert.equal(f.control.pending,0);
  }finally{unblock();}
});

test('queued input is bound to the capture epoch at submission, even if session id is reused',async()=>{
  let unblock,entered;
  const hold=new Promise(resolve=>{unblock=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  const dispatched=[];
  const f=fixture({type_text:async args=>{
    dispatched.push(args.text);
    if(args.text==='first'){entered();await hold;}
    return result({ok:true});
  }});
  const first=f.control({session_id:sid,input:{seq:1,kind:'text',text:'first'}});
  const firstRejected=assert.rejects(first,/session ended/);
  await started;
  const queued=f.control({session_id:sid,input:{seq:2,kind:'text',text:'old queued'}});
  const queuedRejected=assert.rejects(queued,/session unavailable|session ended/);
  f.set({epoch:'replacement'});
  unblock();
  await firstRejected;
  await queuedRejected;
  await f.control({session_id:sid,input:{seq:1,kind:'text',text:'new session'}});
  assert.deepEqual(dispatched,['first','new session']);
  assert.equal(f.control.pending,0);
});

test('input submitted without consent cannot become valid while waiting in the queue',async()=>{
  const f=fixture();
  f.set({inputEnabled:false});
  const call=f.control({session_id:sid,input:{seq:1,kind:'text',text:'not consented'}});
  f.set({inputEnabled:true});
  await assert.rejects(call,/session unavailable|session ended/);
  assert.equal(f.calls.length,0);
});

// The Windows fast path must retain the existing capture and sequence fence.
test('fast input is session-bound, never falls back, and retirement blocks reuse until worker close',async()=>{
 let active={sessionId:sid,epoch:'fast',active:true,inputEnabled:true,stopping:false};
 let release,closed=0,dispatched=0,fallback=0;
 const closedGate=new Promise(resolve=>{release=resolve;});
 const fastInput={supports:input=>input.kind==='pointer',
   async dispatch(input){dispatched++;if(input.seq===2)throw Error('uncertain native input');},
   async close(){closed++;await closedGate;}};
 const control=createWebRtcSessionControl({state:()=>active,fastInput,handlers:{
   pointer:async()=>{fallback++;return result({ok:true});},
   display_inventory:async()=>{fallback++;return result([{primary:true,x:0,y:0,width:800,height:600}]);},
 }});
 const move=seq=>({session_id:sid,input:{seq,kind:'pointer',op:'move',x:0.5,y:0.5}});
 await control(move(1));
 await assert.rejects(control(move(2)),/uncertain native input/);
 await assert.rejects(control(move(2)),/sequence replay/);
 assert.equal(dispatched,2);assert.equal(fallback,0);
 active={...active,active:false,stopping:true};
 const retired=control.retire();
 await Promise.resolve();
 assert.equal(control.pending,1);
 await assert.rejects(control(move(3)),/session unavailable/);
 release();await retired;
 assert.equal(closed,1);assert.equal(control.pending,0);
});

test('fast input prewarming requires active, explicitly input-enabled capture',async()=>{
 let value={sessionId:sid,epoch:'warm',active:false,inputEnabled:false,stopping:false};
 let prepared=0;
 const fastInput={supports:()=>false,prepare(){prepared++;},async close(){}};
 const control=createWebRtcSessionControl({state:()=>value,fastInput,handlers:{}});
 control.prepare();
 value={...value,active:true};control.prepare();
 value={...value,inputEnabled:true};control.prepare();
 assert.equal(prepared,1);
 value={...value,stopping:true};control.prepare();
 assert.equal(prepared,1);
 await control.retire();
});

test('agent drops delayed actions across platforms and consumes expired sequence',async()=>{
 let time=0,release,entered;
 const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
 const calls=[];
 const state={sessionId:sid,epoch:'fresh',active:true,inputEnabled:true,stopping:false};
 const control=createWebRtcSessionControl({state:()=>state,now:()=>time,handlers:{
  type_text:async args=>{calls.push(args.text);if(args.text==='first'){entered();await gate;}return result({ok:true});}
 }});
 const first=control({session_id:sid,input:{seq:1,kind:'text',text:'first'}});
 await started;
 const stale=control({session_id:sid,input:{seq:2,kind:'text',text:'stale'}});
 time=2501;release();await first;
 await assert.rejects(stale,/expired before native dispatch/);
 await assert.rejects(control({session_id:sid,input:{seq:2,kind:'text',text:'replay'}}),/sequence replay/);
 await control({session_id:sid,input:{seq:3,kind:'text',text:'fresh'}});
 assert.deepEqual(calls,['first','fresh']);
});

test('agent drops pointer after slow display discovery',async()=>{
 let time=0,dispatched=0;
 const state={sessionId:sid,epoch:'fresh',active:true,inputEnabled:true,stopping:false};
 const control=createWebRtcSessionControl({state:()=>state,now:()=>time,handlers:{
  display_inventory:async()=>{time=351;return result([{primary:true,x:0,y:0,width:800,height:600}]);},
  pointer:async()=>{dispatched++;return result({ok:true});}
 }});
 await assert.rejects(control({session_id:sid,input:{seq:1,kind:'pointer',op:'move',x:.5,y:.5}}),/expired before native dispatch/);
 assert.equal(dispatched,0);
 await control({session_id:sid,input:{seq:2,kind:'pointer',op:'click',button:'left',x:.5,y:.5}});
 assert.equal(dispatched,1);
});

test('agent limits pending operations before they enter the native queue',async()=>{
 let release,entered;
 const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
 const f=fixture({type_text:async()=>{entered();await gate;return result({ok:true});}});
 const call=seq=>f.control({session_id:sid,input:{seq,kind:'text',text:'test'}});
 const first=call(1);await started;
 const rest=Array.from({length:15},(_,i)=>call(i+2));
 await assert.rejects(call(17),/queue full/);
 assert.equal(f.control.pending,16);
 release();await Promise.all([first,...rest]);assert.equal(f.control.pending,0);
});
