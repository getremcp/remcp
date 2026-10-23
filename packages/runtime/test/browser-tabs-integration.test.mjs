import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.REMCP_BROWSER_REMOTE_ENABLED = '1';
const { browserTabs } = await import('../src/extended/browser-read.mjs');
const { listBrowserTargets } = await import('../src/extended/browser-endpoint.mjs');

function tab(i, url='https://example.test/page/'+i) {
  return {id:String(i),type:'page',title:'Tab '+i,url,
    webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/page/'+i};
}
async function fixture(route) {
  const server=createServer(route);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {
    endpoint:'http://127.0.0.1:'+server.address().port,
    async close(){await new Promise(resolve=>server.close(resolve));},
  };
}

test('browser_tabs reads a large mixed-safe list without leaking blocked same-host entries', async t=>{
  const entries=[
    ...Array.from({length:180},(_,i)=>tab(i)),
    tab(180,'https://username:password@example.test/private'),
    tab(181,'http://127.0.0.1:9000/internal'),
    tab(182,'file:///home/user/secret'),
    tab(183,'about:blank'),
  ];
  const lab=await fixture((req,res)=>{
    assert.equal(req.url,'/json/list');
    res.writeHead(200,{'content-type':'application/json'});
    // Real Chrome serves /json/list and its target sockets from the same CDP port.
    const socketOrigin=`ws://127.0.0.1:${req.socket.localPort}/`;
    res.end(JSON.stringify(entries.map(item=>({...item,
      webSocketDebuggerUrl:item.webSocketDebuggerUrl.replace('ws://127.0.0.1:9222/',socketOrigin)
    }))));
  });
  t.after(()=>lab.close());
  const result=await browserTabs({endpoint:lab.endpoint});
  assert.equal(result.structuredContent.data.length,181);
  assert.deepEqual(result.structuredContent.data.at(-1).url,'about:blank');
  assert.ok(result.structuredContent.data.every(x=>!x.url.includes('password')));
});

test('missing CDP endpoint fails quickly with explicit native GUI fallback, not hidden auto-launch',async t=>{
  const lab=await fixture((req,res)=>res.end('unused'));
  const endpoint=lab.endpoint;
  await lab.close();
  const started=Date.now();
  await assert.rejects(
    listBrowserTargets(endpoint),
    error=>/CDP endpoint/.test(error.message) && /ui_snapshot/.test(error.message) &&
      /do not retry/i.test(error.message),
  );
  assert.ok(Date.now()-started < 3000,'a disabled endpoint must fail fast rather than boot an implicit browser');
});

test('HTTP errors remain distinct from unavailable CDP connection errors',async t=>{
  const lab=await fixture((req,res)=>{res.writeHead(503);res.end('not ready');});
  t.after(()=>lab.close());
  await assert.rejects(listBrowserTargets(lab.endpoint),error=>
    /HTTP 503/.test(error.message) && !/do not retry this CDP endpoint/.test(error.message));
});
