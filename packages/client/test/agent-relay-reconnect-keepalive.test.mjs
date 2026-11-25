import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

const relayModule = new URL('../src/agent-relay-connection.mjs', import.meta.url).href;

test('a failed WebSocket handshake retains an active agent while reconnect is scheduled', async t => {
  const script = `
import { createAgentRelayConnection } from ${JSON.stringify(relayModule)};
let retries = 0;
const client = createAgentRelayConnection({
  agentUrl:'ws://127.0.0.1:1',
  serverUrl:'http://127.0.0.1:1',
  deviceToken:'local-fixture-only',
  deviceId:'test-device', deviceName:'fixture',
  isStopping:() => false, markStopping:() => {},
  getReconnects:() => retries, setReconnects:n => { retries = n; },
  setSocket:() => {}, getHelloState:() => ({}),
  respond:async () => {}, inFlight:new Map(),
  sendMetricsSample:() => {}, reportInstallOnce:() => {}, flushTelemetry:() => {},
  checkForUpdate:async () => {}, schedulePostConnectUpdateChecks:() => {},
  clearPostConnectUpdateChecks:() => {}, stop:async () => {},
});
client.connect();
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script],
    { stdio:['ignore','pipe','pipe'], windowsHide:true });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && !child.killed) child.kill();
    await closed;
  });
  // Wait for evidence of an actual retry, not a fixed child startup delay.
  // A regression that unrefs the reconnect timer exits before the second error.
  child.stderr.setEncoding('utf8');
  let stderr = '';
  const signal = AbortSignal.timeout(15_000);
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      child.stderr.off('data', onData);
      child.off('close', onClose);
      signal.removeEventListener('abort', onTimeout);
    };
    const finish = error => { cleanup(); error ? reject(error) : resolve(); };
    const onData = chunk => {
      stderr += chunk;
      if ((stderr.match(/ReMCP relay:/g) || []).length >= 2) finish();
    };
    const onClose = () => finish(new Error('agent exited before the scheduled reconnect'));
    const onTimeout = () => finish(new Error('no second WebSocket failure within the bounded deadline'));
    child.stderr.on('data', onData);
    child.once('close', onClose);
    signal.addEventListener('abort', onTimeout, { once:true });
  });
  assert.equal(child.exitCode, null, 'agent must remain active after reconnect');
  child.kill();
  await closed;
});

test('explicit agent shutdown releases the reconnect timer and permits process exit', async t => {
  const script = `
import { createAgentRelayConnection } from ${JSON.stringify(relayModule)};
let retries = 0;
const client = createAgentRelayConnection({
  agentUrl:'ws://127.0.0.1:1', serverUrl:'http://127.0.0.1:1',
  deviceToken:'local-fixture-only', deviceId:'fixture', deviceName:'fixture',
  isStopping:() => false, markStopping:() => {},
  getReconnects:() => retries, setReconnects:n => { retries=n; setImmediate(() => client.clearReconnect()); },
  setSocket:() => {}, getHelloState:() => ({}), respond:async () => {},
  inFlight:new Map(), sendMetricsSample:() => {}, reportInstallOnce:() => {},
  flushTelemetry:() => {}, checkForUpdate:async () => {},
  schedulePostConnectUpdateChecks:() => {}, clearPostConnectUpdateChecks:() => {},
  stop:async () => {},
});
client.connect();

`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script],
    { stdio:['ignore','pipe','pipe'], windowsHide:true });
  t.after(() => { if (child.exitCode === null && !child.killed) child.kill(); });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code, signal] = await once(child, 'close', { signal:AbortSignal.timeout(15_000) });
  assert.match(stderr, /ReMCP relay:/, 'shutdown fixture must observe a real failed handshake');
  assert.equal(signal, null);
  assert.equal(code, 0, 'clearing reconnect must not keep the agent alive');
});
