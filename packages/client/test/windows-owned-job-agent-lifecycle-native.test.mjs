import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnWindowsOwnedJob } from '../src/cli/windows-owned-job.mjs';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const lifecycleUrl = pathToFileURL(path.join(thisDir, '..', 'src', 'cli',
  'supervised-agent-lifecycle.mjs')).href;

async function waitFor(file, timeoutMs = 35000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('Owned agent did not signal readiness');
}

test('real Windows owned-job agent stays alive with no IPC and stops with owner', {
  skip:process.platform !== 'win32', timeout:100000,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remcp-lifecycle-job-'));
  const ready = path.join(dir, 'ready.json'), stopped = path.join(dir, 'stopped');
  const script = path.join(dir, 'agent.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
import { guardSupervisorDisconnect } from ${JSON.stringify(lifecycleUrl)};
const armed = guardSupervisorDisconnect({
  stop: () => { fs.writeFileSync(${JSON.stringify(stopped)}, 'unexpected'); },
});
fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({
  armed, hasSend:typeof process.send==='function', pid:process.pid,
}));
setInterval(() => {}, 1000);`);
  const owner = spawnWindowsOwnedJob(process.execPath, [script], {
    cwd:dir, log:path.join(dir, 'agent.log'),
  });
  try {
    await owner.ownedJob.ready;
    await waitFor(ready);
    const state = JSON.parse(fs.readFileSync(ready, 'utf8'));
    assert.equal(state.armed, false);
    assert.equal(state.hasSend, false);
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(owner.ownedJob.running, true, 'Job Object must retain its live agent');
    assert.equal(fs.existsSync(stopped), false);
    process.kill(state.pid, 0);
    await owner.ownedJob.stop();
    assert.equal(owner.ownedJob.confirmedEmpty, true);
  } finally {
    if (!owner.ownedJob.confirmedEmpty && owner.exitCode === null) owner.kill();
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.rmSync(dir, { recursive:true, force:true, maxRetries:20, retryDelay:100 });
  }
});
