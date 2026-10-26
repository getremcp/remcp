import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpSession } from '../src/extended/browser-session.mjs';

test('aborting a navigation event waiter removes its listener and timer', async () => {
  const session = new CdpSession('ws://127.0.0.1:9999', 5000);
  const controller = new AbortController();
  const awaited = session.waitFor('Page.loadEventFired', 5000, controller.signal);
  assert.equal(session.waiters.get('Page.loadEventFired')?.length, 1);
  controller.abort();
  await assert.rejects(awaited, /aborted/i);
  assert.equal(session.waiters.has('Page.loadEventFired'), false);
  session.close();
});

test('cancelling one waiter does not interrupt a different pending waiter', async () => {
  const session = new CdpSession('ws://127.0.0.1:9999', 5000);
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = session.waitFor('Page.loadEventFired', 5000, firstController.signal);
  const second = session.waitFor('Page.loadEventFired', 5000, secondController.signal);
  firstController.abort();
  await assert.rejects(first, /aborted/);
  assert.equal(session.waiters.get('Page.loadEventFired')?.length, 1);
  session.onMessage({data:JSON.stringify({method:'Page.loadEventFired',params:{timestamp:123}})});
  assert.deepEqual(await second, {timestamp:123});
  assert.equal(session.waiters.has('Page.loadEventFired'), false);
});

test('already aborted signal does not install CDP waiters', async () => {
  const session = new CdpSession('ws://127.0.0.1:9999', 5000);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(session.waitFor('Page.loadEventFired', 5000, controller.signal), /aborted/);
  assert.equal(session.waiters.size, 0);
});
