import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(predicate(), message);
}

test('a transient HTTP 502 WebSocket handshake failure reconnects automatically', { timeout: 12000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'remcp-transient-handshake-'));
  const runtimeDir = join(root, 'modules', '@example', 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const npm = join(root, 'npm');
  writeFileSync(npm, `#!/bin/sh
printf '%s\\n' '${join(root, 'modules')}'
`);
  chmodSync(npm, 0o700);
  writeFileSync(join(runtimeDir, 'index.mjs'), `
    import readline from 'node:readline';
    readline.createInterface({ input: process.stdin }).on('line', raw => {
      const message = JSON.parse(raw);
      if (message.id === undefined) return;
      const result = message.method === 'initialize'
        ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } }
        : { tools: [] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
    });
  `);

  const previousNpm = process.env.REMCP_NPM;
  process.env.REMCP_NPM = npm;
  const { runAgent } = await import('../src/agent.mjs');

  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  let rejectNextUpgrade = false;
  let rejected = 0;
  let acceptedConnections = 0;
  const sockets = new Set();

  server.on('upgrade', (request, socket, head) => {
    if (rejectNextUpgrade) {
      rejectNextUpgrade = false;
      rejected += 1;
      const response = new http.ServerResponse(request);
      response.assignSocket(socket);
      response.statusCode = 502;
      response.statusMessage = 'Bad Gateway';
      response.setHeader('Connection', 'close');
      response.end('Bad Gateway');
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
  wss.on('connection', socket => {
    acceptedConnections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let agent;
  t.after(async () => {
    try { await agent?.stop(); } catch {}
    for (const socket of sockets) socket.terminate();
    wss.close();
    server.close();
    if (previousNpm === undefined) delete process.env.REMCP_NPM;
    else process.env.REMCP_NPM = previousNpm;
    rmSync(root, { recursive: true, force: true });
  });

  agent = await runAgent({
    serverUrl: `http://127.0.0.1:${server.address().port}`,
    deviceToken: 'fixture-token',
    deviceId: 'fixture-device',
    deviceName: 'Fixture',
    autoUpdate: false,
    telemetryEnabled: false,
    runtime: { kind: 'npm', packageName: '@example/runtime', packageSpec: '@example/runtime@1.0.0', entry: 'index.mjs' },
  },{prepareE2eeProfile:async()=>null});

  await waitFor(() => acceptedConnections === 1, 'the agent should establish its initial relay connection');

  rejectNextUpgrade = true;
  [...sockets][0].close(1013, 'relay redeploy');
  await waitFor(() => rejected === 1, 'the immediate reconnect should encounter the simulated 502');
  await waitFor(() => acceptedConnections >= 2, 'the agent should retry after the transient 502 and reconnect');
});
