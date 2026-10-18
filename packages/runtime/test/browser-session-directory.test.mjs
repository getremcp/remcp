import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSync, constants, mkdtempSync, mkdirSync, openSync, readdirSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSessionDirectory, verifySessionDirectory } from '../src/extended/browser-session-directory.mjs';

const flags = constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0);

test('macOS scans a validated directory by its real path, not non-scannable /dev/fd/N', () => {
  const root = mkdtempSync(join(tmpdir(), 'remcp-macos-fd-'));
  const dir = join(root, 'Sessions');
  mkdirSync(dir);
  writeFileSync(join(dir, 'Tabs_1234'), 'test-data');
  const fd = openSync(dir, flags);
  try {
    const result = scanSessionDirectory(dir, fd, 'darwin');
    assert.equal(result.readable, dir);
    assert.deepEqual(result.names, ['Tabs_1234']);
    assert.doesNotMatch(result.readable, /\/dev\/fd/);
  } finally {
    closeSync(fd);
    rmSync(root, { recursive:true, force:true });
  }
});

test('macOS detects directory replacement after a safe descriptor was opened', () => {
  const root = mkdtempSync(join(tmpdir(), 'remcp-macos-identity-'));
  const dir = join(root, 'Sessions');
  const replacement = join(root, 'replacement');
  mkdirSync(dir);
  mkdirSync(replacement);
  const fd = openSync(dir, flags);
  try {
    renameSync(dir, join(root, 'Sessions.original'));
    symlinkSync(replacement, dir);
    assert.throws(() => verifySessionDirectory(dir, fd, 'darwin'), /unsafe|changed/);
    assert.throws(() => scanSessionDirectory(dir, fd, 'darwin'), /unsafe|changed/);
  } finally {
    closeSync(fd);
    rmSync(root, { recursive:true, force:true });
  }
});

test('Linux continues enumerating through pinned /proc/self/fd, even after renaming directory', {
  skip: process.platform !== 'linux',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'remcp-linux-fd-'));
  const dir = join(root, 'Sessions');
  mkdirSync(dir);
  writeFileSync(join(dir, 'Tabs_4567'), 'test-data');
  const fd = openSync(dir, flags);
  try {
    renameSync(dir, join(root, 'Sessions.old'));
    const result = scanSessionDirectory(dir, fd, 'linux');
    assert.match(result.readable, /^\/proc\/self\/fd\/\d+$/);
    assert.deepEqual(readdirSync(result.readable), ['Tabs_4567']);
  } finally {
    closeSync(fd);
    rmSync(root, { recursive:true, force:true });
  }
});
