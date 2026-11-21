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
  assert.equal(session.socket, null, 'closed sockets must not remain pinned in cached sessions');
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

test('a CDP handshake that closes before opening fails promptly', async () => {
  const previous = globalThis.WebSocket;
  class ClosingSocket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event('close')));
    }
    close() {}
  }
  globalThis.WebSocket = ClosingSocket;
  try {
    const session = new CdpSession('ws://127.0.0.1:9222/devtools/page/closed', 200);
    await assert.rejects(session.open(), /CDP websocket closed before opening/);
    assert.equal(session.closed, true);
    assert.equal(session.socket, null);
  } finally {
    globalThis.WebSocket = previous;
  }
});

test('a late WebSocket open cannot revive an expired CDP handshake', async () => {
  const previous = globalThis.WebSocket;
  let socket;
  class DelayedSocket extends EventTarget {
    readyState = 0;
    closeCalls = 0;
    constructor() {
      super();
      socket = this;
    }
    close() {
      this.readyState = 3;
      this.closeCalls += 1;
    }
  }
  globalThis.WebSocket = DelayedSocket;
  try {
    const session = new CdpSession('ws://127.0.0.1:9222/devtools/page/late', 20);
    await assert.rejects(session.open(), /CDP websocket connection timed out/);
    assert.equal(socket.closeCalls, 1);
    socket.readyState = 1;
    socket.dispatchEvent(new Event('open'));
    assert.equal(session.closed, true, 'late open must not reconnect a failed session');
    assert.equal(session.socket, null, 'failed handshake must not retain a stale socket');
  } finally {
    globalThis.WebSocket = previous;
  }
});

test('a connected CDP socket fails closed on error even without a close event', async () => {
  const previous = globalThis.WebSocket;
  let socket;
  class BrokenSocket extends EventTarget {
    readyState = 0;
    closeCalls = 0;
    constructor() {
      super();
      socket = this;
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      });
    }
    close() {
      this.readyState = 3;
      this.closeCalls += 1;
    }
  }
  globalThis.WebSocket = BrokenSocket;
  try {
    const session = await new CdpSession('ws://127.0.0.1:9222/devtools/page/error', 200).open();
    const pending = session.waitFor('Page.loadEventFired', 500);
    socket.dispatchEvent(new Event('error'));
    await assert.rejects(pending, /CDP websocket closed/);
    assert.equal(session.closed, true);
    assert.equal(session.waiters.size, 0);
    assert.equal(socket.closeCalls, 1);
  } finally {
    globalThis.WebSocket = previous;
  }
});

test('closing a pending CDP handshake cancels it and rejects late open', async () => {
  const previous = globalThis.WebSocket;
  let socket;
  class PendingSocket extends EventTarget {
    closeCalls = 0;
    readyState = 0;
    constructor() {
      super();
      socket = this;
    }
    close() {
      this.closeCalls += 1;
      this.readyState = 3;
    }
  }
  globalThis.WebSocket = PendingSocket;
  try {
    const session = new CdpSession('ws://127.0.0.1:9222/devtools/page/cancel', 160);
    const opening = session.open();
    session.close();
    await assert.rejects(opening, /CDP websocket connection cancelled/i);
    assert.equal(socket.closeCalls, 1, 'cancel pending socket immediately');
    socket.readyState = 1;
    socket.dispatchEvent(new Event('open'));
    assert.equal(session.closed, true);
    assert.equal(session.socket, null, 'cancelled handshake must not revive');
  } finally {
    globalThis.WebSocket = previous;
  }
});

test('CDP session refuses duplicate concurrent or already-open handshakes', async () => {
  const previous = globalThis.WebSocket;
  const sockets = [];
  class PendingSocket extends EventTarget {
    readyState = 0;
    constructor() {
      super();
      sockets.push(this);
    }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = PendingSocket;
  try {
    const session = new CdpSession('ws://127.0.0.1:9222/devtools/page/duplicate', 160);
    const opening = session.open();
    await assert.rejects(session.open(), /CDP websocket connection already pending/i);
    assert.equal(sockets.length, 1, 'duplicate open must not create a socket');
    sockets[0].readyState = 1;
    sockets[0].dispatchEvent(new Event('open'));
    assert.equal(await opening, session);
    await assert.rejects(session.open(), /CDP websocket already open/i);
    assert.equal(sockets.length, 1);
    session.close();
  } finally {
    globalThis.WebSocket = previous;
  }
});

class TrackedSocket extends EventTarget {
  static last;
  static openImmediately = false;
  readyState = 0;
  listeners = new Map();
  constructor() {
    super();
    TrackedSocket.last = this;
    if (TrackedSocket.openImmediately) queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    });
  }
  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options);
    this.listeners.get(type)?.delete(listener);
  }
  close() { this.readyState = 3; }
  assertReleased() {
    for (const type of ['open', 'message', 'error', 'close']) {
      assert.equal(this.listeners.get(type)?.size || 0, 0, `stale ${type} listener`);
    }
  }
}

test('failed CDP handshakes release all listeners without relying on a close event', async () => {
  const previous = globalThis.WebSocket;
  TrackedSocket.openImmediately = false;
  globalThis.WebSocket = TrackedSocket;
  try {
    const session = new CdpSession('ws://127.0.0.1:9222/devtools/page/no-close', 15);
    await assert.rejects(session.open(), /CDP websocket connection timed out/);
    assert.equal(session.socket, null);
    TrackedSocket.last.assertReleased();
  } finally {
    globalThis.WebSocket = previous;
  }
});

test('remote close releases lifetime listeners and fails outstanding waits', async () => {
  const previous = globalThis.WebSocket;
  TrackedSocket.openImmediately = true;
  globalThis.WebSocket = TrackedSocket;
  try {
    const session = await new CdpSession('ws://127.0.0.1:9222/devtools/page/remote-close', 200).open();
    const socket = TrackedSocket.last;
    const waiting = session.waitFor('Page.loadEventFired', 500);
    socket.readyState = 3;
    socket.dispatchEvent(new Event('close'));
    await assert.rejects(waiting, /CDP websocket closed/);
    assert.equal(session.socket, null);
    socket.assertReleased();
  } finally {
    TrackedSocket.openImmediately = false;
    globalThis.WebSocket = previous;
  }
});

test('local session close releases socket listeners even when no close event arrives', async () => {
  const previous = globalThis.WebSocket;
  TrackedSocket.openImmediately = true;
  globalThis.WebSocket = TrackedSocket;
  try {
    const session = await new CdpSession('ws://127.0.0.1:9222/devtools/page/local-close', 200).open();
    const socket = TrackedSocket.last;
    session.close();
    assert.equal(session.socket, null);
    socket.assertReleased();
  } finally {
    TrackedSocket.openImmediately = false;
    globalThis.WebSocket = previous;
  }
});

test('CDP socket error without close event releases lifetime listeners', async () => {
  const previous = globalThis.WebSocket;
  TrackedSocket.openImmediately = true;
  globalThis.WebSocket = TrackedSocket;
  try {
    const session = await new CdpSession('ws://127.0.0.1:9222/devtools/page/no-close', 200).open();
    const socket = TrackedSocket.last;
    socket.dispatchEvent(new Event('error'));
    assert.equal(session.closed, true);
    assert.equal(session.socket, null);
    socket.assertReleased();
  } finally {
    TrackedSocket.openImmediately = false;
    globalThis.WebSocket = previous;
  }
});
