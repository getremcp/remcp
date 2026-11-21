import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { terminalChildEnvironment } from '../src/tools/terminal.mjs';

test('managed agent npm prefix is removed only from spawned user-terminal env', {
  skip:process.platform === 'win32',
}, () => {
  const home = path.join(path.sep, 'tmp', 'remcp-prefix-fixture');
  const managed = path.join(home, '.local', 'share', 'remcp', 'managed-agent');
  const source = { HOME:home, PATH:'/usr/bin:/bin', NPM_CONFIG_PREFIX:managed,
    OTHER_CONFIG:'unchanged' };
  const child = terminalChildEnvironment(source, home);
  assert.equal(child.NPM_CONFIG_PREFIX, undefined);
  assert.equal(child.PATH, source.PATH);
  assert.equal(child.OTHER_CONFIG, 'unchanged');
  assert.equal(source.NPM_CONFIG_PREFIX, managed, 'never mutate the agent environment');
});

test('terminal preserves intentionally configured non-managed npm prefixes', {
  skip:process.platform === 'win32',
}, () => {
  const home = path.join(path.sep, 'tmp', 'remcp-prefix-fixture');
  const custom = path.join(home, 'my-npm-prefix');
  const source = { HOME:home, NPM_CONFIG_PREFIX:custom, npm_config_prefix:custom };
  const child = terminalChildEnvironment(source, home);
  assert.equal(child.NPM_CONFIG_PREFIX, custom);
  assert.equal(child.npm_config_prefix, custom);
});

test('terminal strips lower-case managed npm prefix without affecting unrelated values', {
  skip:process.platform === 'win32',
}, () => {
  const home = path.join(path.sep, 'tmp', 'remcp-prefix-fixture');
  const source = {
    npm_config_prefix:path.join(home, '.local', 'share', 'remcp', 'managed-agent'),
    NPM_CONFIG_PREFIX:path.join(home, 'custom-global'), HOME:home,
  };
  const child = terminalChildEnvironment(source, home);
  assert.equal(child.npm_config_prefix, undefined);
  assert.equal(child.NPM_CONFIG_PREFIX, path.join(home, 'custom-global'));
});
