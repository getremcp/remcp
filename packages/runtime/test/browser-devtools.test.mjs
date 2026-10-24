import test from 'node:test';
import assert from 'node:assert/strict';
import { safeDevtoolsUrl, safeDevtoolsMessage, normalizeDevtoolsMetrics, sampleBrowserDevtools } from '../src/extended/browser-devtools.mjs';

test('diagnostic URL removes credentials, fragments and query parameters', () => {
  assert.equal(safeDevtoolsUrl('https://user:secret@example.com/path?a=token#access'), 'https://example.com/path');
  assert.equal(safeDevtoolsUrl('file:///etc/passwd'), '[non-http resource]');
});
test('sensitive credentials are redacted from console summaries', () => {
  assert.doesNotMatch(safeDevtoolsMessage('Authorization: Bearer supersecret password=secret access_token=foo'), /supersecret|password=secret|access_token=foo/);
  assert.match(safeDevtoolsMessage('GET /hello?token=secret'), /\[redacted\]/);
});
test('performance metrics whitelist excludes unknown instrumentation values', () => {
  assert.deepEqual(normalizeDevtoolsMetrics([{name:'Documents',value:3},{name:'Confidential',value:4},
    {name:'JSHeapUsedSize',value:123},{name:'LayoutCount',value:NaN}]),
  {Documents:3, JSHeapUsedSize:123});
});
test('console sampler captures only events observed during sampling and unsubscribes', async () => {
  const observers = new Map();
  const calls = [];
  const session = {
    observe(method,handler) { observers.set(method,handler); return () => observers.delete(method); },
    async send(method) {
      calls.push(method);
      if (method === 'Runtime.enable') {
        observers.get('Runtime.consoleAPICalled')?.({type:'warning',args:[{type:'string',value:'GET https://example.org/?token=abc'}]});
      }
      return {};
    },
  };
  const out = await sampleBrowserDevtools(session,'console',1,10);
  assert.equal(out.events.length,1);
  assert.equal(out.events[0].level,'warning');
  assert.equal(out.events[0].message.includes('token=abc'),false);
  assert.equal(observers.size,0);
  assert.ok(calls.includes('Log.disable'));
});
test('network sampler never includes body/headers and correlates status', async () => {
  const observers = new Map();
  const session = {
    observe(method,handler) { observers.set(method,handler); return () => observers.delete(method); },
    async send(method) {
      if (method === 'Network.enable') {
        observers.get('Network.requestWillBeSent')?.({requestId:'1',request:{url:'https://alice:pw@example.com/api?key=secret',method:'POST',postData:'private body',headers:{Authorization:'Bearer abc'}},type:'Fetch'});
        observers.get('Network.responseReceived')?.({requestId:'1',response:{status:201,headers:{'Set-Cookie':'private'}}});
      }
      return {};
    },
  };
  const out = await sampleBrowserDevtools(session,'network',1,10);
  assert.equal(out.events[0].status,201);
  assert.equal(out.events[0].url,'https://example.com/api');
  const raw = JSON.stringify(out);
  assert.doesNotMatch(raw,/alice|password|private body|Bearer abc|secret/);
});
test('performance mode returns allowlisted metrics only', async () => {
  const calls = [];
  const session = { async send(method) {calls.push(method);return method === 'Performance.getMetrics'?
    {metrics:[{name:'JSHeapUsedSize',value:400},{name:'x',value:20}]}:{};} };
  const result = await sampleBrowserDevtools(session,'performance',1,10);
  assert.deepEqual(result.metrics,{JSHeapUsedSize:400});
  assert.deepEqual(calls,['Performance.enable','Performance.getMetrics','Performance.disable']);
});
