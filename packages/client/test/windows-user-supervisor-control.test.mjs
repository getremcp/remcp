import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { windowsSupervisorPath } from '../src/cli/windows-user-supervisor.mjs';

const supervisorScript = path.resolve('src/cli/windows-user-supervisor.mjs');
const arm64Vm = process.platform === 'win32' && process.arch === 'arm64';

function control(env, action) {
  return spawnSync(process.execPath, [supervisorScript, 'control', action], {
    env, encoding:'utf8', timeout:arm64Vm ? 30000 : 16000,
  });
}

async function waitUntil(predicate, deadlineMs = arm64Vm ? 65000 : 20000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Expected supervisor state was not reached');
}

test('user supervisor has one owner, authenticated control, deferred restart, and exact-child stop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remcp-control-e2e-'));
  const config = path.join(root, 'config');
  const cli = path.join(root, 'fake-installed-agent.mjs');
  const launches = path.join(root, 'launches.txt');
  fs.mkdirSync(config, { recursive:true });
  fs.writeFileSync(cli, [
    "import fs from 'node:fs';",
    "fs.appendFileSync(process.env.REMCP_TEST_LAUNCHES, String(process.pid) + '\\n');",
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => {}, 1000);",
  ].join('\n'));
  const env = { ...process.env, REMCP_CONFIG_DIR:config, REMCP_TEST_LAUNCHES:launches };
  const processA = spawn(process.execPath, [supervisorScript, 'serve', cli], {
    env, stdio:['ignore','pipe','pipe'],
  });
  let stderr = '';
  processA.stderr.on('data', d => { stderr += d.toString('utf8'); });
  try {
    await waitUntil(() => {
      const state = control(env, 'status');
      if (state.status !== 0) return false;
      return JSON.parse(state.stdout).running;
    });

    const first = JSON.parse(control(env, 'status').stdout);
    assert.ok(first.childPid > 0);
    assert.ok(fs.existsSync(path.join(config, 'windows-startup-control.key')));

    // The OS-held pipe prevents a second supervisor from launching an extra agent.
    const duplicate = spawnSync(process.execPath, [supervisorScript, 'serve', cli],
      { env, encoding:'utf8', timeout:arm64Vm ? 18000 : 5000 });
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.equal(fs.readFileSync(launches, 'utf8').trim().split('\n').length, 1);

    // An untrusted caller cannot trigger stop/restart even when the pipe is known.
    const rejected = await new Promise((resolve, reject) => {
      const socket = net.createConnection(windowsSupervisorPath(config));
      let output = '';
      socket.on('connect', () => socket.write(JSON.stringify({
        action:'stop', nonce:'a'.repeat(32), mac:'0'.repeat(64),
      }) + '\n'));
      socket.on('data', chunk => { output += chunk; });
      socket.on('end', () => resolve(JSON.parse(output)));
      socket.on('error', reject);
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /Unauthorized/);
    assert.equal(JSON.parse(control(env, 'status').stdout).childPid, first.childPid);

    const response = control(env, 'restart');
    assert.equal(response.status, 0, response.stderr);
    assert.equal(JSON.parse(response.stdout).restartScheduled, true);
    assert.equal(JSON.parse(control(env, 'status').stdout).childPid, first.childPid,
      'restart must not terminate its own updater synchronously');
    const second = await waitUntil(() => {
      const status = control(env, 'status');
      if (status.status !== 0) return false;
      const state = JSON.parse(status.stdout);
      return state.running && state.childPid !== first.childPid ? state : false;
    }, arm64Vm ? 65000 : 25000);
    assert.ok(second.childPid > 0);
    await waitUntil(() => fs.readFileSync(launches, 'utf8').trim().split('\n').length === 2);

    const stopped = control(env, 'stop');
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(JSON.parse(stopped.stdout).stopped, true);
    await Promise.race([
      once(processA, 'exit'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Supervisor failed to exit')), arm64Vm ? 12000 : 3000)),
    ]);
    assert.equal(control(env, 'status').status, 1,
      'stopped supervisor cannot report the child as running');
  } finally {
    if (processA.exitCode === null) processA.kill('SIGTERM');
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('supervisor does not accept arbitrary commands or weak local keys', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remcp-control-negative-'));
  const env = { ...process.env, REMCP_CONFIG_DIR:root };
  try {
    assert.equal(control(env, 'delete-other-processes').status, 1);
    fs.writeFileSync(path.join(root, 'windows-startup-control.key'), 'invalid');
    const attempted = control(env, 'stop');
    assert.notEqual(attempted.status, 0);
    assert.match(attempted.stderr, /Invalid supervisor key/);
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
});


test('an unexpected supervisor death disconnects its owned agent IPC instead of orphaning it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remcp-control-orphan-'));
  const config = path.join(root, 'config');
  const cli = path.join(root, 'fake-agent.mjs');
  const marker = path.join(root, 'disconnected');
  fs.mkdirSync(config, { recursive:true });
  fs.writeFileSync(cli, [
    "import fs from 'node:fs';",
    "process.on('disconnect', () => { fs.writeFileSync(process.env.REMCP_TEST_DISCONNECTED, 'yes'); process.exit(0); });",
    "setInterval(() => {}, 1000);",
  ].join('\n'));
  const env = { ...process.env, REMCP_CONFIG_DIR:config, REMCP_TEST_DISCONNECTED:marker };
  const owner = spawn(process.execPath, [supervisorScript, 'serve', cli], {
    env, stdio:['ignore','pipe','pipe'],
  });
  try {
    const ready = await waitUntil(() => {
      const s = control(env, 'status');
      if (s.status !== 0) return false;
      const state = JSON.parse(s.stdout);
      return state.running && state.childPid > 0 ? state : false;
    });
    const alive = () => {
      try { process.kill(ready.childPid, 0); return true; }
      catch (error) { if (error?.code === 'ESRCH') return false; throw error; }
    };
    owner.kill('SIGKILL');
    await Promise.race([
      once(owner, 'exit'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Supervisor did not die')), arm64Vm ? 12000 : 3000)),
    ]);
    // Windows may tear down a job process before its Node IPC disconnect handler
    // can write the optional marker. Process liveness is the actual safety invariant:
    // no orphaned agent may remain after the supervisor exits unexpectedly.
    try { await waitUntil(() => !alive(), arm64Vm ? 18000 : 7500); }
    catch { throw new Error(`Orphan agent still running after owner death: pid=${ready.childPid}, disconnectMarker=${fs.existsSync(marker)}`); }
    // The marker is diagnostic only: the child can exit before its buffered
    // Windows file write has become visible. The OS PID liveness check above
    // is the invariant that prevents orphaned agents.
  } finally {
    if (owner.exitCode === null) owner.kill('SIGKILL');
    try { fs.unlinkSync(windowsSupervisorPath(config)); } catch {}
    // Windows may briefly retain a handle to the just-closed named pipe after
    // process liveness is already false. Do not mistake delayed file cleanup
    // for an orphaned process; retry only this disposable test directory.
    fs.rmSync(root, { recursive:true, force:true, maxRetries:20, retryDelay:100 });
  }
});
