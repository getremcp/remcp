import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createAgentRelayConnection } from '../src/agent-relay-connection.mjs';

async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(15);
  }
  assert.fail('connection condition not reached before timeout');
}

function makeClient(port, overrides = {}) {
  let stopping = false;
  let socket;
  let reconnects = 0;
  const controller = createAgentRelayConnection({
    agentUrl: 'ws://127.0.0.1:' + port,
    serverUrl: 'http://127.0.0.1:' + port,
    deviceToken: 'test-only-token', deviceId: 'fixture-device', deviceName: 'fixture',
    isStopping: () => stopping, markStopping: () => { stopping = true; },
    getReconnects: () => reconnects, setReconnects: value => { reconnects = value; },
    setSocket: value => { socket = value; }, getHelloState: () => ({}),
    respond: async () => {}, inFlight: new Map(),
    sendMetricsSample: () => {}, reportInstallOnce: () => {},
    flushTelemetry: () => {}, checkForUpdate: async () => {},
    schedulePostConnectUpdateChecks: () => {}, clearPostConnectUpdateChecks: () => {},
    stop: async () => {}, heartbeatIntervalMs: 35, ...overrides,
  });
  return { controller, getSocket: () => socket, getReconnects: () => reconnects,
    shutdown() { stopping = true; controller.clearReconnect(); socket?.terminate(); } };
}

async function server(t, options = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, ...options });
  await once(wss, 'listening');
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
  });
  return wss;
}

test('client heartbeat keeps a healthy relay connection alive without reconnect churn', async t => {
  const wss = await server(t);
  let connects = 0;
  let pings = 0;
  wss.on('connection', ws => {
    connects++;
    ws.on('ping', () => { pings++; });
  });
  // The real relay uses a much longer heartbeat. Give a busy shared CI runner
  // enough time to process an automatic pong without masking reconnect churn.
  // The half-open test below keeps the fast 35 ms failure-detection interval.
  const client = makeClient(wss.address().port, { heartbeatIntervalMs: 150 });
  t.after(() => client.shutdown());
  client.controller.connect();
  await until(() => pings >= 3);
  assert.equal(connects, 1, 'a responsive relay must not be disconnected');
  assert.equal(client.getSocket().readyState, 1);
});

test('single lost pong is recovered by the next heartbeat without reconnect churn', async t => {
  const wss = await server(t, { autoPong: false });
  let connects = 0;
  let pings = 0;
  wss.on('connection', ws => {
    connects++;
    ws.on('ping', () => {
      pings++;
      // Simulate one lost pong across a brief NIC reset. Every later ping is answered.
      if (pings > 1) ws.pong();
    });
  });
  const client = makeClient(wss.address().port, { heartbeatIntervalMs: 150 });
  t.after(() => client.shutdown());
  client.controller.connect();
  await until(() => pings >= 4, 5000);
  assert.equal(connects, 1, 'one lost pong must not force a new device session');
  assert.equal(client.getSocket().readyState, 1);
});

test('silent half-open WebSocket is terminated and a fresh relay session recovers', async t => {
  const wss = await server(t, { autoPong: false });
  const hellos = [];
  let connects = 0;
  let staleClosed = false;
  let stalePings = 0;
  let replacementPings = 0;
  wss.on('connection', ws => {
    const number = ++connects;
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'hello') hellos.push(number);
    });
    if (number === 1) {
      ws.on('close', () => { staleClosed = true; });
      ws.on('ping', () => { stalePings++; });
    } else ws.on('ping', () => { replacementPings++; ws.pong(); });
  });
  // A 35 ms ping/pong window is below scheduling jitter on a shared CI host.
  // Preserve stale detection while allowing a responsive replacement to answer.
  const client = makeClient(wss.address().port, { heartbeatIntervalMs: 500 });
  t.after(() => client.shutdown());
  client.controller.connect();
  await until(() => hellos.length >= 2, 6000);
  assert(staleClosed, 'stale connection must be force-closed');
  assert.equal(stalePings, 2, 'a silent peer gets one retry, not unlimited pings');
  assert.deepEqual(hellos.slice(0, 2), [1, 2], 'relay must receive a second hello');
  // Observe three actual replacement heartbeats rather than a wall-clock sleep.
  // This still fails if the client loops through new connections instead of recovering.
  await until(() => replacementPings >= 3, 5000);
  assert.equal(connects, 2, 'responsive replacement must remain connected');
  assert.equal(client.getSocket().readyState, 1);
});

test('stalled opening handshake times out and reconnects after network recovery', async t => {
  const openSockets = new Set();
  const stalled = createServer(socket => {
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
  });
  await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve));
  const port = stalled.address().port;
  const client = makeClient(port, { handshakeTimeoutMs: 140 });
  t.after(() => client.shutdown());
  client.controller.connect();
  await until(() => client.getReconnects() >= 1);
  // A raw TCP listener waits for existing sockets on close; destroy the blackholed peers.
  for (const socket of openSockets) socket.destroy();
  await new Promise(resolve => stalled.close(resolve));
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  await once(wss, 'listening');
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
  });
  let hello = false;
  wss.on('connection', ws => ws.on('message', raw => {
    if (JSON.parse(raw.toString()).type === 'hello') hello = true;
  }));
  await until(() => hello);
  assert.equal(client.getSocket().readyState, 1);
});


test('a captive-portal proxy redirect is retried after the network clears', async t => {
  const httpServer = createHttpServer();
  const wss = new WebSocketServer({ noServer: true });
  let attempts = 0;
  let hello = false;
  httpServer.on('upgrade', (request, socket, head) => {
    attempts++;
    if (attempts === 1) {
      socket.end('HTTP/1.1 302 Found\r\nLocation: /login\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => ws.on('message', raw => {
    if (JSON.parse(raw.toString()).type === 'hello') hello = true;
  }));
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const client = makeClient(httpServer.address().port);
  t.after(async () => {
    client.shutdown();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => httpServer.close(resolve));
  });
  client.controller.connect();
  await until(() => hello);
  assert.equal(attempts, 2);
  assert.equal(client.getSocket().readyState, 1);
});

test('explicitly revoked device does not reconnect or bypass revocation', async t => {
  const httpServer = createHttpServer();
  let attempts = 0;
  httpServer.on('upgrade', (_request, socket) => {
    attempts++;
    socket.end('HTTP/1.1 401 Unauthorized\r\nX-ReMCP-Revoked: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  let stopped=0;
  const client = makeClient(httpServer.address().port,{stop:async()=>{stopped++;}});
  t.after(async () => {
    client.shutdown();
    await new Promise(resolve => httpServer.close(resolve));
  });
  client.controller.connect();
  await until(() => attempts === 1 && stopped === 1);
  await sleep(850);
  assert.equal(attempts, 1, 'revocation must not trigger a retry');
});


test('established socket revocation closes the owned runtime and cancels in-flight commands',async t=>{
  const wss=await server(t);let stopped=0,connected=0;
  const pending=new AbortController();
  wss.on('connection',ws=>{connected++;ws.once('message',()=>ws.close(1008,'revoked'));});
  const client=makeClient(wss.address().port,{inFlight:new Map([['capture',pending]]),stop:async()=>{stopped++;}});
  t.after(()=>client.shutdown());client.controller.connect();
  await until(()=>stopped===1);
  assert.equal(pending.signal.aborted,true);
  await sleep(850);assert.equal(connected,1);assert.equal(stopped,1);
});
