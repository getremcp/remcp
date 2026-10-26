import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.REMCP_BROWSER_REMOTE_ENABLED = '1';
const { browserTabs } = await import('../src/extended/browser-read.mjs');
const { filterBrowserTargets } = await import('../src/extended/browser-endpoint.mjs');

async function mockCdp(t, targets) {
  const server = createServer((req, res) => {
    assert.equal(req.url, '/json/list');
    const origin = 'ws://127.0.0.1:' + req.socket.localPort;
    res.writeHead(200, { 'content-type':'application/json' });
    res.end(JSON.stringify(targets.map(item => ({
      ...item,
      webSocketDebuggerUrl: origin + '/devtools/page/' + item.id,
    }))));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

const tab = (id, title, url = 'about:blank') => ({ id, title, url, type:'page' });

test('browser_tabs applies explicit ID and title selectors instead of returning unrelated tabs', async t => {
  const endpoint = await mockCdp(t, [
    tab('one', 'Home'),
    tab('two', 'Monthly Report'),
    tab('three', 'Private Notes'),
  ]);
  assert.deepEqual((await browserTabs({endpoint, target_id:'two'})).structuredContent.data.map(x => x.id), ['two']);
  assert.deepEqual((await browserTabs({endpoint, title:'rEpOrT'})).structuredContent.data.map(x => x.id), ['two']);
  assert.deepEqual((await browserTabs({endpoint, target_id:'two', title:'Home'})).structuredContent.data, []);
});

test('browser_tabs respects URL substring and does not expose unrelated or unsafe tabs', async t => {
  const endpoint = await mockCdp(t, [
    tab('one','Public','https://example.test/alpha'),
    tab('two','Report','https://example.test/report'),
    tab('three','Private','http://127.0.0.1:9876/private/report'),
  ]);
  const result = await browserTabs({endpoint, url_contains:'/report'});
  assert.deepEqual(result.structuredContent.data.map(x => x.id), ['two']);
  const notFound = await browserTabs({endpoint, url_contains:'/not-present'});
  assert.deepEqual(notFound.structuredContent.data, []);
});

test('selector discovery validates only candidate page URLs, retaining the normal URL policy', async () => {
  let validations = 0;
  const targets = [
    { ...tab('one','Unrelated'), webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/page/one' },
    { ...tab('two','Selected'), webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/page/two' },
    { ...tab('three','Unrelated again'), webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/page/three' },
  ];
  const output = await filterBrowserTargets(targets, {
    titleContains:'selected',
    validate: async url => { validations++; assert.equal(url,'about:blank'); },
  });
  assert.deepEqual(output.map(x=>x.id), ['two']);
  assert.equal(validations,1);
});
