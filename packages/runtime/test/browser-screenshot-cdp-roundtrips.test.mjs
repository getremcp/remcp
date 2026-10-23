import test from 'node:test';
import assert from 'node:assert/strict';
import {captureViewportScreenshot} from '../src/extended/browser-read.mjs';

test('capture starts before viewport resolution and uses exactly one CDP evaluation',async()=>{
  const calls=[];
  let finishViewport;
  const session={send(method,options){
    calls.push(method);
    if(method==='Runtime.evaluate'){
      assert.equal(options.expression,'({width:innerWidth,height:innerHeight})');
      return new Promise(resolve=>{finishViewport=resolve;});
    }
    assert.equal(method,'Page.captureScreenshot');
    assert.deepEqual(options,{format:'png',fromSurface:true,captureBeyondViewport:false});
    return Promise.resolve({data:'aW1hZ2U='});
  }};
  const work=captureViewportScreenshot(session);
  assert.deepEqual(calls,['Runtime.evaluate','Page.captureScreenshot']);
  finishViewport({result:{value:{width:390,height:844}}});
  assert.deepEqual(await work,{captured:{data:'aW1hZ2U='},
    viewport:{scope:'viewport',width:390,height:844}});
});
test('selector screenshot reuses measured element viewport with no extra evaluate',async()=>{
  const calls=[];
  const session={send:async method=>{
    calls.push(method);
    assert.equal(method,'Page.captureScreenshot');
    return {data:'image'};
  }};
  const result=await captureViewportScreenshot(session,{viewport_width:1280,viewport_height:720});
  assert.deepEqual(calls,['Page.captureScreenshot']);
  assert.equal(result.viewport.width,1280);
  assert.equal(result.viewport.height,720);
});
test('unavailable viewport dimensions never suppress a valid screenshot',async()=>{
  const session={send:async method=>{
    if(method==='Runtime.evaluate')throw Error('detached frame');
    return {data:'image'};
  }};
  const result=await captureViewportScreenshot(session);
  assert.deepEqual(result.viewport,{scope:'viewport',width:null,height:null});
  assert.equal(result.captured.data,'image');
});
test('screenshot failure propagates rather than returning a partial image',async()=>{
  const session={send:async method=>{
    if(method==='Runtime.evaluate')return {result:{value:{width:100,height:100}}};
    throw Error('capture failed');
  }};
  await assert.rejects(()=>captureViewportScreenshot(session),/capture failed/);
});

test('Accessibility.enable is single-flight and reused only by the same live socket',async()=>{
  const {ensureAccessibilityReady}=await import('../src/extended/browser-read.mjs');
  let calls=0;
  let allow;
  const socket={send:method=>{
    assert.equal(method,'Accessibility.enable');
    calls++;
    return new Promise(resolve=>{allow=resolve;});
  }};
  const first=ensureAccessibilityReady(socket);
  const second=ensureAccessibilityReady(socket);
  await Promise.resolve();
  assert.equal(calls,1,'concurrent readers share the same enable handshake');
  allow({});
  await Promise.all([first,second]);
  await ensureAccessibilityReady(socket);
  assert.equal(calls,1,'subsequent snapshots do not repeat enable on retained socket');
  const replacement={send:async method=>{assert.equal(method,'Accessibility.enable');calls++;return {};}};
  await ensureAccessibilityReady(replacement);
  assert.equal(calls,2,'new sockets must enable independently');
});
test('failed Accessibility.enable is never cached across retries',async()=>{
  const {ensureAccessibilityReady}=await import('../src/extended/browser-read.mjs');
  let attempts=0;
  const socket={send:async()=>{
    attempts++;
    if(attempts===1)throw Error('CDP failed');
    return {};
  }};
  await assert.rejects(()=>ensureAccessibilityReady(socket),/CDP failed/);
  await ensureAccessibilityReady(socket);
  assert.equal(attempts,2);
});
