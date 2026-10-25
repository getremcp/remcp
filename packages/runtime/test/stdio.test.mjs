import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { body, freshWorkspace } from './helpers.mjs';

const run = promisify(execFile);
const root = freshWorkspace('stdio');
const entry = path.resolve('src/index.mjs');

function printedTools() {
  return JSON.parse(execFileSync(process.execPath, [entry, '--print-tools'], { encoding: 'utf8' }));
}

async function unusedPort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

test('runtime serves MCP over stdio like the ReMCP agent expects', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env } });
  const client = new Client({ name: 'remcp-agent-test', version: '1.0.0' }, { versionNegotiation:{ mode:'legacy' } });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const published = printedTools();
    const described = JSON.parse(execFileSync(process.execPath, [entry, '--describe'], { encoding: 'utf8' }));
    const publishedNames = new Set(published.map(tool => tool.name));
    const liveNames = tools.map(tool => tool.name);
    // --describe is a separate process with a separate live capability probe.
    // On hosts where optional desktop/browser helpers appear during startup, its
    // supportedTools count may legitimately differ from this MCP session's list.
    // Validate each snapshot against the immutable catalog instead of comparing
    // two samples taken at different times (a TOCTOU race).
    assert.equal(publishedNames.size, published.length, 'published tool names must be unique');
    assert.equal(new Set(liveNames).size, liveNames.length, 'MCP tools/list must not contain duplicates');
    assert.ok(liveNames.length > 0, 'MCP tools/list must advertise available tools');
    assert.ok(liveNames.every(name => publishedNames.has(name)), 'live tools/list must be a subset of the published contract');
    assert.ok(tools.every(tool => typeof tool.name === 'string' && tool.inputSchema?.type === 'object'),
      'MCP tools/list must contain complete tool schemas');
    assert.ok(Number.isSafeInteger(described.supportedTools) && described.supportedTools > 0 &&
      described.supportedTools <= published.length, '--describe must report a valid capability count');
    for (const requiredName of ['read_file', 'write_file', 'start_process']) {
      assert.ok(liveNames.includes(requiredName), `mandatory MCP tool missing: ${requiredName}`);
    }
    const target = join(root, 'stdio.txt');
    const written = await client.callTool({ name: 'write_file', arguments: { path: target, content: 'over stdio\n' } });
    assert.equal(written.isError, undefined);
    assert.equal(readFileSync(target, 'utf8'), 'over stdio\n');
    const read = await client.callTool({ name: 'read_file', arguments: { path: target } });
    assert.match(body(read), /over stdio/);
    const process1 = await client.callTool({ name: 'start_process', arguments: { command: 'printf "stdio-process\\n"', timeout_ms: 2000 } });
    assert.match(body(process1), /stdio-process/);
  } finally {
    await client.close();
  }
});

test('runtime sends tools/list_changed when the dynamic CDP toolset appears and disappears', async () => {
  const port = await unusedPort();
  const endpoint = `http://127.0.0.1:${port}`;
  const changes = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, REMCP_CDP_URL: endpoint, REMCP_CAPABILITY_POLL_MS: '250' },
  });
  const client = new Client(
    { name: 'remcp-list-changed-test', version: '1.0.0' },
    {
      versionNegotiation:{ mode:'legacy' },
      listChanged: {
        tools: {
          autoRefresh: true,
          debounceMs: 0,
          onChanged(error, tools) {
            changes.push({ error, tools });
          },
        },
      },
    },
  );
  let server;
  await client.connect(transport);
  try {
    const initial = await client.listTools();
    assert.equal(initial.tools.some(tool => tool.name === 'browser_tabs'), false);

    server = http.createServer((request, response) => {
      if (request.url === '/json/version') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ Browser: 'Chrome/ReMCP-test' }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');

    assert.equal(await waitUntil(() => changes.some(change =>
      !change.error && Array.isArray(change.tools) && change.tools.some(tool => tool.name === 'browser_tabs')
    )), true, 'browser tools should appear after the CDP endpoint starts');
    assert.equal(changes.length, 1, 'a capability group appearing emits one batched tools/list_changed notification');

    await new Promise(resolve => server.close(resolve));
    server = null;
    const appearedAt = changes.findIndex(change => Array.isArray(change.tools) && change.tools.some(tool => tool.name === 'browser_tabs'));
    assert.equal(await waitUntil(() => changes.slice(appearedAt + 1).some(change =>
      !change.error && Array.isArray(change.tools) && !change.tools.some(tool => tool.name === 'browser_tabs')
    )), true, 'browser tools should disappear after the CDP endpoint stops');
    assert.equal(changes.length, 2, 'a capability group disappearing emits one batched tools/list_changed notification');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await client.close();
  }
});

test('runtime negotiates MCP 2026-07-28 and delivers subscription-based tool changes', async () => {
  const port = await unusedPort();
  const endpoint = `http://127.0.0.1:${port}`;
  const changes = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, REMCP_CDP_URL: endpoint, REMCP_CAPABILITY_POLL_MS: '250' },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'remcp-modern-test', version: '1.0.0' },
    {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
      listChanged: {
        tools: {
          autoRefresh: true,
          debounceMs: 0,
          onChanged(error, tools) {
            changes.push({ error, tools });
          },
        },
      },
    },
  );
  let server;
  await client.connect(transport);
  try {
    const discover = client.getDiscoverResult();
    assert.deepEqual(discover?.supportedVersions, ['2026-07-28']);
    assert.equal(discover?.capabilities?.tools?.listChanged, true);

    const initial = await client.listTools();
    assert.equal(initial.cacheScope, 'private');
    assert.equal(initial.ttlMs, 1500);
    assert.equal(initial.tools.some(tool => tool.name === 'browser_tabs'), false);

    const environment = await client.callTool({ name: 'environment', arguments: {} });
    assert.equal(environment.isError, undefined);
    assert.equal(environment.structuredContent?.platform, process.platform);
    assert.equal(environment._meta?.['io.modelcontextprotocol/serverInfo']?.name, 'remcp-runtime');

    server = http.createServer((request, response) => {
      if (request.url === '/json/version') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ Browser: 'Chrome/ReMCP-modern-test' }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');

    assert.equal(await waitUntil(() => changes.some(change =>
      !change.error && Array.isArray(change.tools) && change.tools.some(tool => tool.name === 'browser_tabs')
    )), true, 'modern subscriptions/listen should receive browser tool appearance');

    await new Promise(resolve => server.close(resolve));
    server = null;
    const appearedAt = changes.findIndex(change => Array.isArray(change.tools) && change.tools.some(tool => tool.name === 'browser_tabs'));
    assert.equal(await waitUntil(() => changes.slice(appearedAt + 1).some(change =>
      !change.error && Array.isArray(change.tools) && !change.tools.some(tool => tool.name === 'browser_tabs')
    )), true, 'modern subscriptions/listen should receive browser tool disappearance');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await client.close();
  }
});

test('--print-tools and --describe expose contract metadata', async () => {
  const { stdout: toolsOut } = await run(process.execPath, [entry, '--print-tools']);
  const tools = JSON.parse(toolsOut);
  assert.ok(tools.length >= 23, `expected the expanded tool surface, saw ${tools.length}`);
  for (const tool of tools) assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
  const { stdout: describeOut } = await run(process.execPath, [entry, '--describe']);
  const described = JSON.parse(describeOut);
  assert.equal(described.tools, tools.length);
  assert.equal(described.allowedRoots.length, 0);
  assert.equal(described.configFile.endsWith('runtime.json'), true);
  assert.equal(described.telemetryEnabled, true, 'usage metrics are opt-out, so they start on');
  assert.equal(described.telemetryTransport, 'paired-agent-only');
  assert.equal(described.dangerousCommands, 'block', 'the destructive-command guardrail blocks catastrophic commands by default');
});

test('contract metadata works from a bare package with no node_modules', async () => {
  // CI diffs the advertised contract against the published tarball, which has no
  // dependencies installed. If the entry point imported the MCP SDK eagerly, that check
  // would silently stop being able to run.
  const bare = mkdtempSync(join(tmpdir(), 'remcp-runtime-bare-'));
  cpSync(path.resolve('src'), join(bare, 'src'), { recursive: true });
  cpSync('package.json', join(bare, 'package.json'));
  try {
    const { stdout } = await run(process.execPath, [join(bare, 'src/index.mjs'), '--print-tools']);
    const tools = JSON.parse(stdout);
    assert.ok(tools.length >= 23);
    const { stdout: described } = await run(process.execPath, [join(bare, 'src/index.mjs'), '--describe']);
    assert.equal(JSON.parse(described).tools, tools.length);
    const { stdout: version } = await run(process.execPath, [join(bare, 'src/index.mjs'), '--version']);
    assert.match(version.trim(), /^\d+\.\d+\.\d+$/);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});
