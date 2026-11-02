import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { canonicalServiceCliPath } from '../src/cli/service-inventory.mjs';
import { windowsServiceLauncherText } from '../src/cli/windows-supervisor.mjs';

test('saved Windows .mjs service identity resolves to npm .cmd shim, not shell-opened module', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remcp-windows-persisted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'node_modules', '@remcp', 'remcp', 'bin', 'remcp.mjs');
  const shim = path.join(root, 'remcp.cmd');
  const node = path.join(root, 'node.exe');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '#!/usr/bin/env node\n');
  fs.writeFileSync(shim, '@echo off\r\n');
  fs.writeFileSync(node, '');
  const oldEnv = process.env.NODE_ENV;
  const oldPlatform = process.env.REMCP_TEST_PLATFORM;
  try {
    process.env.NODE_ENV = 'test';
    process.env.REMCP_TEST_PLATFORM = 'win32';
    assert.equal(canonicalServiceCliPath({ serviceCliPath: entry }), shim);
    const body = windowsServiceLauncherText(shim, node, { localAppData: '' });
    assert.ok(body.includes('set "NPM_CONFIG_PREFIX=' + root + '"'));
    assert.ok(body.includes('call "' + shim + '" start --service'));
    assert.doesNotMatch(body, /call .*remcp\.mjs/i);
    assert.throws(() => windowsServiceLauncherText(entry, node), /requires the ReMCP \.cmd shim/);
    fs.rmSync(shim);
    assert.throws(() => canonicalServiceCliPath({ serviceCliPath: entry }), /npm shim is missing/);
    process.env.REMCP_TEST_PLATFORM = 'linux';
    assert.equal(canonicalServiceCliPath({ serviceCliPath: entry }), entry);
  } finally {
    if (oldEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldEnv;
    if (oldPlatform === undefined) delete process.env.REMCP_TEST_PLATFORM;
    else process.env.REMCP_TEST_PLATFORM = oldPlatform;
  }
});
