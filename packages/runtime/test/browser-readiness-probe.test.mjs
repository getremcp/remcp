import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyBrowserReadiness, probeBrowserReadiness } from '../src/extended/browser-readiness.mjs';
import { extendedToolDefinitions } from '../src/extended/catalog.mjs';

const endpoint='http://127.0.0.1:9222';
const target=(id='safe')=>({
  type:'page',id,
  webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/page/'+id,
  url:'https://private.example.test/secret?token=sensitive',
  title:'private title',
});

test('disabled browser control does not contact any CDP endpoint',async()=>{
  let calls=0;
  const result=await probeBrowserReadiness({
    enabled:false,request:async()=>{calls++;throw Error('should not happen')},cache:false,
  });
  assert.equal(calls,0);
  assert.deepEqual(result,{
    status:'disabled',ready:false,candidate_pages:0,next_step:'use_native_accessibility',
  });
});

test('blocked CDP endpoint is rejected before first request',async()=>{
  let calls=0;
  const result=await probeBrowserReadiness({
    enabled:true,endpoint:'http://example.com:9222',
    request:async()=>{calls++;return {}},cache:false,
  });
  assert.equal(calls,0);
  assert.equal(result.status,'blocked_endpoint');
  assert.equal(result.ready,false);
});

test('CDP is unavailable: safe fallback hint, no endpoint nor error details',async()=>{
  const result=await probeBrowserReadiness({
    enabled:true,endpoint,timeoutMs:250,cache:false,
    request:async()=>{throw Error('fetch failed ECONNREFUSED http://127.0.0.1:9222/secret')},
  });
  assert.deepEqual(result,{
    status:'unavailable',ready:false,candidate_pages:0,next_step:'use_native_accessibility',
  });
  assert.doesNotMatch(JSON.stringify(result),/127\.0\.0\.1|secret/);
});

test('reachable malformed CDP is invalid, not confused with unavailable',async()=>{
  const invalid=await probeBrowserReadiness({
    enabled:true,endpoint,cache:false,request:async()=>({unexpected:'response'}),
  });
  assert.equal(invalid.status,'invalid_response');
  assert.equal(invalid.candidate_pages,0);
  const http=await probeBrowserReadiness({
    enabled:true,endpoint,cache:false,request:async()=>{throw Error('HTTP 403 Forbidden')},
  });
  assert.equal(http.status,'invalid_response');
});

test('CDP with no debuggable pages is distinct from connection refusal',async()=>{
  const calls=[];
  const result=await probeBrowserReadiness({
    enabled:true,endpoint,cache:false,
    request:async(path,passed,opts)=>{
      calls.push({path,passed,timeout:opts.timeout_ms});
      return path==='/json/version'?{Browser:'Chromium/130'}:[{type:'browser'},{type:'page',id:'no-cdp-websocket'}];
    },
  });
  assert.equal(result.status,'no_tabs');
  assert.equal(result.ready,false);
  assert.deepEqual(calls.map(v=>v.path),['/json/version','/json/list']);
  assert.ok(calls.every(v=>v.timeout===350));
});

test('verified loopback target yields ready without returning URLs or titles',async()=>{
  const result=await probeBrowserReadiness({
    enabled:true,endpoint,cache:false,
    request:async path => path==='/json/version'?{Browser:'Chromium/130'}:[
      target('page-1'),target('page-2'),
      { ...target('evil'),webSocketDebuggerUrl:'ws://8.8.8.8:9222/devtools/page/evil' },
      { ...target('wrong'),webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/page/other' },
    ],
  });
  assert.deepEqual(result,{ status:'ready',ready:true,candidate_pages:2,next_step:'use_browser_tabs' });
  assert.doesNotMatch(JSON.stringify(result),/private|title|token|8\.8\.8\.8/);
});

test('no unbounded probing or browser side effects',async()=>{
  const source=readFileSync(new URL('../src/extended/browser-readiness.mjs',import.meta.url),'utf8');
  assert.match(source,/Math\.min\(800/);
  assert.match(source,/targets\.slice\(0, 1000\)/);
  assert.doesNotMatch(source,/spawnDetached|ensureBrowserEndpoint|launchApp|Page\.navigate|\/json\/new/);
});

test('computer_snapshot exposes opt-in readiness without defaulting to probe',async()=>{
  const definition=extendedToolDefinitions.find(t=>t.name==='computer_snapshot');
  assert.equal(definition.inputSchema.properties.browser_readiness?.type,'boolean');
  const source=readFileSync(new URL('../src/extended/desktop-computer-snapshot.mjs',import.meta.url),'utf8');
  assert.match(source,/args\.browser_readiness === true \? probeBrowserReadiness\(\) : Promise\.resolve\(null\)/);
  assert.match(source,/readiness \? readiness\.ready : await browserCapabilityAvailable/);
});

test('real computer snapshot includes opt-in readiness even on a headless, CDP-disabled host', async()=>{
  const { computerSnapshot } = await import('../src/extended/desktop.mjs');
  const envNames=['DISPLAY','WAYLAND_DISPLAY','REMCP_BROWSER_REMOTE_ENABLED'];
  const original=Object.fromEntries(envNames.map(k=>[k,process.env[k]]));
  for(const key of ['DISPLAY','WAYLAND_DISPLAY']) delete process.env[key];
  process.env.REMCP_BROWSER_REMOTE_ENABLED='0';
  try {
    const response=await computerSnapshot({
      include_ui:false,include_browser:false,include_screenshot:false,include_ocr:false,
      browser_readiness:true,
    });
    const snapshot=response.structuredContent;
    assert.equal(snapshot.browser_readiness.status,'disabled');
    assert.equal(snapshot.browser_readiness.ready,false);
    assert.equal(snapshot.browser_readiness.next_step,'use_native_accessibility');
    assert.equal(snapshot.fallback_chain.browser_dom.requested,false);
    assert.equal(snapshot.snapshot_truncated,false);
    assert.doesNotMatch(JSON.stringify(snapshot.browser_readiness),/localhost|https?:\/\//);
    const without=await computerSnapshot({
      include_ui:false,include_browser:false,include_screenshot:false,include_ocr:false,
    });
    assert.equal(Object.hasOwn(without.structuredContent,'browser_readiness'),false);
  } finally {
    for(const key of envNames) {
      if(original[key]===undefined) delete process.env[key];
      else process.env[key]=original[key];
    }
  }
});

test('readiness status is briefly cached per loopback endpoint without cached authorization', async()=>{
  const alternate='http://127.0.0.1:19367';
  let requests=0;
  const request=async path=>{
    requests++;
    return path==='/json/version'?{Browser:'Chromium/130'}:[{
      type:'page',id:'a',webSocketDebuggerUrl:'ws://127.0.0.1:19367/devtools/page/a',
    }];
  };
  const args={enabled:true,endpoint:alternate,request,cache:true};
  const first=await probeBrowserReadiness({...args,now:100});
  assert.equal(first.status,'ready');
  assert.equal(requests,2);
  const cached=await probeBrowserReadiness({...args,now:200});
  assert.equal(cached.cache_hit,true);
  assert.equal(requests,2);
  const refreshed=await probeBrowserReadiness({...args,now:4000});
  assert.equal(refreshed.status,'ready');
  assert.equal(requests,4);
});
