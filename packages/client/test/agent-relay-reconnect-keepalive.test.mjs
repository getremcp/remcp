import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
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
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null && !child.killed) child.kill(); });
  await delay(1200);
  assert.match(stderr, /ReMCP relay:/, 'the harness must induce a real WebSocket failure');
  assert.equal(child.exitCode, null,
    'an unrefed reconnect timer lets the agent exit 0 immediately after a failed handshake');
  child.kill();
  await once(child, 'close');
});

test('explicit agent shutdown releases the reconnect timer and permits process exit', async t => {
  const script = `
import { createAgentRelayConnection } from ${JSON.stringify(relayModule)};
let retries = 0;
const client = createAgentRelayConnection({
  agentUrl:'ws://127.0.0.1:1', serverUrl:'http://127.0.0.1:1',
  deviceToken:'local-fixture-only', deviceId:'fixture', deviceName:'fixture',
  isStopping:() => false, markStopping:() => {},
  getReconnects:() => retries, setReconnects:n => { retries=n; },
  setSocket:() => {}, getHelloState:() => ({}), respond:async () => {},
  inFlight:new Map(), sendMetricsSample:() => {}, reportInstallOnce:() => {},
  flushTelemetry:() => {}, checkForUpdate:async () => {},
  schedulePostConnectUpdateChecks:() => {}, clearPostConnectUpdateChecks:() => {},
  stop:async () => {},
});
client.connect();
setTimeout(() => client.clearReconnect(), 200);
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script],
    { stdio:['ignore','pipe','pipe'], windowsHide:true });
  t.after(() => { if (child.exitCode === null && !child.killed) child.kill(); });
  const [code, signal] = await once(child, 'close', { signal:AbortSignal.timeout(1800) });
  assert.equal(signal, null);
  assert.equal(code, 0, 'clearing reconnect must not keep the agent alive');
});
