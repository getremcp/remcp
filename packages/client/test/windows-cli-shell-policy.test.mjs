import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertWindowsNpmPowerShellShimOwned, preferWindowsCmdShim, WINDOWS_NPM_POWERSHELL_SHIM } from '../src/cli/windows-cli-shim.mjs';

const privateInstaller = new URL('../public/install.ps1', import.meta.url);
const installer = fs.readFileSync(existsSync(privateInstaller)
  ? privateInstaller : new URL('../../../install.ps1', import.meta.url), 'utf8');
const npmShim = WINDOWS_NPM_POWERSHELL_SHIM;

function fixture(t, { cli = true, powershell = npmShim } = {}) {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-policy-'));
  t.after(() => fs.rmSync(prefix, { recursive:true, force:true }));
  if (cli) fs.writeFileSync(path.join(prefix, 'remcp.cmd'), '@echo off\r\necho WORKS\r\n');
  if (powershell !== null) fs.writeFileSync(path.join(prefix, 'remcp.ps1'), powershell);
  return prefix;
}

test('private npm-generated PowerShell shim is pruned while .cmd remains usable', t => {
  const prefix = fixture(t);
  assert.equal(preferWindowsCmdShim(prefix), true);
  assert.equal(fs.existsSync(path.join(prefix, 'remcp.ps1')), false);
  assert.match(fs.readFileSync(path.join(prefix, 'remcp.cmd'), 'utf8'), /WORKS/);
  assert.equal(preferWindowsCmdShim(prefix), false, 'repeated cleanup is safe');
});

test('unexpected custom PowerShell shim must remain untouched', t => {
  const prefix = fixture(t, { powershell:'Write-Output "CUSTOM SCRIPT"\n' });
  assert.throws(() => preferWindowsCmdShim(prefix), /non-npm/);
  assert.equal(fs.readFileSync(path.join(prefix, 'remcp.ps1'), 'utf8'), 'Write-Output "CUSTOM SCRIPT"\n');
});

test('a modified npm shim remains user-owned even when its original markers survive', t => {
  for (const custom of [npmShim + 'Write-Output "USER CUSTOMIZATION"\n', npmShim.replace('$basedir=', 'Write-Output "USER"\n$basedir=')]) {
    const prefix = fixture(t, { powershell: custom });
    assert.throws(() => assertWindowsNpmPowerShellShimOwned(prefix), /non-npm/);
    assert.throws(() => preferWindowsCmdShim(prefix), /non-npm/);
    assert.equal(fs.readFileSync(path.join(prefix, 'remcp.ps1'), 'utf8'), custom);
  }
});

test('a missing batch launcher refuses removal of the working script', t => {
  const prefix = fixture(t, { cli:false });
  assert.throws(() => preferWindowsCmdShim(prefix), /cmd launcher/);
  assert.equal(fs.existsSync(path.join(prefix, 'remcp.ps1')), true);
});

test('a symlink cannot impersonate an npm-owned PowerShell shim', t => {
  const prefix = fixture(t, { powershell:null });
  const target = path.join(prefix, 'target.ps1');
  fs.writeFileSync(target, npmShim);
  try { fs.symlinkSync(target, path.join(prefix, 'remcp.ps1')); }
  catch (error) {
    if (['EPERM','EACCES','ENOTSUP'].includes(error?.code)) return t.skip('symlink privilege unavailable');
    throw error;
  }
  assert.throws(() => preferWindowsCmdShim(prefix), /unknown/);
  assert.equal(fs.existsSync(target), true);
});


test('Windows update and install reject a custom shim before npm or rollback files are touched', t => {
  if (process.platform === 'win32') return t.skip('POSIX fake npm isolates this integration contract');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remcp-custom-shim-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const prefix = path.join(root, 'Local', 'ReMCP', 'runtime');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(prefix, { recursive:true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(prefix, 'remcp.cmd'), '@echo original');
  const custom = npmShim + 'Write-Output "CUSTOM LAUNCHER"\n';
  fs.writeFileSync(path.join(prefix, 'remcp.ps1'), custom);
  const marker = path.join(root, 'npm-invoked');
  const npmStub = path.join(bin, 'npm');
  fs.writeFileSync(npmStub, '#!/bin/sh\nif [ "$1" = "prefix" ]; then printf "%s\n" "$REMCP_TEST_PREFIX"; exit 0; fi\ntouch "$REMCP_TEST_INSTALL_TOUCHED"\nexit 0\n', { mode:0o700 });
  const env = { ...process.env, NODE_ENV:'test', REMCP_TEST_PLATFORM:'win32',
    LOCALAPPDATA:path.join(root, 'Local'), REMCP_NPM:npmStub,
    REMCP_TEST_PREFIX:prefix, REMCP_TEST_INSTALL_TOUCHED:marker };
  for (const command of [
    "npmGlobalInstall('@remcp/remcp@9.9.9')",
    "npmGlobalUpdate(['@remcp/remcp'], '@remcp/remcp@9.9.9')",
  ]) {
    const code = `import { npmGlobalInstall, npmGlobalUpdate } from './src/cli/npm-global.mjs';
${command};`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code],
      { cwd:process.cwd(), env, encoding:'utf8', timeout:7000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /non-npm ReMCP PowerShell launcher/);
    assert.equal(fs.existsSync(marker), false, 'npm must not execute before ownership validation');
    assert.equal(fs.readFileSync(path.join(prefix,'remcp.ps1'),'utf8'), custom);
    assert.equal(fs.readFileSync(path.join(prefix,'remcp.cmd'),'utf8'), '@echo original');
    assert.equal(fs.readdirSync(prefix).filter(name => name.startsWith('.remcp-update-backup-')).length, 0);
  }
});

test('preflight recognizes npm shim without modifying it, and rejects custom scripts', t => {
  const prefix = fixture(t);
  assert.equal(assertWindowsNpmPowerShellShimOwned(prefix), true);
  assert.equal(fs.existsSync(path.join(prefix, 'remcp.ps1')), true);
  fs.writeFileSync(path.join(prefix, 'remcp.ps1'), 'Write-Output "USER"\\n');
  assert.throws(() => assertWindowsNpmPowerShellShimOwned(prefix), /non-npm/);
  assert.equal(fs.readFileSync(path.join(prefix, 'remcp.ps1'), 'utf8'), 'Write-Output "USER"\\n');
});

test('Windows installer prunes only recognized shim before release promotion, including current installations', () => {
  assert.match(installer, /function Remove-ReMCPNpmPowerShellShadow/);
  assert.match(installer, /Remove-ReMCPNpmPowerShellShadow -Directory \$Destination/);
  assert.match(installer, /Remove-ReMCPNpmPowerShellShadow -Directory \$runtimeDir/);
  assert.doesNotMatch(installer, /\bSet-ExecutionPolicy\b/);
});
