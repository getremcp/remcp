import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { linuxServiceLauncherText } from '../src/cli/service.mjs';
import { assertSafeReMcpNpmPrefix } from '../src/cli/npm-global.mjs';
import { verifyManagedServiceReleasePair } from '../src/cli/update.mjs';
import { autoUpdateEnabled } from '../src/cli/config.mjs';

test('remcp update --help and top-level --help never run an installer', () => {
  const script = path.resolve('bin/remcp.mjs');
  for (const args of [['update', '--help'], ['--help']]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding:'utf8', timeout:10000,
      env:{ ...process.env, REMCP_NPM:'/does/not/exist', NPM_CONFIG_PREFIX:'/should/not/be/used' },
    });
    assert.equal(result.status, 0, String(result.stderr));
    assert.match(result.stdout, /Commands:/);
    assert.doesNotMatch(result.stdout + result.stderr, /Updating ReMCP|npm install|changed \d+ packages/);
  }
});

test('Linux service launcher pins the npm prefix of its installed CLI', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'remcp-prefix-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, 'nvm', 'node-v24');
  const node = path.join(prefix, 'bin', 'node');
  const cli = path.join(prefix, 'bin', 'remcp');
  mkdirSync(path.dirname(node), { recursive: true });
  writeFileSync(node, '#!/bin/sh\nprintf "npm_prefix=%s\\npath=%s\\n" "$NPM_CONFIG_PREFIX" "$PATH"\n', { mode:0o755 });
  writeFileSync(cli, '#!/bin/sh\n', { mode:0o755 });
  const launcher = path.join(root, 'agent-launcher');
  const source = linuxServiceLauncherText(cli, node);
  writeFileSync(launcher, source, { mode:0o755 });

  assert.match(source, /NPM_CONFIG_PREFIX=/);
  assert.match(source, /export NPM_CONFIG_PREFIX/);
  const child = spawnSync('/bin/sh', [launcher, 'start', '--service'], {
    encoding:'utf8',
    env:{ HOME:root, PATH:'/usr/bin:/bin', NPM_CONFIG_PREFIX:'/usr' },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(child.stdout.includes('npm_prefix=' + prefix + '\n'), child.stdout);
  assert.ok(child.stdout.includes('path=' + path.dirname(node) + ':'), child.stdout);
  assert.doesNotMatch(child.stdout, /npm_prefix=\/usr\n/);
});

test('Linux launcher fails closed on ambiguous or relative executable paths', () => {
  assert.throws(() => linuxServiceLauncherText('relative/bin/remcp', '/usr/bin/node'), /absolute/);
  assert.throws(() => linuxServiceLauncherText('/tmp/not-bin/remcp', '/usr/bin/node'), /global bin/);
  assert.throws(() => linuxServiceLauncherText('/tmp/bin/remcp', 'node'), /absolute/);
});

test('Linux service launcher pins the global npm prefix when CLI is a resolved package entry', () => {
  const prefix = '/opt/node-v24';
  const cli = `${prefix}/lib/node_modules/@remcp/remcp/bin/remcp.mjs`;
  const source = linuxServiceLauncherText(cli, `${prefix}/bin/node`);
  assert.ok(source.includes(`NPM_CONFIG_PREFIX='${prefix}'`), source);
  assert.ok(!source.includes(`NPM_CONFIG_PREFIX='${prefix}/lib/node_modules/@remcp/remcp'`), source);
});


test('npm update rejects package-nested global prefixes before touching other packages', () => {
  for (const prefix of [
    '/usr/lib/node_modules/@remcp/remcp',
    '/home/user/.nvm/versions/node/v24/lib/node_modules/@remcp/remcp',
    '/usr/lib/node_modules/@remcp/remcp/lib/node_modules',
    '/opt/node/lib/node_modules/@remcp/runtime',
    'relative/prefix',
  ]) assert.throws(() => assertSafeReMcpNpmPrefix(prefix), /ReMCP update refused/);
  assert.equal(assertSafeReMcpNpmPrefix('/usr'), '/usr');
  assert.equal(assertSafeReMcpNpmPrefix('/home/user/.nvm/versions/node/v24'), '/home/user/.nvm/versions/node/v24');
});

test('a successful npm install cannot trigger a service restart while the installed pair remains stale', () => {
  const clientSpec = '@remcp/remcp@0.2.201';
  const runtimeSpec = '@remcp/runtime@0.2.201';
  assert.throws(() => verifyManagedServiceReleasePair({ cliVersion:'0.2.199', runtimeVersion:'0.2.199' }, clientSpec, '@remcp/runtime', runtimeSpec), /refused to restart/);
  assert.throws(() => verifyManagedServiceReleasePair({ cliVersion:'0.2.201', runtimeVersion:'0.2.199' }, clientSpec, '@remcp/runtime', runtimeSpec), /refused to restart/);
  assert.doesNotThrow(() => verifyManagedServiceReleasePair({ cliVersion:'0.2.201', runtimeVersion:'0.2.201' }, clientSpec, '@remcp/runtime', runtimeSpec));
});

test('Linux auto-update is opt-in; explicit preferences remain authoritative', () => {
  assert.equal(autoUpdateEnabled({}, 'linux'), false);
  assert.equal(autoUpdateEnabled({ autoUpdate:false }, 'linux'), false);
  assert.equal(autoUpdateEnabled({ autoUpdate:true }, 'linux'), true);
  assert.equal(autoUpdateEnabled({}, 'darwin'), true);
  assert.equal(autoUpdateEnabled({}, 'win32'), true);
});
