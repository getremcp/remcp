import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { browserTabs, browserSnapshot } from '../src/extended/browser.mjs';

const ENV_KEYS = ['REMCP_BROWSER_BINARY','REMCP_BROWSER_DATA_DIR','REMCP_CDP_URL','REMCP_BROWSER_REMOTE_ENABLED'];
async function withBrowserFixture(run) {
  const original = new Map(ENV_KEYS.map(key => [key,process.env[key]]));
  const fetchBefore = globalThis.fetch;
  const dir = mkdtempSync(join(tmpdir(), 'remcp-browser-readiness-'));
  const marker = join(dir, 'unexpected-launch');
  const executable = join(dir, 'fake-browser');
  // A harmless stand-in prevents these regression tests from ever starting a real browser,
  // including in the red phase before the implementation is fixed.
  writeFileSync(executable, '#!/bin/sh\necho launched > "' + marker + '"\n');
  chmodSync(executable, 0o700);
  process.env.REMCP_BROWSER_BINARY = executable;
  process.env.REMCP_BROWSER_DATA_DIR = join(dir, 'cdp-profile');
  process.env.REMCP_BROWSER_REMOTE_ENABLED = '1';
  delete process.env.REMCP_CDP_URL;
  try { await run({ dir, marker }); }
  finally {
    globalThis.fetch = fetchBefore;
    for (const [key,value] of original) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir,{ recursive:true,force:true });
  }
}

test('read-only browser_tabs never silently starts a separate Chromium when CDP is down', async t => {
  if (process.platform === 'win32') return t.skip('fixture executable uses POSIX sh');
  await withBrowserFixture(async ({marker,dir}) => {
    const seen = [];
    globalThis.fetch = async url => { seen.push(String(url)); throw new TypeError('fetch failed'); };
    const started = Date.now();
    await assert.rejects(() => browserTabs(), error => {
      assert.match(error.message, /CDP endpoint is unavailable|CDP is not listening/i);
      assert.match(error.message, /ui_snapshot/);
      assert.match(error.message, /do not retry/i);
      return true;
    });
    assert.ok(Date.now()-started < 2000, 'one bounded failed discovery must not wait five seconds for a spawned browser');
    assert.deepEqual(seen, ['http://127.0.0.1:9222/json/list'], 'list is checked only once, without a second capability poll');
    assert.equal(existsSync(marker),false,'no browser spawn');
    assert.equal(existsSync(join(dir,'cdp-profile')),false,'no browser profile created');
  });
});

test('configured CDP outage never launches Chromium and indicates it is an explicit endpoint', async t => {
  if (process.platform === 'win32') return t.skip('fixture executable uses POSIX sh');
  await withBrowserFixture(async ({marker}) => {
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(
      () => browserTabs({endpoint:'http://127.0.0.1:19374'}),
      /configured CDP endpoint.*ui_snapshot/i,
    );
    assert.equal(existsSync(marker),false);
  });
});

test('browser_snapshot also never starts a browser as a side effect of reading page semantics', async t => {
  if (process.platform === 'win32') return t.skip('fixture executable uses POSIX sh');
  await withBrowserFixture(async ({marker}) => {
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(() => browserSnapshot(), /ui_snapshot/i);
    assert.equal(existsSync(marker),false);
  });
});

test('connected CDP with no eligible pages explains the empty tabs list without changing the output schema', async () => {
  await withBrowserFixture(async () => {
    globalThis.fetch = async () => new Response('[]', {status:200,headers:{'content-type':'application/json'}});
    const result = await browserTabs({endpoint:'http://127.0.0.1:19374'});
    assert.deepEqual(result.structuredContent, {data:[]});
    assert.match(result.content[0].text,/no debuggable.*tab/i);
    assert.match(result.content[0].text,/ui_snapshot/);
  });
});

test('connected CDP still returns existing page targets with stable typed array data', async () => {
  await withBrowserFixture(async () => {
    globalThis.fetch = async () => new Response(JSON.stringify([
      {id:'tab-1',type:'page',title:'Blank tab',url:'about:blank',
        webSocketDebuggerUrl:'ws://127.0.0.1:19374/devtools/page/tab-1'},
      {id:'worker-1',type:'service_worker',title:'Worker',url:'about:blank',
        webSocketDebuggerUrl:'ws://127.0.0.1:19374/devtools/page/worker-1'},
    ]),{status:200,headers:{'content-type':'application/json'}});
    const result = await browserTabs({endpoint:'http://127.0.0.1:19374'});
    assert.equal(result.structuredContent.data.length,1);
    assert.equal(result.structuredContent.data[0].id,'tab-1');
    assert.equal(result.structuredContent.data[0].title,'Blank tab');
  });
});
