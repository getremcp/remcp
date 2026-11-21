import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

async function waitFor(predicate, message, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(predicate(), message);
}

test('workspace pause retries through 423 and reconnects after the device is enabled', { timeout: 12000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'remcp-disabled-reconnect-'));
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
  let disabled = false;
  let rejectedWhileDisabled = 0;
  let acceptedConnections = 0;
  const sockets = new Set();

  server.on('upgrade', (request, socket, head) => {
    if (disabled) {
      rejectedWhileDisabled += 1;
      socket.end('HTTP/1.1 423 Locked\r\nX-ReMCP-Disabled: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
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

  disabled = true;
  [...sockets][0].close(1011, 'disabled');
  await waitFor(() => rejectedWhileDisabled >= 1, 'the paused agent should retry and receive the temporary 423 response');

  disabled = false;
  await waitFor(() => acceptedConnections >= 2, 'the same agent should reconnect automatically after service access is enabled');
});
