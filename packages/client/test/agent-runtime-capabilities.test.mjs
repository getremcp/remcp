import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntimeCapabilities,
  normalizeRuntimeToolNames,
} from '../src/agent-runtime-capabilities.mjs';

test('MCP capability normalization preserves order and bounds untrusted tool names', () => {
  assert.deepEqual(normalizeRuntimeToolNames({ tools: [
    { name:'read_file' }, { name:'read_file' }, { name:'  browser_tabs  ' },
    { name:'' }, {}, { name:'x'.repeat(150) },
  ] }), ['read_file', 'browser_tabs', 'x'.repeat(128)]);
  assert.equal(normalizeRuntimeToolNames({ tools: Array.from({length:300}, (_, i) => ({name:`tool_${i}`})) }).length, 256);
  assert.deepEqual(normalizeRuntimeToolNames({ tools:null }), []);
});

test('agent capability manager only announces changes and supports silent initial sync', async () => {
  let tools = [];
  const announced = [];
  let active = true;
  const client = { async listTools() { return {tools:[{name:'terminal'}]}; } };
  const manager = createRuntimeCapabilities({
    getTools: () => tools,
    setTools: next => { tools = next; },
    isActive: candidate => active && candidate === client,
    announce: next => announced.push(next),
    jitter: value => value,
  });
  await manager.refresh(client, {announce:false});
  await manager.refresh(client);
  assert.deepEqual(tools, ['terminal']);
  assert.deepEqual(announced, []);
  manager.apply(['terminal', 'read_file']);
  manager.apply(['terminal', 'read_file']);
  assert.deepEqual(announced, [['terminal', 'read_file']]);
  active = false;
  await manager.refresh(client);
  assert.deepEqual(tools, ['terminal', 'read_file']);
  manager.clearRetry();
});

test('stale MCP tool-list responses cannot overwrite a newer runtime', async () => {
  let finish;
  let tools = ['stable'];
  let active = true;
  const client = { listTools: () => new Promise(resolve => { finish = resolve; }) };
  const manager = createRuntimeCapabilities({
    getTools: () => tools,
    setTools: next => { tools = next; },
    isActive: candidate => active && candidate === client,
    announce: () => assert.fail('stale response announced'),
    jitter: value => value,
  });
  const pending = manager.refresh(client);
  active = false;
  finish({tools:[{name:'stale'}]});
  await pending;
  assert.deepEqual(tools, ['stable']);
});

test('temporary MCP list failure retries while active and stops after success', async () => {
  let tools = [];
  let tries = 0;
  let notifyRecovery;
  const recovered = new Promise(resolve => { notifyRecovery = resolve; });
  const errors = [];
  const client = {
    async listTools() {
      tries++;
      if (tries === 1) throw new Error('temporary');
      notifyRecovery();
      return { tools:[{name:'browser_tabs'}] };
    },
  };
  const manager = createRuntimeCapabilities({
    getTools: () => tools,
    setTools: next => { tools = next; },
    isActive: candidate => candidate === client,
    announce: () => {},
    jitter: value => value,
    retryBaseMs: 5,
    retryMaxMs: 20,
    onError: message => errors.push(message),
  });
  await manager.refresh(client);
  let deadlineTimer;
  try {
    await Promise.race([
      recovered,
      new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => reject(new Error('retry never completed')), 1_500);
      }),
    ]);
  } finally {
    clearTimeout(deadlineTimer);
    manager.clearRetry();
  }
  assert.equal(tries, 2);
  assert.deepEqual(tools, ['browser_tabs']);
  assert.equal(errors.length, 1);
});

test('runtime starts are serialized and concurrent requests coalesce behind cleanup', async () => {
  const {serializeRuntimeStarts}=await import('../src/agent-runtime-capabilities.mjs');
  let active=0, maximum=0, calls=0, release, stopping=false;
  const gate=new Promise(resolve=>{release=resolve;});
  const request=serializeRuntimeStarts(async()=>{
    maximum=Math.max(maximum,++active);
    if(++calls===1) await gate;
    --active;
  },()=>stopping);
  const first=request();
  await Promise.resolve();
  const second=request(), third=request();
  assert.equal(calls,1);
  assert.equal(first,second);
  assert.equal(second,third);
  release();
  await first;
  assert.equal(calls,2);
  assert.equal(maximum,1);
  stopping=true;
  await request();
  assert.equal(calls,2);
});
