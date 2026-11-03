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
    { concurrency: 1 },
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

  const pending = settleComputerSnapshotProbes([run, run], { concurrency: 2 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(started, 2);
  release();
  const results = await pending;
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.status === 'fulfilled'));
});

test('Windows snapshot concurrency is capped at two probes', async () => {
  let active = 0;
  let maxActive = 0;
  const order = [];
  const make = (name) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start:${name}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    order.push(`end:${name}`);
    return name;
  };

  const results = await settleComputerSnapshotProbes(
    [make('a'), make('b'), make('c'), make('d')],
    { concurrency: 2 },
  );

  assert.equal(maxActive, 2);
  const firstEnd = order.findIndex((entry) => entry.startsWith('end:'));
  assert.ok(firstEnd > 0);
  assert.ok(order.slice(0, firstEnd).filter((entry) => entry.startsWith('start:')).length <= 2);
  assert.equal(order.filter((entry) => entry.startsWith('start:')).length, 4);
  assert.equal(order.filter((entry) => entry.startsWith('end:')).length, 4);
  assert.deepEqual(results.map((result) => result.value), ['a', 'b', 'c', 'd']);
});
