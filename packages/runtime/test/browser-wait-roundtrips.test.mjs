import test from 'node:test';
import assert from 'node:assert/strict';
import { browserWait } from '../src/extended/browser-actions.mjs';
import { productionBrowserSessions } from '../src/extended/browser-endpoint.mjs';

function cachedTarget(t, handler) {
  const oldEnv=process.env.NODE_ENV;
  const oldAllowed=process.env.REMCP_BROWSER_ALLOWED_HOSTS;
  process.env.NODE_ENV='production';
  process.env.REMCP_BROWSER_ALLOWED_HOSTS='93.184.215.14';
  const port=19481;
  const endpoint='http://127.0.0.1:'+port;
  const id='wait-fixture';
  const target={
    id,url:'https://93.184.215.14/old',
    webSocketDebuggerUrl:'ws://127.0.0.1:'+port+'/devtools/page/'+id,
  };
  const expressions=[];
  let closed=false;
  const session={
    url:target.webSocketDebuggerUrl,closed:false,socket:{readyState:1},
    async send(method,payload={}){
      if(method==='Runtime.evaluate'){
        expressions.push(payload.expression);
        return {result:{value:await handler(payload.expression)}};
      }
      if(method==='Network.enable')return {};
      throw Error('unexpected CDP command '+method);
    },
    observe(){return ()=>{};},
    close(){closed=true;this.closed=true;},
  };
  const key=endpoint+'|'+id;
  productionBrowserSessions.set(key,{
    target,targetId:id,session,guardInstalled:true,removeGuard(){},schedule(){},
  });
  t.after(()=>{
    if(oldEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldEnv;
    if(oldAllowed===undefined)delete process.env.REMCP_BROWSER_ALLOWED_HOSTS;
    else process.env.REMCP_BROWSER_ALLOWED_HOSTS=oldAllowed;
    productionBrowserSessions.clear();
  });
  return {endpoint,id,expressions,session,get closed(){return closed;}};
}

test('immediate selector match uses just one condition CDP read between two URL security reads',async t=>{
  const url='https://93.184.215.14/ready';
  const fixture=cachedTarget(t,expression=>{
    if(expression==='location.href')return url;
    assert.ok(expression.startsWith('({url:location.href,matched:Boolean('));
    assert.match(expression,/document.querySelector/);
    return {url,matched:true};
  });
  const result=await browserWait({
    endpoint:fixture.endpoint,target_id:fixture.id,
    condition:'selector',selector:'#ready',timeout_ms:300,poll_ms:50,
  });
  assert.equal(result.structuredContent.matched,true);
  assert.equal(result.structuredContent.url,url);
  assert.equal(fixture.expressions.length,3,
    'outer withTarget checks URL twice, wait condition once; no redundant URL reads');
  assert.equal(fixture.expressions.filter(x=>x==='location.href').length,2);
  assert.equal(fixture.closed,false);
});

test('navigation wait starts at freshly verified live URL, not stale discovered metadata',async t=>{
  const current='https://93.184.215.14/current';
  const next='https://93.184.215.14/next';
  let calls=0;
  const fixture=cachedTarget(t,expression=>{
    if(expression==='location.href')return calls>1?next:current;
    assert.ok(expression.includes(JSON.stringify(current)));
    calls++;
    return {url:calls>1?next:current,matched:calls>1};
  });
  const result=await browserWait({
    endpoint:fixture.endpoint,target_id:fixture.id,
    condition:'navigation',timeout_ms:350,poll_ms:50,
  });
  assert.equal(result.structuredContent.matched,true);
  assert.equal(result.structuredContent.url,next);
  assert.equal(calls,2,'stale metadata must not signal navigation immediately');
  assert.equal(fixture.expressions.filter(x=>x==='location.href').length,2);
});

test('network idle returns the observed URL without a third URL-only read',async t=>{
  const current='https://93.184.215.14/idle';
  let probes=0;
  const fixture=cachedTarget(t,expression=>{
    if(expression==='location.href')return current;
    probes++;
    assert.ok(expression.includes('performance.getEntriesByType'));
    return {url:current,ready:'complete',resources:0};
  });
  const result=await browserWait({
    endpoint:fixture.endpoint,target_id:fixture.id,
    condition:'network_idle',timeout_ms:700,poll_ms:50,idle_ms:100,
  });
  assert.equal(result.structuredContent.matched,true);
  assert.equal(result.structuredContent.url,current);
  assert.equal(result.structuredContent.inflight,0);
  assert.ok(probes>=2);
  assert.equal(fixture.expressions.filter(x=>x==='location.href').length,2);
});

test('blocked final navigation suppresses a matched condition result',async t=>{
  let url='https://93.184.215.14/safe';
  let probes=0;
  const fixture=cachedTarget(t,expression=>{
    if(expression==='location.href')return url;
    probes++;
    url='http://127.0.0.1/private';
    return {url,matched:true};
  });
  await assert.rejects(
    browserWait({
      endpoint:fixture.endpoint,target_id:fixture.id,
      condition:'selector',selector:'#ready',timeout_ms:300,poll_ms:50,
    }),
    /loopback|private|not in REMCP_BROWSER_ALLOWED_HOSTS/i,
  );
  assert.equal(probes,1);
  assert.equal(fixture.closed,true,'a poisoned cached target must be closed');
});

test('text and URL conditions use the same one-read condition-and-URL contract',async t=>{
  const current='https://93.184.215.14/confirmed';
  const tested=[];
  const fixture=cachedTarget(t,expression=>{
    if(expression==='location.href')return current;
    tested.push(expression);
    return {url:current,matched:true};
  });
  for(const [condition,valueKey,value] of [
    ['text','text','Ready'],
    ['url_contains','value','confirmed'],
    ['load',null,null],
  ]){
    const response=await browserWait({
      endpoint:fixture.endpoint,target_id:fixture.id,condition,
      ...(valueKey?{[valueKey]:value}:{}),timeout_ms:300,poll_ms:50,
    });
    assert.equal(response.structuredContent.matched,true);
    assert.equal(response.structuredContent.url,current);
  }
  assert.equal(tested.length,3);
  assert.equal(fixture.expressions.filter(x=>x==='location.href').length,6,
    'each operation retains only the two live URL security checks');
});

test('timeout preserves the final observed URL and keeps the response bounded',async t=>{
  const current='https://93.184.215.14/not-yet';
  let probes=0;
  const fixture=cachedTarget(t,expression=>{
    if(expression==='location.href')return current;
    probes++;
    return {url:current,matched:false};
  });
  const response=await browserWait({
    endpoint:fixture.endpoint,target_id:fixture.id,condition:'selector',
    selector:'#missing',timeout_ms:115,poll_ms:50,
  });
  assert.equal(response.structuredContent.matched,false);
  assert.equal(response.structuredContent.url,current);
  assert.ok(probes>=1 && probes<=4);
  assert.equal(fixture.expressions.filter(x=>x==='location.href').length,2);
});
