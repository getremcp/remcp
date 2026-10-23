import test from 'node:test';
import assert from 'node:assert/strict';

process.env.REMCP_BROWSER_REMOTE_ENABLED='1';
const {browserTabs}=await import('../src/extended/browser-read.mjs');
const {listBrowserTargets,validatedTargetWebSocketUrl}=await import('../src/extended/browser-endpoint.mjs');

const ENDPOINT='http://127.0.0.1:19374';
const tab=(id,socket)=>({
  id,type:'page',title:'test tab',url:'about:blank',
  webSocketDebuggerUrl:socket||`ws://127.0.0.1:19374/devtools/page/${id}`,
});
function withTargets(t,targets){
  const previous=globalThis.fetch;
  t.after(()=>{globalThis.fetch=previous;});
  globalThis.fetch=async(url)=>{
    assert.equal(new URL(url).pathname,'/json/list');
    return new Response(JSON.stringify(targets),{status:200,headers:{'content-type':'application/json'}});
  };
}
test('browser_tabs drops CDP targets with mismatched socket origin, path or credentials',async t=>{
  withTargets(t,[
    tab('good'),
    tab('wrongport','ws://127.0.0.1:1/devtools/page/wrongport'),
    tab('internal','ws://169.254.169.254:9222/devtools/page/internal'),
    tab('wrongpath','ws://127.0.0.1:19374/devtools/page/other'),
    tab('credential','ws://user:pass@127.0.0.1:19374/devtools/page/credential'),
    tab('query','ws://127.0.0.1:19374/devtools/page/query?token=secret'),
    {id:'',type:'page',url:'about:blank',webSocketDebuggerUrl:'ws://127.0.0.1:19374/devtools/page/'},
  ]);
  const result=await browserTabs({endpoint:ENDPOINT});
  assert.deepEqual(result.structuredContent.data.map(x=>x.id),['good']);
});
test('only poisoned socket targets produce truthful empty-tab/native-UI fallback',async t=>{
  withTargets(t,[tab('wrong','ws://localhost:1/devtools/page/wrong')]);
  const result=await browserTabs({endpoint:ENDPOINT});
  assert.deepEqual(result.structuredContent.data,[]);
  assert.match(result.content[0].text,/ui_snapshot/i);
  assert.deepEqual(await listBrowserTargets(ENDPOINT),[]);
});
test('WebSocket target validator denies query, fragments, credentials and empty IDs',()=>{
  const endpoint=new URL(ENDPOINT);
  const valid={id:'valid',webSocketDebuggerUrl:'ws://127.0.0.1:19374/devtools/page/valid'};
  assert.match(validatedTargetWebSocketUrl(valid,endpoint),/\/devtools\/page\/valid$/);
  for(const invalid of [
    {id:'valid',webSocketDebuggerUrl:'ws://u:p@127.0.0.1:19374/devtools/page/valid'},
    {id:'valid',webSocketDebuggerUrl:'ws://127.0.0.1:19374/devtools/page/valid?session=secret'},
    {id:'valid',webSocketDebuggerUrl:'ws://127.0.0.1:19374/devtools/page/valid#secret'},
    {id:'',webSocketDebuggerUrl:'ws://127.0.0.1:19374/devtools/page/'},
  ]) assert.throws(()=>validatedTargetWebSocketUrl(invalid,endpoint),/CDP WebSocket|invalid/i);
});
