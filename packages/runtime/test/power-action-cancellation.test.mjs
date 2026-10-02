import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POWER_ACTION_MAX_DELAY_SECONDS,
  normalizePowerActionDelay,
  waitForPowerActionDelay,
} from '../src/extended/diagnostics.mjs';
import { extendedToolDefinitions } from '../src/extended/catalog.mjs';

test('power_action delay contract stays inside the hosted RPC lifetime', () => {
  assert.equal(POWER_ACTION_MAX_DELAY_SECONDS, 90);
  assert.equal(normalizePowerActionDelay(undefined), 0);
  assert.equal(normalizePowerActionDelay(0), 0);
  assert.equal(normalizePowerActionDelay(90), 90);
  assert.equal(normalizePowerActionDelay(12.5), 12.5);
  assert.throws(() => normalizePowerActionDelay(-0.1), /between 0 and 90/);
  assert.throws(() => normalizePowerActionDelay(90.001), /between 0 and 90/);
  assert.throws(() => normalizePowerActionDelay(Number.NaN), /between 0 and 90/);

  const power = extendedToolDefinitions.find(tool => tool.name === 'power_action');
  const delaySchema = power?.inputSchema?.properties?.delay_seconds;
  assert.equal(delaySchema?.minimum, 0);
  assert.equal(delaySchema?.maximum, 90);
});

test('power_action delayed execution aborts before the deadline when the client cancels', async () => {
  const controller = new AbortController();
  const started = performance.now();
  const waiting = waitForPowerActionDelay(5, controller.signal);
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(waiting, /power action was not executed/);
  assert.ok(performance.now() - started < 1000, 'cancelled delay should not keep waiting for the original deadline');
});

test('power_action refuses an already-cancelled request before waiting', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    waitForPowerActionDelay(0, controller.signal),
    /Cancelled by the client/,
  );
});
