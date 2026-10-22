import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { body, freshWorkspace, isError, waitFor } from './helpers.mjs';

freshWorkspace('system');
const { invokeTool } = await import('../src/invoke.mjs');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('list_processes reports running processes', async () => {
  const result = await invokeTool('list_processes', { limit: 1000 });
  assert.equal(isError(result), false);
  const output = body(result);
  assert.match(output, /pid,ppid,cpu%,mem%,elapsed,command/);
  assert.match(output, new RegExp(`\\b${process.pid}\\b`));
});

test('list_processes masks secret-looking command arguments', { skip: process.platform === 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)', '--token=supersecret-value'], { stdio: 'ignore' });
  try {
    await waitFor(async () => body(await invokeTool('list_processes', { limit: 1000 })).includes(`--token=`), 4000);
    const output = body(await invokeTool('list_processes', { limit: 1000 }));
    assert.doesNotMatch(output, /supersecret-value/);
  } finally {
    child.kill('SIGKILL');
  }
});

test('kill_process refuses protected pids', async () => {
  assert.equal(isError(await invokeTool('kill_process', { pid: 1 })), true);
  assert.equal(isError(await invokeTool('kill_process', { pid: process.pid })), true);
});

test('kill_process terminates another process', { skip: process.platform === 'win32' }, async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  assert.equal(await waitFor(async () => alive(child.pid)), true);
  assert.equal(isError(await invokeTool('kill_process', { pid: child.pid })), false);
  assert.equal(await waitFor(async () => !alive(child.pid), 5000), true);
});

test('get_system_info reports bounded host CPU utilization and measured frequency', async () => {
  const result = await invokeTool('get_system_info', {});
  assert.equal(isError(result), false);
  const system = JSON.parse(body(result));
  assert.ok(system.cpu.count > 0);
  if (system.cpu.utilizationRatio !== null) {
    assert.ok(system.cpu.utilizationRatio >= 0 && system.cpu.utilizationRatio <= 1);
  }
  if (system.cpu.frequencyMHz !== null) {
    assert.ok(system.cpu.frequencyMHz > 0 && system.cpu.frequencyMHz <= 100000);
  }
});
