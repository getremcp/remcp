import test from 'node:test';
import assert from 'node:assert/strict';
import { nextDeployReconnect } from '../src/agent-deploy-reconnect.mjs';

test('single relay deployment reconnects quickly', () => {
  assert.deepEqual(nextDeployReconnect({ requestedDelayMs: 200, rapidDisconnects: 0, connectionUptimeMs: 100 }),
    { delayMs: 200, rapidDisconnects: 1 });
});
test('repeated flaps back off instead of reconnecting at 200 ms indefinitely', () => {
  let rapidDisconnects = 0;
  const seen = [];
  for (let n = 0; n < 9; n++) {
    const current = nextDeployReconnect({ requestedDelayMs: 200, rapidDisconnects, connectionUptimeMs: 250 });
    rapidDisconnects = current.rapidDisconnects;
    seen.push(current.delayMs);
  }
  assert.deepEqual(seen, [200, 250, 500, 1000, 2000, 4000, 8000, 8000, 8000]);
});
test('a healthy ten-second connection resets burst penalty', () => {
  assert.deepEqual(nextDeployReconnect({ requestedDelayMs: 200, rapidDisconnects: 8, connectionUptimeMs: 15_000 }),
    { delayMs: 200, rapidDisconnects: 0 });
});
test('never shortens a server-requested delay', () => {
  assert.deepEqual(nextDeployReconnect({ requestedDelayMs: 30_000, rapidDisconnects: 6, connectionUptimeMs: 100 }),
    { delayMs: 30_000, rapidDisconnects: 7 });
});
test('bounds malformed relay delays and burst counters', () => {
  assert.deepEqual(nextDeployReconnect({ requestedDelayMs: Number.POSITIVE_INFINITY, rapidDisconnects: -2, connectionUptimeMs: 0 }),
    { delayMs: 150, rapidDisconnects: 1 });
  assert.deepEqual(nextDeployReconnect({ requestedDelayMs: 9_000_000, rapidDisconnects: 8, connectionUptimeMs: 0 }),
    { delayMs: 60_000, rapidDisconnects: 8 });
});