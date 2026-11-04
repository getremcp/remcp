import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { body, freshWorkspace, isError } from './helpers.mjs';

freshWorkspace('trash-cross-device');
const { invokeTool } = await import('../src/invoke.mjs');

function differentMount() {
  if (process.platform !== 'linux') return null;
  const homeDevice = statSync(homedir()).dev;
  for (const candidate of ['/tmp', '/dev/shm']) {
    try {
      if (statSync(candidate).dev !== homeDevice) {
        accessSync(candidate, constants.W_OK);
        return candidate;
      }
    } catch {}
  }
  return null;
}

test('move_to_trash preserves a directory across filesystems using source-local trash', async t => {
  const mount = differentMount();
  if (!mount) return t.skip('No writable separate mount found');
  const parent = mkdtempSync(join(mount, 'remcp-trash-exdev-'));
  try {
    const source = join(parent, 'owned');
    mkdirSync(join(source, 'nested'), { recursive: true });
    writeFileSync(join(source, 'nested', 'note.txt'), 'keep Ж 日本語 ✓\n');
    const result = await invokeTool('move_to_trash', { source });
    assert.equal(isError(result), false, body(result));
    const match = body(result).match(/ to (.*?)\. Restore it with move_file/);
    assert.ok(match, body(result));
    const destination = match[1];
    assert.ok(destination.startsWith(join(parent, '.remcp-trash') + '/'), destination);
    assert.equal(readFileSync(join(destination, 'nested', 'note.txt'), 'utf8'), 'keep Ж 日本語 ✓\n');
    assert.equal(existsSync(source), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('cross-filesystem regular files retain the persistent home trash copy', async t => {
  const mount = differentMount();
  if (!mount) return t.skip('No writable separate mount found');
  const parent = mkdtempSync(join(mount, 'remcp-trash-file-'));
  let destination;
  try {
    const source = join(parent, 'note.txt');
    writeFileSync(source, 'persistent Ж ✓\n');
    const result = await invokeTool('move_to_trash', { source });
    assert.equal(isError(result), false, body(result));
    const match = body(result).match(/ to (.*?)\. Restore it with move_file/);
    assert.ok(match, body(result));
    destination = match[1].startsWith('~/') ? join(homedir(), match[1].slice(2)) : match[1];
    assert.ok(destination.startsWith(join(homedir(), '.local', 'share', 'Trash', 'files') + '/'), destination);
    assert.equal(readFileSync(destination, 'utf8'), 'persistent Ж ✓\n');
    assert.equal(existsSync(source), false);
  } finally {
    const trashRoot = join(homedir(), '.local', 'share', 'Trash', 'files') + '/';
    if (destination?.startsWith(trashRoot) && destination.endsWith('-note.txt')) {
      try {
        if (readFileSync(destination, 'utf8') === 'persistent Ж ✓\n') rmSync(destination, { force: true });
      } catch {}
    }
    rmSync(parent, { recursive: true, force: true });
  }
});

test('cross-filesystem fallback refuses a symlinked trash directory', async t => {
  const mount = differentMount();
  if (!mount) return t.skip('No writable separate mount found');
  const parent = mkdtempSync(join(mount, 'remcp-trash-symlink-'));
  try {
    const source = join(parent, 'owned');
    mkdirSync(source);
    writeFileSync(join(source, 'note.txt'), 'keep intact\n');
    const outside = join(parent, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(parent, '.remcp-trash'));
    const result = await invokeTool('move_to_trash', { source });
    assert.equal(isError(result), true);
    assert.equal(readFileSync(join(source, 'note.txt'), 'utf8'), 'keep intact\n');
    assert.equal(existsSync(join(outside, 'note.txt')), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
