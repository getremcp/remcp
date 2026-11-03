import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { body, freshWorkspace, isError } from './helpers.mjs';

const root = freshWorkspace('unrestricted-symlink');
const real = join(root, 'real');
mkdirSync(real, { recursive: true });
writeFileSync(join(real, 'file.txt'), 'delete me\n');
const alias = join(root, 'alias');
symlinkSync(real, alias, 'dir');

const { invokeTool } = await import('../src/invoke.mjs');

test('unrestricted mode follows a directory symlink for delete and move', {
  skip: process.platform === 'win32' ? 'creating symlinks needs extra Windows privileges' : false,
}, async () => {
  const deleted = await invokeTool('delete_path', { path: join(alias, 'file.txt') });
  assert.equal(isError(deleted), false, body(deleted));
  assert.equal(existsSync(join(real, 'file.txt')), false);

  writeFileSync(join(real, 'second.txt'), 'move me\n');
  const moved = await invokeTool('move_file', {
    source: join(alias, 'second.txt'),
    destination: join(alias, 'moved.txt'),
  });
  assert.equal(isError(moved), false, body(moved));
  assert.equal(readFileSync(join(real, 'moved.txt'), 'utf8'), 'move me\n');
});
