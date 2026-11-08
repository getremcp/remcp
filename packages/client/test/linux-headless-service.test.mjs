import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isManagedLinuxSystemUnit, linuxCliShimText } from '../src/cli/service-linux.mjs';
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
