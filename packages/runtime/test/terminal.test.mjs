import test from 'node:test';
import assert from 'node:assert/strict';
import { body, freshWorkspace, isError, waitFor } from './helpers.mjs';

freshWorkspace('terminal');
const { invokeTool } = await import('../src/invoke.mjs');

function pidOf(result) {
  const structuredPid = Number(result?.structuredContent?.pid);
  if (Number.isInteger(structuredPid) && structuredPid > 0) return structuredPid;
  const match = body(result).match(/Process (\d+)/);
  assert.ok(match, `expected a pid in ${body(result)}`);
  return Number(match[1]);
}

test('start_process runs a command and returns its output', async () => {
  const result = await invokeTool('start_process', { command: 'printf "hello-from-runtime\\n"', timeout_ms: 3000 });
  assert.equal(isError(result), false);
  assert.match(body(result), /hello-from-runtime/);
  assert.match(body(result), /finished with code 0/);
  assert.equal(typeof result.structuredContent?.pid, 'number');
  assert.equal(result.structuredContent?.status, 'exited (code 0)');
  assert.equal(result.structuredContent?.exitCode, 0);
  assert.equal(result.structuredContent?.exited, true);
  assert.match(result.structuredContent?.output || '', /hello-from-runtime/);
});

test('start_process returns early on initial output from a long-running command', async () => {
  const startedAt = Date.now();
  const result = await invokeTool('start_process', {
    command: 'printf "READY-EARLY\\n"; sleep 3',
    timeout_ms: 1600,
  });
  const elapsed = Date.now() - startedAt;
  const pid = pidOf(result);
  try {
    assert.equal(isError(result), false);
    assert.match(body(result), /READY-EARLY/);
    assert.equal(result.structuredContent?.exited, false);
    assert.ok(elapsed < 1200, `initial output returned after ${elapsed}ms instead of early`);
  } finally {
    await invokeTool('force_terminate', { pid });
  }
});

test('start_process returns after delayed output rather than waiting for process exit', async () => {
  const startedAt = Date.now();
  const result = await invokeTool('start_process', {
    command: 'sleep 0.3; printf "READY-DELAYED\\n"; sleep 3',
    timeout_ms: 1800,
  });
  const elapsed = Date.now() - startedAt;
  const pid = pidOf(result);
  try {
    assert.match(body(result), /READY-DELAYED/);
    assert.equal(result.structuredContent?.exited, false);
    assert.ok(elapsed < 1300, `delayed output returned after ${elapsed}ms`);
  } finally {
    await invokeTool('force_terminate', { pid });
  }
});

test('start_process still reports the final code for immediately exiting commands', async () => {
  const result = await invokeTool('start_process', {
    command: 'printf "FAST-EXIT\\n"; exit 3',
    timeout_ms: 1600,
  });
  assert.equal(result.structuredContent?.exited, true);
  assert.equal(result.structuredContent?.exitCode, 3);
  assert.match(body(result), /FAST-EXIT/);
});

test('read_process_output returns new output and supports tail offsets', async () => {
  const started = await invokeTool('start_process', { command: 'for i in 1 2 3; do echo line-$i; sleep 0.4; done', timeout_ms: 200 });
  const pid = pidOf(started);
  await waitFor(async () => body(await invokeTool('read_process_output', { pid })).includes('line-3'), 8000);
  const tailResult = await invokeTool('read_process_output', { pid, offset: -2 });
  const tail = body(tailResult);
  assert.match(tail, /line-2/);
  assert.match(tail, /line-3/);
  assert.equal(tailResult.structuredContent?.pid, pid);
  assert.equal(tailResult.structuredContent?.explicitOffset, true);
  assert.match(tailResult.structuredContent?.range || '', /of 3/);
  assert.match(tailResult.structuredContent?.output || '', /line-3/);
});

test('cursor-consuming output tools do not advertise idempotent retries', async () => {
  const { toolDefinitions } = await import('../src/catalog.mjs');
  for (const name of ['read_process_output', 'wait_for_process_output']) {
    const tool = toolDefinitions.find(tool => tool.name === name);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.idempotentHint, false);
  }
  const started = await invokeTool('start_process', { command: 'sleep 0.3; echo cursor-marker', timeout_ms: 1 });
  const pid = pidOf(started);
  const first = body(await invokeTool('read_process_output', { pid, timeout_ms: 8000 }));
  assert.match(first, /cursor-marker/);
  const retry = body(await invokeTool('read_process_output', { pid }));
  assert.doesNotMatch(retry, /cursor-marker/, 'the same arguments cannot replay consumed output');
});

test('interact_with_process sends input and list_sessions reports the session', async () => {
  const started = await invokeTool('start_process', { command: 'node -e "process.stdin.on(\'data\', d => process.stdout.write(\'echo:\' + d.toString()))"', timeout_ms: 300 });
  const pid = pidOf(started);
  const responseResult = await invokeTool('interact_with_process', { pid, input: 'ping', timeout_ms: 2000 });
  const response = body(responseResult);
  assert.match(response, /echo:ping/);
  assert.equal(responseResult.structuredContent?.pid, pid);
  assert.match(responseResult.structuredContent?.output || '', /echo:ping/);
  const sessionsResult = await invokeTool('list_sessions', {});
  assert.match(body(sessionsResult), new RegExp(`pid ${pid}`));
  assert.equal(sessionsResult.structuredContent?.sessions?.some(session => session.pid === pid), true);
  assert.equal(isError(await invokeTool('force_terminate', { pid })), false);
});

test('unknown pids are rejected instead of starting new work', async () => {
  assert.equal(isError(await invokeTool('read_process_output', { pid: 999999 })), true);
  assert.equal(isError(await invokeTool('force_terminate', { pid: 999999 })), true);
  assert.equal(isError(await invokeTool('interact_with_process', { pid: 999999, input: 'x' })), true);
  assert.equal(isError(await invokeTool('wait_for_process_output', { pid: 999999, pattern: 'x' })), true);
});

test('read_process_output positive offsets are zero-based line numbers', async () => {
  const started = await invokeTool('start_process', { command: 'printf "l1\\nl2\\nl3\\nl4\\n"', timeout_ms: 3000 });
  const pid = pidOf(started);
  const page = body(await invokeTool('read_process_output', { pid, offset: 1, length: 2 }));
  assert.match(page, /l2/);
  assert.match(page, /l3/);
  assert.doesNotMatch(page, /l1/);
  assert.match(page, /of 4/);
  const first = body(await invokeTool('read_process_output', { pid, offset: 0, length: 1 }));
  assert.match(first, /l1/);
});

test('wait_for_process_output matches initial start output once from the retained buffer', async () => {
  const started = await invokeTool('start_process', { command: 'printf "BUFFERED-READY\\n"; sleep 5', timeout_ms: 300 });
  const pid = pidOf(started);
  assert.match(body(started), /BUFFERED-READY/);

  const before = Date.now();
  const first = await invokeTool('wait_for_process_output', { pid, pattern: 'BUFFERED-READY', timeout_ms: 2000 });
  assert.equal(isError(first), false);
  assert.equal(first.structuredContent?.matched, true);
  assert.equal(first.structuredContent?.bufferedMatch, true);
  assert.match(first.structuredContent?.output || '', /BUFFERED-READY/);
  assert.ok(Date.now() - before < 500, 'a buffered match should return without waiting for the timeout');

  const retry = await invokeTool('wait_for_process_output', { pid, pattern: 'BUFFERED-READY', timeout_ms: 100 });
  assert.equal(retry.structuredContent?.matched, false, 'the same retained match must not replay after the wait cursor advances');
  assert.equal(retry.structuredContent?.bufferedMatch, false);
  await invokeTool('force_terminate', { pid });
});

test('read_process_output consumption also advances the wait watermark', async () => {
  const started = await invokeTool('start_process', { command: 'printf "READ-CONSUMED\\n"; sleep 5', timeout_ms: 300 });
  const pid = pidOf(started);
  assert.match(body(started), /READ-CONSUMED/);
  await invokeTool('read_process_output', { pid, timeout_ms: 0 });
  const waited = await invokeTool('wait_for_process_output', { pid, pattern: 'READ-CONSUMED', timeout_ms: 100 });
  assert.equal(waited.structuredContent?.matched, false);
  assert.equal(waited.structuredContent?.bufferedMatch, false);
  await invokeTool('force_terminate', { pid });
});

test('wait_for_process_output returns as soon as the pattern appears', async () => {
  const started = await invokeTool('start_process', { command: 'sleep 0.6; echo READY-MARKER; sleep 5', timeout_ms: 100 });
  const pid = pidOf(started);
  const result = await invokeTool('wait_for_process_output', { pid, pattern: 'READY-MARKER', timeout_ms: 8000 });
  assert.equal(isError(result), false);
  assert.match(body(result), /pattern matched/);
  assert.match(body(result), /READY-MARKER/);
  assert.equal(result.structuredContent?.pid, pid);
  assert.equal(result.structuredContent?.matched, true);
  assert.match(result.structuredContent?.output || '', /READY-MARKER/);
  await invokeTool('force_terminate', { pid });
});

test('wait_for_process_output reports a timeout without failing the call', async () => {
  const started = await invokeTool('start_process', { command: 'sleep 3', timeout_ms: 100 });
  const pid = pidOf(started);
  const result = await invokeTool('wait_for_process_output', { pid, pattern: 'NEVER-APPEARS', timeout_ms: 300 });
  assert.equal(isError(result), false);
  assert.match(body(result), /pattern not matched/);
  await invokeTool('force_terminate', { pid });
});
