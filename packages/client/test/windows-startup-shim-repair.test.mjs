import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  repairManagedWindowsPowerShellShimOnStart,
  WINDOWS_NPM_CMD_SHIM,
  WINDOWS_NPM_POWERSHELL_SHIM,
} from '../src/cli/windows-cli-shim.mjs';

function fixture(t) {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'remcp-win-self-heal-'));
  t.after(() => fs.rmSync(localAppData, { recursive:true, force:true }));
  const prefix = path.join(localAppData, 'ReMCP', 'runtime');
  const nodePath = path.join(prefix, 'node.exe');
  const cliEntry = path.join(prefix, 'node_modules', '@remcp', 'remcp', 'bin', 'remcp.mjs');
  const batch = path.join(prefix, 'remcp.cmd');
  const powershell = path.join(prefix, 'remcp.ps1');
  fs.mkdirSync(path.dirname(cliEntry), { recursive:true });
  fs.writeFileSync(nodePath, 'test-interpreter');
  fs.writeFileSync(cliEntry, 'test-cli');
  fs.writeFileSync(batch, WINDOWS_NPM_CMD_SHIM.replaceAll('\n', '\r\n'));
  fs.writeFileSync(powershell, WINDOWS_NPM_POWERSHELL_SHIM.replaceAll('\n', '\r\n'));
  const invoke = (options={}) => repairManagedWindowsPowerShellShimOnStart({
    platform:'win32', localAppData, nodePath, cliEntry, ...options,
  });
  return { localAppData, prefix, nodePath, cliEntry, batch, powershell, invoke };
}

test('managed agent startup repairs old npm PowerShell shadow without touching the CMD launcher', t => {
  const x = fixture(t);
  const before = fs.readFileSync(x.batch, 'utf8');
  assert.equal(x.invoke(), true);
  assert.equal(fs.existsSync(x.powershell), false);
  assert.equal(fs.readFileSync(x.batch, 'utf8'), before);
  assert.equal(x.invoke(), false, 'repair is idempotent after a second agent startup');
});

test('only real Windows with an exact managed Node and CLI entry can repair', t => {
  const x = fixture(t);
  assert.equal(x.invoke({ platform:'darwin' }), false);
  assert.equal(x.invoke({ localAppData:undefined }), false);
  assert.equal(x.invoke({ nodePath:path.join(x.prefix,'other-node.exe') }), false);
  assert.equal(x.invoke({ cliEntry:path.join(x.prefix,'other-cli.mjs') }), false);
  assert.equal(x.invoke({ localAppData:path.dirname(x.localAppData) }), false);
  assert.equal(fs.existsSync(x.powershell), true);
});

test('auto-repair never destroys custom PowerShell content or an unrecognized batch file', t => {
  const x = fixture(t);
  const originalCmd = fs.readFileSync(x.batch,'utf8');
  fs.appendFileSync(x.powershell, 'Write-Output "USER CUSTOMIZATION"\r\n');
  assert.throws(() => x.invoke(), /non-npm/);
  assert.ok(fs.readFileSync(x.powershell,'utf8').includes('USER CUSTOMIZATION'));
  fs.writeFileSync(x.powershell, WINDOWS_NPM_POWERSHELL_SHIM);
  fs.writeFileSync(x.batch, originalCmd + '\r\necho user-controlled-command\r\n');
  assert.throws(() => x.invoke(), /unrecognized batch shim/);
  assert.equal(fs.readFileSync(x.batch,'utf8'), originalCmd + '\r\necho user-controlled-command\r\n');
  assert.equal(fs.existsSync(x.powershell), true);
});

test('missing CMD shim refuses repair and keeps the original PS1', t => {
  const x = fixture(t);
  fs.unlinkSync(x.batch);
  assert.throws(() => x.invoke(), /ENOENT/);
  assert.equal(fs.existsSync(x.powershell), true);
});

test('managed entry symlink cannot redirect startup repair outside the intended prefix', t => {
  const x = fixture(t);
  const outside = path.join(x.localAppData, 'unrelated.mjs');
  fs.writeFileSync(outside, 'unrelated file');
  fs.unlinkSync(x.cliEntry);
  try { fs.symlinkSync(outside, x.cliEntry); }
  catch (error) {
    if (['EPERM','EACCES','ENOTSUP'].includes(error?.code)) return t.skip('Symlinks unavailable');
    throw error;
  }
  assert.equal(x.invoke(), false);
  assert.equal(fs.existsSync(x.powershell), true);
  assert.equal(fs.readFileSync(outside,'utf8'), 'unrelated file');
});

test('npm shim reinstalled by an old updater is safely repaired again at subsequent startup', t => {
  const x = fixture(t);
  assert.equal(x.invoke(), true);
  fs.writeFileSync(x.powershell, WINDOWS_NPM_POWERSHELL_SHIM);
  assert.equal(x.invoke(), true);
  assert.equal(fs.existsSync(x.powershell), false);
});


test('production CLI invokes guarded shim repair only in the real Windows start path', () => {
  const entry = fs.readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  assert.match(entry, /if \(command === 'start'\) \{/);
  assert.match(entry, /if \(process\.platform === 'win32'\) \{\s*try \{ repairManagedWindowsPowerShellShimOnStart\(\); \}/);
  assert.doesNotMatch(entry.slice(0, entry.indexOf("if (command === '--version'")), /repairManagedWindowsPowerShellShimOnStart\(\)/);
});
