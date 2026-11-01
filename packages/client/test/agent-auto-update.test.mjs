import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { VERSION } from '../src/version.mjs';

test('live auto-update discovery rechecks the advertised release after connect', { timeout: 10000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'remcp-auto-update-'));
  const modules = join(root, 'modules');
  const runtimeDir = join(modules, '@example', 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const npm = join(root, 'npm');
  writeFileSync(npm, `#!/bin/sh
printf '%s\\n' '${modules}'
`, { mode: 0o700 });
  writeFileSync(join(runtimeDir, 'index.mjs'), `
    import readline from 'node:readline';
    readline.createInterface({ input: process.stdin }).on('line', raw => {
      const message = JSON.parse(raw);
      if (message.id === undefined) return;
      if (message.method === 'initialize') {
        process.stdout.write(JSON.stringify({
          jsonrpc:'2.0',
          id:message.id,
          result:{
            protocolVersion:message.params.protocolVersion,
            capabilities:{ tools:{} },
            serverInfo:{ name:'fixture', version:${JSON.stringify(VERSION)} },
          },
        }) + '\\n');
        return;
      }
      if (message.method === 'tools/list') {
        process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:message.id, result:{ tools:[] } }) + '\\n');
        return;
      }
      process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:message.id, result:{} }) + '\\n');
    });
  `);

  const previousNpm = process.env.REMCP_NPM;
  process.env.REMCP_NPM = npm;
  const errors = [];
  const previousError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));

  let versionChecks = 0;
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith('/api/agent/version')) {
      versionChecks += 1;
      response.writeHead(200, { 'content-type':'application/json' });
      response.end(JSON.stringify({
        cli: `@remcp/remcp@${VERSION}`,
        runtime: `@example/runtime@${VERSION}`,
        minimum: VERSION,
      }));
      return;
    }
    response.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  let agent;
  t.after(async () => {
    console.error = previousError;
    await agent?.stop();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    if (previousNpm === undefined) delete process.env.REMCP_NPM;
    else process.env.REMCP_NPM = previousNpm;
    rmSync(root, { recursive:true, force:true });
  });

  const { runAgent } = await import('../src/agent.mjs');
  agent = await runAgent({
    serverUrl: `http://127.0.0.1:${server.address().port}`,
    deviceToken:'fixture-token',
    deviceId:'fixture-device',
    telemetryEnabled:false,
    updateRecheckDelaysMs:[25, 60],
    updateCheckMinGapMs:0, // exercise fast, explicitly configured convergence checks
    updateRecheckJitterMs:0,
    runtime:{
      kind:'npm',
      packageName:'@example/runtime',
      packageSpec:`@example/runtime@${VERSION}`,
      entry:'index.mjs',
    },
  });

  const deadline = Date.now() + 5000;
  while (versionChecks < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(versionChecks >= 3, `expected the immediate check plus two bounded convergence rechecks, got ${versionChecks}`);
  assert.equal(
    errors.some(line => line.includes('ReMCP auto-update check failed')),
    false,
    errors.join('\n'),
  );
});

