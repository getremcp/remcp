import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { body, freshWorkspace, isError } from './helpers.mjs';

const root = freshWorkspace('replace-limit');
const { invokeTool } = await import('../src/invoke.mjs');

function files(name) {
  const dir = join(root, name);
  mkdirSync(dir);
  for (const file of ['first.txt', 'second.txt', 'third.txt']) writeFileSync(join(dir, file), 'unchanged');
  return { dir, ordered:readdirSync(dir).map(file => join(dir, file)) };
}

test('maxFiles counts changed files, not earlier files excluded by the glob', async () => {
  const {dir, ordered} = files('glob');
  writeFileSync(ordered[2], 'needle');
  const name = ordered[2].split(/[\\/]/).at(-1);
  const result = await invokeTool('replace_in_files', {
    path:dir, pattern:'needle', replacement:'found', filePattern:name, maxFiles:1,
  });
  assert.equal(isError(result), false);
  assert.match(body(result), /Applied: 1 file/);
  assert.equal(readFileSync(ordered[2], 'utf8'), 'found');
});

test('maxFiles skips nonmatching content, honors dry run, and stops after one changed file', async () => {
  const {dir, ordered} = files('content');
  for (const target of ordered.slice(1)) writeFileSync(target, 'needle');
  const args = {path:dir, pattern:'needle', replacement:'found', filePattern:'*.txt', maxFiles:1};
  const preview = await invokeTool('replace_in_files', {...args, dry_run:true});
  assert.match(body(preview), /Dry run: 1 file/);
  assert.equal(readFileSync(ordered[1], 'utf8'), 'needle');
  const result = await invokeTool('replace_in_files', args);
  assert.match(body(result), /Applied: 1 file/);
  assert.equal(readFileSync(ordered[1], 'utf8'), 'found');
  assert.equal(readFileSync(ordered[2], 'utf8'), 'needle');
});
