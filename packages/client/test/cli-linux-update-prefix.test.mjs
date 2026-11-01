import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { linuxServiceLauncherText } from '../src/cli/service.mjs';

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
