import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCreatedTargetAvailable, BrowserTargetDisappearedError,
  COLD_BROWSER_SETTLE_MS,
  COLD_TARGET_VERIFY_MS,
} from '../src/extended/browser-session.mjs';

const endpoint = new URL('http://127.0.0.1:9222/');

test('cold-start verification checks the exact created page ID after bounded settling', async () => {
  let paused = 0;
  let requests = 0;
  await assertCreatedTargetAvailable('only-owned-target',endpoint,{
    verifyAfterMs:COLD_TARGET_VERIFY_MS,
    pause:async ms=>{paused=ms;},
    request:async (resource, url, opts)=>{
      requests++;
      assert.equal(resource,'/json/list');
      assert.equal(url,endpoint);
      assert.equal(opts.timeout_ms,2000);
      return [
        {id:'unrelated-tab',type:'page',url:'https://untrusted.example/private'},
        {id:'only-owned-target',type:'page',url:'https://example.org/'},
      ];
    },
  });
  assert.equal(requests,1);
  assert.equal(paused,COLD_TARGET_VERIFY_MS);
  assert.ok(COLD_BROWSER_SETTLE_MS>=500 && COLD_BROWSER_SETTLE_MS<=2500);
  assert.ok(COLD_TARGET_VERIFY_MS>=300 && COLD_TARGET_VERIFY_MS<=1500);
});

test('warm browser targets do not incur any startup wait', async()=>{
  let waited=false;
  await assertCreatedTargetAvailable('current',endpoint,{
    pause:()=>{waited=true;throw new Error('Unnecessary wait');},
    request:async()=>[{id:'current',type:'page'}],
  });
  assert.equal(waited,false);
});

test('disappeared target fails instead of claiming a successful navigation',async()=>{
  await assert.rejects(
    assertCreatedTargetAvailable('closed',endpoint,{
      request:async()=>[{id:'another-tab',type:'page'}],
    }),
    err => err instanceof BrowserTargetDisappearedError && err.code === 'BROWSER_TARGET_DISAPPEARED' && err.retryable === true,
  );
  for(const response of [null,{id:'closed'},[],[{id:'closed',type:'service_worker'}]]){
    await assert.rejects(assertCreatedTargetAvailable('closed',endpoint,{
      request:async()=>response,
    }),/target disappeared during startup/i);
  }
});

test('CDP discovery failures are never silently treated as successful navigation',async()=>{
  const expected = new Error('CDP disconnected');
  await assert.rejects(
    assertCreatedTargetAvailable('lost',endpoint,{request:async()=>{throw expected;}}),
    error=>error===expected,
  );
});

test('guard never trusts the page title, URL, or same-origin impostor in place of exact target',async()=>{
  const impostor={id:'changed',type:'page',url:'https://example.org/',title:'safe'};
  await assert.rejects(
    assertCreatedTargetAvailable('original',endpoint,{request:async()=>[impostor]}),
    /target disappeared during startup/,
  );
});
