import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpSession } from '../src/extended/browser-session.mjs';

test('an event waiter fails immediately if CDP has already disconnected', async () => {
  const session = new CdpSession('ws://127.0.0.1:9222/devtools/page/closed', 30_000);
  await assert.rejects(session.waitFor('Page.loadEventFired'), /CDP websocket is not open/);
  assert.equal(session.waiters.size, 0, 'do not retain waiters or 30-second timers');
});

test('an event waiter fails immediately after the WebSocket closes between requests', async () => {
  const session = new CdpSession('ws://127.0.0.1:9222/devtools/page/closing', 30_000);
  session.closed = false;
  session.socket = { readyState: 1 };
  const pending = session.waitFor('Page.loadEventFired');
  assert.equal(session.waiters.size, 1);
  session.onClose();
  await assert.rejects(pending, /CDP websocket closed/);
  await assert.rejects(session.waitFor('Page.loadEventFired'), /CDP websocket is not open/);
  assert.equal(session.waiters.size, 0);
});

test('synchronous CDP send failures clear pending requests and their timeout', async () => {
  const session = new CdpSession('ws://127.0.0.1:9222/devtools/page/failure', 30_000);
  session.closed = false;
  session.socket = { readyState: 1, send() { throw new Error('WebSocket transport failed'); } };
  await assert.rejects(session.send('Runtime.evaluate', { expression:'1+1' }), /WebSocket transport failed/);
  assert.equal(session.pending.size, 0, 'no leaked pending request until the 30-second timeout');
  session.close();
});
