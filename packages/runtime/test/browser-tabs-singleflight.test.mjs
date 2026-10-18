import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.REMCP_BROWSER_REMOTE_ENABLED = '1';
const { browserTabs } = await import('../src/extended/browser-read.mjs');
const { listBrowserTargets } = await import('../src/extended/browser-endpoint.mjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function fixture(handler) {
  const server=createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint='http://127.0.0.1:'+server.address().port;
  return {endpoint,async close(){await new Promise(resolve=>server.close(resolve));}};
}
const tab = (endpoint,id='1') => ({
  type:'page',id,title:'local fixture',url:'about:blank',
  webSocketDebuggerUrl:'ws://127.0.0.1:'+new URL(endpoint).port+'/devtools/page/'+id,
});

test('concurrent browser_tabs use one CDP discovery but retain individual result objects',async t=>{
  let hits=0;
  let url='';
  const lab=await fixture(async(req,res)=>{
    hits++;
    assert.equal(req.url,'/json/list');
    await sleep(65);
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify([tab(url)]));
  });
  url=lab.endpoint;t.after(()=>lab.close());
  const answers=await Promise.all(Array.from({length:8},()=>browserTabs({endpoint:lab.endpoint})));
  assert.equal(hits,1,'eight overlapping read-only calls share one bounded HTTP request');
  assert.equal(answers.length,8);
  for(const answer of answers) assert.equal(answer.structuredContent.data[0].id,'1');
  assert.notEqual(answers[0],answers[1],'each caller receives its own output');
  const later=await browserTabs({endpoint:lab.endpoint});
  assert.equal(later.structuredContent.data.length,1);
  assert.equal(hits,2,'no response cache survives after the request completes');
});

test('separate read-only consumers always validate tab URL independently',async t=>{
  let hits=0;
  let endpoint='';
  const lab=await fixture(async(req,res)=>{
    hits++;
    await sleep(65);
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify([tab(endpoint)]));
  });
  endpoint=lab.endpoint;t.after(()=>lab.close());
  let validations=0;
  const good=()=>listBrowserTargets(endpoint,{
    readOnlySingleFlight:true,validate:async url=>{ validations++;assert.equal(url,'about:blank'); },
  });
  const denied=()=>listBrowserTargets(endpoint,{
    readOnlySingleFlight:true,validate:async url=>{ validations++;assert.equal(url,'about:blank');throw new Error('blocked by caller policy'); },
  });
  const [allowed,blocked]=await Promise.all([good(),denied()]);
  assert.equal(hits,1);
  assert.equal(validations,2,'only raw CDP I/O was coalesced, not safety validations');
  assert.equal(allowed.length,1);
  assert.deepEqual(blocked,[]);
});

test('read-only coalescing is opt-in; normal target selection always fetches independently',async t=>{
  let hits=0;
  let endpoint='';
  const lab=await fixture(async(req,res)=>{
    hits++;
    await sleep(30);
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify([tab(endpoint)]));
  });
  endpoint=lab.endpoint;t.after(()=>lab.close());
  const result=await Promise.all([
    listBrowserTargets(endpoint),
    listBrowserTargets(endpoint),
  ]);
  assert.equal(hits,2,'mutating target resolution never shares tab discovery');
  assert.equal(result[0].length,1);
});

test('failed read-only CDP discovery is shared only until settlement and is never cached',async t=>{
  let hits=0;
  const lab=await fixture(async(req,res)=>{
    hits++;await sleep(55);res.writeHead(503);res.end('not ready');
  });
  t.after(()=>lab.close());
  const outcomes=await Promise.allSettled(Array.from({length:5},()=>browserTabs({endpoint:lab.endpoint})));
  assert.equal(hits,1);
  for(const result of outcomes) {
    assert.equal(result.status,'rejected');
    assert.match(result.reason.message,/HTTP 503/);
    assert.doesNotMatch(result.reason.message,/do not retry this CDP endpoint/);
  }
  await assert.rejects(browserTabs({endpoint:lab.endpoint}),/HTTP 503/);
  assert.equal(hits,2);
});
