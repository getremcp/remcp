import test from 'node:test';
import assert from 'node:assert/strict';
import { filterBrowserTargets } from '../src/extended/browser.mjs';

const tab = (id, url = `https://example.test/${id}`) => ({ id: String(id), type: 'page', url, title: `Tab ${id}`, webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}` });

test('browser discovery validates multiple page URLs concurrently without reordering results', async () => {
  const input = Array.from({ length: 24 }, (_, i) => tab(i));
  let active = 0;
  let peak = 0;
  const filtered = await filterBrowserTargets(input, {
    validate: async (url) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 4));
      active--;
      if (url.endsWith('/3') || url.endsWith('/19')) throw new Error('blocked destination');
    },
  });
  assert.ok(peak > 1, 'avoid serial DNS validation of every open tab');
  assert.ok(peak <= 8, 'bound concurrent DNS validation work');
  assert.deepEqual(filtered.map(item => item.id), input.filter((_, i) => i !== 3 && i !== 19).map(item => item.id));
});

test('browser discovery rejects invalid entries before URL validation and caps processing', async () => {
  const input = [null, { id: 'bad', type: 'service_worker', webSocketDebuggerUrl: 'ws://x' }, tab('safe'), ...Array.from({ length: 1200 }, (_, i) => tab(i + 1))];
  let validated = 0;
  const result = await filterBrowserTargets(input, { validate: async () => { validated++; } });
  assert.ok(result.length <= 500, 'bound the output size');
  assert.ok(validated <= 1000, 'do not DNS-resolve an unbounded number of tabs');
  assert.equal(result[0].id, 'safe');
});

test('browser discovery preserves the built-in private-address and unsafe-scheme protection', async () => {
  const result = await filterBrowserTargets([
    tab('https', 'https://example.test/'),
    tab('blank', 'about:blank'),
    tab('file', 'file:///etc/passwd'),
    tab('loopback', 'http://127.0.0.1:8000/'),
    tab('credentials', 'https://username:password@example.test/'),
  ]);
  assert.deepEqual(result.map(item => item.id), ['https', 'blank']);
});


test('shared-host tab discovery still enforces per-URL scheme and credentials checks', async () => {
  const pages = [
    tab('safe0','https://example.test/doc1'),
    tab('userinfo','https://username:password@example.test/doc2'),
    tab('safe1','https://example.test/doc3'),
    tab('unsafe-scheme','file:///tmp/private'),
    tab('loopback','http://127.0.0.1:3000/private'),
    tab('safe2','https://example.test/doc4'),
    tab('blank','about:blank'),
  ];
  const result = await filterBrowserTargets(pages);
  assert.deepEqual(result.map(page => page.id),['safe0','safe1','safe2','blank']);
});

test('custom URL-specific filters do not silently cache by shared hostname', async () => {
  const pages = Array.from({ length:40 }, (_,i)=>tab('id'+i,'https://example.test/' + i));
  let invoked=0;
  const result=await filterBrowserTargets(pages,{validate:async url=>{
    invoked++;
    if(url.endsWith('/9'))throw Error('blocked path');
  }});
  assert.equal(invoked,40,'URL-specific security policies must run on every page');
  assert.equal(result.length,39);
  assert.ok(!result.some(page=>page.url.endsWith('/9')));
});
