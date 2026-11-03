import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const moduleUrl = new URL('../src/cli/windows-update-lock.mjs', import.meta.url);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remcp-win-update-lock-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  return dir;
}

test('a second Windows update cannot enter a prefix while its first owner is installing', async t => {
  const prefix = fixture(t);
  const release = path.join(prefix, 'release-signal');
  t.after(() => { if (fs.existsSync(prefix)) fs.writeFileSync(release, 'release'); });
  const code = `import fs from 'node:fs';
import { withWindowsUpdateLock } from ${JSON.stringify(moduleUrl.href)};
withWindowsUpdateLock(${JSON.stringify(prefix)}, () => {
  process.stdout.write('LOCKED\\n');
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 1500 && !fs.existsSync(${JSON.stringify(release)}); i++) {
    Atomics.wait(sleep, 0, 0, 20);
  }
});`;
  const first = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio:['ignore','pipe','pipe'] });
  t.after(() => { if (first.exitCode === null) first.kill(); });
  await new Promise((resolve,reject) => {
    let all = '';
    first.stdout.on('data', chunk => { all += chunk; if (all.includes('LOCKED')) resolve(); });
    first.once('error', reject);
    first.once('exit', code => reject(new Error(`first installer exited before lock: ${code}`)));
  });
  const second = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { withWindowsUpdateLock } from ${JSON.stringify(moduleUrl.href)};
withWindowsUpdateLock(${JSON.stringify(prefix)}, () => { process.stdout.write('UNSAFE_INSTALL'); });`],
  { encoding:'utf8', timeout:8000 });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /update already in progress/i);
  assert.doesNotMatch(second.stdout, /UNSAFE_INSTALL/);
  fs.writeFileSync(release, 'release');
  await new Promise((resolve,reject) => { first.once('exit', code => code === 0 ? resolve() : reject(new Error(String(code)))); });
  const third = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { withWindowsUpdateLock } from ${JSON.stringify(moduleUrl.href)};
withWindowsUpdateLock(${JSON.stringify(prefix)}, () => { process.stdout.write('AFTER_RELEASE'); });`],
  { encoding:'utf8', timeout:5000 });
  assert.equal(third.status, 0, third.stderr);
  assert.match(third.stdout, /AFTER_RELEASE/);
  assert.equal(fs.existsSync(path.join(prefix, '.remcp-update-lock')), false);
});

test('failed Windows transaction releases its update lock for retry', async t => {
  const prefix = fixture(t);
  const { withWindowsUpdateLock } = await import(moduleUrl.href);
  assert.throws(() => withWindowsUpdateLock(prefix, () => { throw new Error('npm failed'); }), /npm failed/);
  assert.equal(withWindowsUpdateLock(prefix, () => 'retry-ok'), 'retry-ok');
  assert.equal(fs.existsSync(path.join(prefix, '.remcp-update-lock')), false);
});

test('unknown or still-live lock owner blocks rather than deleting someone else\'s lock', async t => {
  const prefix = fixture(t);
  const lockPath = path.join(prefix, '.remcp-update-lock');
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid:process.pid, token:'live-owner' }));
  const { withWindowsUpdateLock } = await import(moduleUrl.href);
  assert.throws(() => withWindowsUpdateLock(prefix, () => assert.fail('entered')), /update already in progress/i);
  assert.equal(fs.existsSync(lockPath), true);
});

test('Windows install and update both refuse a competing transaction before moving shims', async t => {
  if (process.platform === 'win32') return t.skip('POSIX fake npm is only for the cross-platform Windows simulation');
  const root = fixture(t);
  const prefix = path.join(root, 'Local', 'ReMCP', 'runtime');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(prefix, { recursive:true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(prefix, 'remcp.cmd'), 'original cmd shim');
  const installTouched = path.join(root, 'install-touched');
  const npmStub = path.join(bin, 'npm');
  fs.writeFileSync(npmStub, `#!/bin/sh
if [ "$1" = "prefix" ]; then printf "%s\\n" "$REMCP_TEST_PREFIX"; exit 0; fi
touch "$REMCP_TEST_INSTALL_TOUCHED"
exit 0
`, { mode:0o700 });
  const { withWindowsUpdateLock } = await import(moduleUrl.href);
  const updateCode = `import { npmGlobalUpdate } from './src/cli/npm-global.mjs';
npmGlobalUpdate(['@remcp/remcp', '@remcp/runtime'], '@remcp/remcp@9.9.9', '@remcp/runtime@9.9.9');`;
  const installCode = `import { npmGlobalInstall } from './src/cli/npm-global.mjs';
npmGlobalInstall('@remcp/remcp@9.9.9', '@remcp/runtime@9.9.9');`;
  withWindowsUpdateLock(prefix, () => {
    for (const code of [updateCode, installCode]) {
    const attempt = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd:path.resolve('.'), encoding:'utf8', timeout:5000,
      env:{ ...process.env, NODE_ENV:'test', REMCP_TEST_PLATFORM:'win32',
        LOCALAPPDATA:path.join(root, 'Local'), REMCP_NPM:npmStub,
        REMCP_TEST_PREFIX:prefix, REMCP_TEST_INSTALL_TOUCHED:installTouched },
    });
    assert.notEqual(attempt.status, 0);
    assert.match(attempt.stderr, /update already in progress/);
    assert.equal(fs.existsSync(installTouched), false);
    assert.equal(fs.readFileSync(path.join(prefix, 'remcp.cmd'), 'utf8'), 'original cmd shim');
    }
  });
});
