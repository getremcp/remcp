import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isManagedLinuxSystemUnit, linuxCliShimText, discoverOwnedLinuxUnits, uninstallOwnedLinuxUnits } from '../src/cli/service-linux.mjs';
import { deferredLinuxAgentRestartArgs } from '../src/cli/service.mjs';

const launcher = '/root/.config/remcp/remcp-agent-launcher';

test('system unit is recognized only when it executes the ReMCP-owned launcher', () => {
  const managed = '[Service]\nExecStart="' + launcher + '" start --service\n';
  assert.equal(isManagedLinuxSystemUnit(managed, launcher), true);
  assert.equal(isManagedLinuxSystemUnit('[Service]\nExecStart=/usr/bin/node /tmp/other.mjs\n', launcher), false);
  assert.equal(isManagedLinuxSystemUnit('[Service]\nExecStart="' + launcher + '" update\n', launcher), false);
  assert.equal(isManagedLinuxSystemUnit('', launcher), false);
});

test('deferred restart targets the active supervisor and not the wrong user manager', () => {
  assert.deepEqual(deferredLinuxAgentRestartArgs(91, 'system'), [
    '--on-active=3s', '--unit=remcp-agent-settings-91',
    'systemctl', 'restart', 'remcp-agent.service',
  ]);
  assert.deepEqual(deferredLinuxAgentRestartArgs(91, 'user'), [
    '--user', '--on-active=3s', '--unit=remcp-agent-settings-91',
    'systemctl', '--user', 'restart', 'remcp-agent.service',
  ]);
  assert.throws(() => deferredLinuxAgentRestartArgs(91, 'unknown'), /scope/);
});

test('headless Linux shim keeps the same managed npm prefix outside interactive shell', () => {
  const prefix = '/root/.local/share/remcp/npm';
  const entry = prefix + '/lib/node_modules/@remcp/remcp/bin/remcp.mjs';
  const node = '/root/.local/share/remcp/bootstrap/node-v26.13.0-linux-x64/bin/node';
  const shim = linuxCliShimText(entry, node);
  assert.match(shim, /NPM_CONFIG_PREFIX='\/root\/\.local\/share\/remcp\/npm'/);
  assert.match(shim, /export NPM_CONFIG_PREFIX/);
  assert.ok(shim.includes("exec '" + node + "' '" + entry + "' \"$@\""));
});

test('synthetic Linux lifecycle fixtures never query host logind or passwd identity', () => {
  const moduleUrl = new URL('../src/cli/service-linux.mjs', import.meta.url).href;
  const script = 'import { ensureLinuxLinger } from ' + JSON.stringify(moduleUrl) + '; ensureLinuxLinger();';
  const proc = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding:'utf8', env:{...process.env, NODE_ENV:'test', REMCP_TEST_PLATFORM:'linux',
      HOME:'/tmp/remcp-qa-unregistered-test-home'},
  });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
});

function linuxUninstallFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-dual-uninstall-'));
  const systemFile = path.join(root, 'system', 'remcp-agent.service');
  const userFile = path.join(root, 'user', 'remcp-agent.service');
  const launcher = path.join(root, 'config', 'remcp-agent-launcher');
  for (const name of [systemFile, userFile, launcher]) mkdirSync(path.dirname(name), {recursive:true});
  const unit = ['[Unit]', 'Description=ReMCP device agent', '[Service]',
    'ExecStart="' + launcher + '" start --service', '[Install]',
    'WantedBy=default.target', ''].join('\n');
  writeFileSync(systemFile, unit);
  writeFileSync(userFile, unit);
  return { systemFile, userFile, launcher };
}

test('uninstall clears both owned PID-1 and legacy user systemd units', () => {
  const fixture = linuxUninstallFixture();
  const calls=[];
  const runner = (bin,args) => {
    assert.equal(bin,'systemctl');
    calls.push(args.join(' '));
    return {status:args.includes('is-active') ? 3 : 0};
  };
  assert.deepEqual(uninstallOwnedLinuxUnits({...fixture, includeSystem:true, runner}), ['system','user']);
  assert.equal(existsSync(fixture.systemFile),false);
  assert.equal(existsSync(fixture.userFile),false);
  assert.deepEqual(calls,[
    'disable --now remcp-agent.service',
    'is-active --quiet remcp-agent.service',
    'daemon-reload',
    '--user disable --now remcp-agent.service',
    '--user is-active --quiet remcp-agent.service',
    '--user daemon-reload',
  ]);
});

test('uninstall refuses foreign user units before changing a valid system unit', () => {
  const fixture = linuxUninstallFixture();
  writeFileSync(fixture.userFile, '[Service]\\nExecStart=/bin/false\\n');
  let calls=0;
  assert.throws(() => uninstallOwnedLinuxUnits({...fixture, includeSystem:true,
    runner:() => {calls++; return {status:0};}}), /unrecognized ReMCP systemd unit/);
  assert.equal(calls,0);
  assert.equal(existsSync(fixture.systemFile),true);
  assert.equal(existsSync(fixture.userFile),true);
});

test('uninstall does not erase units when stopping the service fails', () => {
  const fixture = linuxUninstallFixture();
  assert.throws(() => uninstallOwnedLinuxUnits({...fixture, includeSystem:true,
    runner:() => ({status:1})}), /Failed to stop/);
  assert.equal(existsSync(fixture.systemFile),true);
  assert.equal(existsSync(fixture.userFile),true);
});

test('uninstall fails closed when the user unit is a symlink', () => {
  const fixture = linuxUninstallFixture();
  const other = path.join(path.dirname(fixture.userFile), 'linked-unit');
  writeFileSync(other, readFileSync(fixture.userFile));
  // A symlink is not a unit ReMCP may delete, even when its target has valid content.
  const symlinkUnit = fixture.userFile + '.link';
  symlinkSync(other, symlinkUnit);
  assert.throws(() => discoverOwnedLinuxUnits({...fixture, userFile:symlinkUnit, includeSystem:true}),
    /unrecognized ReMCP systemd unit/);
});

test('CLI uninstall leaves pairing but removes stale user unit and status supervisor', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-uninstall-cli-'));
  const home = path.join(root, 'home');
  const configDir = path.join(root, 'config');
  const fakeBin = path.join(root, 'bin');
  const log = path.join(root, 'calls.log');
  for (const dir of [home, configDir, fakeBin]) mkdirSync(dir, {recursive:true});
  const configFile = path.join(configDir, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    serverUrl:'https://example.invalid', deviceId:'test-device', deviceToken:'dummy-token',
    deviceName:'fixture', serviceInstalled:true,
    runtime:{kind:'npm', packageName:'@remcp/runtime',
      packageSpec:'@remcp/runtime@0.2.239', entry:'src/index.mjs'},
  }));
  const launcher = path.join(configDir, 'remcp-agent-launcher');
  const userFile = path.join(home, '.config', 'systemd', 'user', 'remcp-agent.service');
  mkdirSync(path.dirname(userFile), {recursive:true});
  writeFileSync(userFile, '[Service]\nExecStart="' + launcher + '" start --service\n');
  const fakeSystemctl = path.join(fakeBin, 'systemctl');
  writeFileSync(fakeSystemctl, '#!/bin/sh\necho "$*" >> "$REMCP_TEST_LOG"\n'
    + 'case "$*" in *is-active*) exit 3;; esac\nexit 0\n');
  chmodSync(fakeSystemctl, 0o755);
  const env = {...process.env, NODE_ENV:'test', REMCP_TEST_PLATFORM:'linux',
    HOME:home, REMCP_CONFIG_DIR:configDir, REMCP_TEST_LOG:log,
    PATH:fakeBin + path.delimiter + process.env.PATH };
  const cli = path.resolve('bin/remcp.mjs');
  const result = spawnSync(process.execPath, [cli, 'uninstall'], {env, encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /background service removed/);
  assert.equal(existsSync(userFile),false);
  assert.equal(JSON.parse(readFileSync(configFile,'utf8')).serviceInstalled,false);
  assert.match(readFileSync(log,'utf8'), /--user disable --now remcp-agent\.service/);
  const inspected = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import {persistentServiceState} from './src/cli/service-inventory.mjs'; "
      + "console.log(JSON.stringify(persistentServiceState({serviceInstalled:false})));"],
      {env,encoding:'utf8'});
  assert.equal(inspected.status,0,inspected.stderr || inspected.stdout);
  const state = JSON.parse(inspected.stdout);
  assert.equal(state.installed,false);
  assert.equal(state.active,false);
  assert.equal(state.manager,'none');
});
