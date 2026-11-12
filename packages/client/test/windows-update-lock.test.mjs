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

test('an asynchronous update holds its exclusive lock until resolution or rejection', async t => {
  const prefix = fixture(t);
  const lockPath = path.join(prefix, '.remcp-update-lock');
  const { withWindowsUpdateLock } = await import(moduleUrl.href);
  let finish;
  const pending = withWindowsUpdateLock(prefix, () => new Promise(resolve => { finish = resolve; }));
  assert.equal(fs.existsSync(lockPath), true, 'lock must outlive an unresolved install');
  assert.throws(() => withWindowsUpdateLock(prefix, () => 'unsafe'), /update already in progress/i);
  finish('installed');
  assert.equal(await pending, 'installed');
  assert.equal(fs.existsSync(lockPath), false);

  let fail;
  const rejected = withWindowsUpdateLock(prefix, () => new Promise((_, reject) => { fail = reject; }));
  assert.equal(fs.existsSync(lockPath), true);
  fail(new Error('failed install'));
  await assert.rejects(rejected, /failed install/);
  assert.equal(fs.existsSync(lockPath), false, 'a failed async install must release its lock');
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

function runManualUpdate(t, { task = 'PRESENT', status = 0, check = false, current = false, repair = false, noRestart = false, npmSuccess = false, missingRuntime = false } = {}) {
  const root = fixture(t);
  const prefix = path.join(root, 'prefix');
  const config = path.join(root, 'config');
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
  const target = current ? version : '9.9.9';
  fs.mkdirSync(config, { recursive:true });
  for (const layout of ['node_modules', path.join('lib', 'node_modules')]) {
    for (const name of ['remcp', 'runtime']) {
      const dir = path.join(prefix, layout, '@remcp', name);
      fs.mkdirSync(dir, { recursive:true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
      const entry = path.join(dir, name === 'remcp' ? 'bin/remcp.mjs' : 'src/index.mjs');
      fs.mkdirSync(path.dirname(entry), { recursive:true });
      if (name !== 'runtime' || !missingRuntime) fs.writeFileSync(entry, '// fixture');
    }
  }
  fs.writeFileSync(path.join(prefix, 'remcp.cmd'), 'original fixture shim');
  fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({
    configSchemaVersion:1, serverUrl:'https://remcp.site', deviceId:'fixture-device',
    deviceToken:'fixture-only-token', serviceInstalled:false, trustRuntime:true,
    runtime:{kind:'npm',packageName:'@remcp/runtime',packageSpec:`@remcp/runtime@${version}`,entry:'src/index.mjs'},
  }));
  const script = `import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const prefix = ${JSON.stringify(prefix)};
const result = { npmMutations:0, packageWrites:0, taskQueries:0, taskChanges:0, error:null };
// Intercept every child command: the fixture must never invoke real npm or OS services,
// including on a native Windows/macOS host. Package writes are observed separately.
cp.spawnSync = (command, args=[]) => {
  if (command === 'qa-npm' && args[0] === 'prefix') return {status:0,stdout:prefix};
  if (command === 'qa-npm' && args[0] === 'install') {
    result.npmMutations++;
    return ${npmSuccess ? "{status:0,stdout:''}" : "{status:1,error:new Error('QA_NPM_MUTATION_BOUNDARY')}"};
  }
  if (command === 'powershell.exe') {
    result.taskQueries++;
    return {status:${status},stdout:${JSON.stringify(task)},stderr:''};
  }
  if (command === 'schtasks.exe') result.taskChanges++;
  throw new Error('Unexpected fixture command: '+command);
};
for (const name of ['writeFileSync','renameSync','mkdirSync','rmSync','unlinkSync']) {
  const original=fs[name];
  fs[name]=(...args)=>{
    if (args.slice(0,name==='renameSync'?2:1).some(value=>typeof value==='string' &&
        (value===prefix || value.startsWith(prefix+path.sep)))) result.packageWrites++;
    return original(...args);
  };
}
syncBuiltinESMExports();
const { updateCommand } = await import(${JSON.stringify(new URL('../src/cli/update.mjs', import.meta.url).href)});
try { await updateCommand({client:'@remcp/remcp@${target}',runtime:'@remcp/runtime@${target}',check:${check},repair:${repair},'no-restart':${noRestart}}); }
catch(error) { result.error=error.message; }
process.stdout.write('QA_RESULT:'+JSON.stringify(result)+'\\n');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding:'utf8', timeout:15000,
    env:{...process.env, NODE_ENV:'test', REMCP_TEST_PLATFORM:'win32', REMCP_NPM:'qa-npm',
      HOME:root, USERPROFILE:root, APPDATA:path.join(root,'Roaming'), LOCALAPPDATA:path.join(root,'Local'),
      REMCP_CONFIG_DIR:config, NPM_CONFIG_PREFIX:prefix},
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const line=child.stdout.split(/\r?\n/).find(value=>value.startsWith('QA_RESULT:'));
  assert.ok(line, child.stdout);
  assert.equal(fs.readFileSync(path.join(prefix,'remcp.cmd'),'utf8'), 'original fixture shim');
  return JSON.parse(line.slice('QA_RESULT:'.length));
}

test('Windows manual update checks legacy task ownership despite serviceInstalled:false', t => {
  const result=runManualUpdate(t);
  assert.match(result.error, /legacy ReMCP Scheduled Task exists/);
  assert.equal(result.taskQueries, 1);
  assert.equal(result.npmMutations, 0);
  assert.equal(result.packageWrites, 0);
  assert.equal(result.taskChanges, 0);
});

for (const scenario of [{task:'',status:5}, {task:'UNKNOWN',status:0}]) {
  test(`Windows manual update refuses uncertain task state (${scenario.status}/${scenario.task})`, t => {
    const result=runManualUpdate(t,scenario);
    assert.match(result.error, /Could not verify the legacy ReMCP Scheduled Task/);
    assert.equal(result.npmMutations, 0);
    assert.equal(result.packageWrites, 0);
    assert.equal(result.taskChanges, 0);
  });
}

test('Windows manual update without a legacy task reaches the isolated npm boundary', t => {
  const result=runManualUpdate(t,{task:'ABSENT'});
  assert.equal(result.taskQueries, 1);
  assert.equal(result.npmMutations, 1);
  assert.equal(result.error, 'QA_NPM_MUTATION_BOUNDARY');
  assert.equal(result.taskChanges, 0);
});

for (const scenario of [{check:true},{current:true}]) {
  test(`Windows ${scenario.check?'update --check':'already-current update'} remains read-only`, t => {
    const result=runManualUpdate(t,scenario);
    assert.equal(result.error, null);
    assert.equal(result.taskQueries, 0);
    assert.equal(result.npmMutations, 0);
    assert.equal(result.packageWrites, 0);
    assert.equal(result.taskChanges, 0);
  });
}

test('explicit repair reinstalls an unchanged release without starting the bridge', t => {
  const result = runManualUpdate(t, { task:'ABSENT', current:true, repair:true, noRestart:true, npmSuccess:true });
  assert.equal(result.error, null);
  assert.equal(result.npmMutations, 1);
  assert.equal(result.taskQueries, 1, 'lifecycle is checked before mutation; no restart follows');
  assert.equal(result.taskChanges, 0);
});

test('fresh CLI fallback inspects global payload rather than its intentional runtime-free cache', t => {
  const healthy = runManualUpdate(t, { current:true });
  assert.equal(healthy.error, null);
  assert.equal(healthy.npmMutations, 0);
  const quarantined = runManualUpdate(t, { current:true, missingRuntime:true });
  assert.match(quarantined.error, /files are missing despite matching versions/);
  assert.equal(quarantined.npmMutations, 0);
  assert.equal(quarantined.taskChanges, 0);
});
