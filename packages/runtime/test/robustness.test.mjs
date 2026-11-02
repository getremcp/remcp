import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { body, freshWorkspace, isError } from './helpers.mjs';
import { portableCommand } from './fixtures/portable-command.mjs';
import { globToRegExp } from '../src/util.mjs';

const run = promisify(execFile);
const entry = path.resolve('src/index.mjs');
const workspace = freshWorkspace('robustness');
const { invokeTool } = await import('../src/invoke.mjs');

async function withRuntime(env, fn) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env, ...env } });
  const client = new Client({ name: 'robustness-test', version: '1.0.0' }, { versionNegotiation:{ mode:'legacy' } });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

test('a bogus shell reports an error instead of killing the runtime', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'remcp-bad-shell-'));
  try {
    await withRuntime({ REMCP_RUNTIME_CONFIG_DIR: join(isolated, 'config'), REMCP_RUNTIME_SHELL: '/nonexistent-shell-xyz' }, async client => {
      const failed = await client.callTool({ name: 'start_process', arguments: { command: 'echo hi', timeout_ms: 200 } });
      assert.equal(failed.isError, true);
      // The process must still answer after the failure.
      const alive = await client.callTool({ name: 'get_runtime_stats', arguments: {} });
      assert.equal(alive.isError, undefined);
      assert.ok(JSON.parse(body(alive)).counters.toolCalls >= 1);
    });
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});

test('an unreadable runtime.json stops the device loudly instead of silently dropping confinement', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'remcp-bad-config-'));
  const configDir = join(isolated, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'runtime.json'), '{\n  "allowedRoots": ["/srv"],\n}\n'); // trailing comma
  try {
    const failure = await run(process.execPath, [entry], { env: { ...process.env, REMCP_RUNTIME_CONFIG_DIR: configDir } })
      .then(() => null, error => error);
    assert.ok(failure, 'the runtime must not start with an unreadable configuration');
    assert.equal(failure.code, 2);
    assert.match(String(failure.stderr), /refuses to start/);
    assert.match(String(failure.stderr), /not valid JSON/);

    // Metadata commands still work, so an operator can see what is wrong.
    const { stdout } = await run(process.execPath, [entry, '--describe'], { env: { ...process.env, REMCP_RUNTIME_CONFIG_DIR: configDir } });
    const described = JSON.parse(stdout);
    assert.match(described.configError, /not valid JSON/);
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});

test('a stream with no newlines is bounded instead of growing until the runtime dies', async () => {
  const started = await invokeTool('start_process', { command: portableCommand('head -c 3000000 /dev/zero | tr "\\0" "x"', "process.stdout.write('x'.repeat(3000000))"), timeout_ms: 4000 });
  assert.equal(isError(started), false);
  assert.equal(typeof started.structuredContent?.pid, 'number', 'oversized output keeps the declared start_process structured shape');
  assert.equal(typeof started.structuredContent?.output, 'string');
  assert.equal(started.structuredContent?.truncated, undefined, 'terminal tools never fall back to the schema-agnostic truncation envelope');
  assert.ok(Buffer.byteLength(started.structuredContent.output, 'utf8') <= 128 * 1024);
  const pid = Number(body(started).match(/Process (\d+)/)[1]);
  const read = body(await invokeTool('read_process_output', { pid, offset: -1, length: 1 }));
  assert.match(read, /of \d+/);
  const sessions = body(await invokeTool('list_sessions', {}));
  assert.match(sessions, new RegExp(`pid ${pid}`));
  // The runtime is still healthy after a 3 MB single-line stream.
  assert.equal(isError(await invokeTool('get_runtime_stats', {})), false);
});

test('writing to a finished process returns an error instead of raising EPIPE', async () => {
  const started = await invokeTool('start_process', { command: portableCommand('true', "process.exit(0)"), timeout_ms: 2000 });
  const pid = Number(body(started).match(/Process (\d+)/)[1]);
  const result = await invokeTool('interact_with_process', { pid, input: 'hello', timeout_ms: 200 });
  assert.equal(isError(result), true);
  assert.match(body(result), /already exited|no longer accepts input/);
  assert.equal(isError(await invokeTool('get_runtime_stats', {})), false);
});

test('force_terminate stops the whole process tree', async () => {
  const started = await invokeTool('start_process', { command: portableCommand('sleep 30 | cat', "setTimeout(()=>{},30000)"), timeout_ms: 300 });
  const pid = Number(body(started).match(/Process (\d+)/)[1]);
  assert.equal(isError(await invokeTool('force_terminate', { pid })), false);
  const sessions = body(await invokeTool('list_sessions', {}));
  const row = sessions.split('\n').find(line => line.includes(`pid ${pid}`));
  assert.match(row, /exited/, 'the pipeline must be gone, not left running');
});

test('a cancelled call does not start work', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await invokeTool('start_process', { command: 'echo should-not-run' }, { signal: controller.signal });
  assert.equal(isError(result), true);
  assert.match(body(result), /cancelled/);
  void workspace;
});

test('glob translation honours classes, braces and single-character wildcards', () => {
  const match = (pattern, value) => globToRegExp(pattern).test(value);
  // A class and a brace set used to be escaped into literal text, so these patterns matched
  // nothing at all and looked like "no files found".
  assert.equal(match('*.{js,ts}', 'index.js'), true);
  assert.equal(match('*.{js,ts}', 'index.ts'), true);
  assert.equal(match('*.{js,ts}', 'index.md'), false);
  assert.equal(match('file[0-9].txt', 'file7.txt'), true);
  assert.equal(match('file[0-9].txt', 'filex.txt'), false);
  assert.equal(match('file[!0-9].txt', 'filex.txt'), true);
  // `?` matches exactly one character and never a separator.
  assert.equal(match('a?c', 'abc'), true);
  assert.equal(match('a?c', 'ac'), false);
  assert.equal(match('a?c', 'a/c'), false);
  // The recursive forms still work as before.
  assert.equal(match('**/*', 'top.txt'), true);
  assert.equal(match('**/*', 'deep/nested/top.txt'), true);
  assert.equal(match('src/*', 'src/a.txt'), true);
  assert.equal(match('src/*', 'src/deep/a.txt'), false);
});
