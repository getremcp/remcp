import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { guardSupervisorDisconnect } from '../src/cli/supervised-agent-lifecycle.mjs';

function fakeProcess({ ipc = false, connected = ipc } = {}) {
  const child = new EventEmitter();
  child.connected = connected;
  if (ipc) child.send = () => {};
  child.exits = [];
  child.exit = code => child.exits.push(code);
  return child;
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('Windows owned-job child without Node IPC stays online', async () => {
  const child = fakeProcess();
  let stops = 0;
  assert.equal(guardSupervisorDisconnect({ stop: () => { stops++; } }, child), false);
  child.emit('disconnect');
  await flush();
  assert.equal(stops, 0);
  assert.deepEqual(child.exits, []);
  assert.equal(child.listenerCount('disconnect'), 0);
});

test('legacy IPC supervision stops the agent once on disconnect', async () => {
  const child = fakeProcess({ ipc:true });
  let stops = 0;
  assert.equal(guardSupervisorDisconnect({ stop: async () => { stops++; } }, child), true);
  child.connected = false;
  child.emit('disconnect');
  child.emit('disconnect');
  await flush();
  assert.equal(stops, 1);
  assert.deepEqual(child.exits, [0]);
});

test('IPC already disconnected during startup is stopped immediately', async () => {
  const child = fakeProcess({ ipc:true, connected:false });
  let stops = 0;
  guardSupervisorDisconnect({ stop: async () => { stops++; } }, child);
  await flush();
  assert.equal(stops, 1);
  assert.deepEqual(child.exits, [0]);
});

test('failed orphan stop exits unsuccessfully without unhandled rejection', async () => {
  const child = fakeProcess({ ipc:true });
  guardSupervisorDisconnect({ stop: async () => { throw new Error('stop failed'); } }, child);
  child.emit('disconnect');
  await flush();
  assert.deepEqual(child.exits, [1]);
});
