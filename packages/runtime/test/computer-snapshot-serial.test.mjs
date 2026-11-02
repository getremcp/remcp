import test from 'node:test';
import assert from 'node:assert/strict';
import { settleComputerSnapshotProbes } from '../src/extended/desktop-computer-snapshot.mjs';

test('serial Windows probes run one at a time and keep rejection results', async () => {
  const order = [];
  let active = 0;
  let maxActive = 0;
  const make = (name, fail = false) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start:${name}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    order.push(`end:${name}`);
    if (fail) throw new Error(name);
    return name;
  };

  const results = await settleComputerSnapshotProbes(
    [make('windows'), make('displays', true), make('cursor')],
    { serial: true },
  );

  assert.equal(maxActive, 1);
  assert.deepEqual(order, [
    'start:windows', 'end:windows',
    'start:displays', 'end:displays',
    'start:cursor', 'end:cursor',
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].status, 'fulfilled');
});

test('non-Windows probes still start together', async () => {
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = async () => {
    started += 1;
    await gate;
    return started;
  };

  const pending = settleComputerSnapshotProbes([run, run], { serial: false });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(started, 2);
  release();
  const results = await pending;
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.status === 'fulfilled'));
});
