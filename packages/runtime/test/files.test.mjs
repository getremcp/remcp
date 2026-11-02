import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { body, freshWorkspace, isError } from './helpers.mjs';

const root = freshWorkspace('files');
const { invokeTool } = await import('../src/invoke.mjs');

test('write_file creates parent directories and read_file pages through content', async () => {
  const target = join(root, 'nested', 'notes.txt');
  const written = await invokeTool('write_file', { path: target, content: 'alpha\nbeta\ngamma\ndelta\n' });
  assert.equal(isError(written), false);
  assert.equal(readFileSync(target, 'utf8'), 'alpha\nbeta\ngamma\ndelta\n');

  const whole = body(await invokeTool('read_file', { path: target }));
  assert.match(whole, /lines 1-4 of 4/);
  assert.match(whole, /beta/);

  const page = body(await invokeTool('read_file', { path: target, offset: 1, length: 2 }));
  assert.match(page, /lines 2-3 of 4/);
  assert.match(page, /beta\ngamma/);

  assert.match(body(await invokeTool('read_file', { path: target, offset: -1 })), /delta/);
});

test('write_file append mode keeps existing content', async () => {
  const target = join(root, 'append.txt');
  await invokeTool('write_file', { path: target, content: 'first\n' });
  await invokeTool('write_file', { path: target, content: 'second\n', mode: 'append' });
  assert.equal(readFileSync(target, 'utf8'), 'first\nsecond\n');
});

test('read_file refuses binary files and missing paths', async () => {
  const binary = join(root, 'blob.bin');
  writeFileSync(binary, Buffer.from([0, 1, 2, 3, 0, 5]));
  assert.equal(isError(await invokeTool('read_file', { path: binary })), true);
  assert.equal(isError(await invokeTool('read_file', { path: join(root, 'missing.txt') })), true);
});

test('read_multiple_files reports per-file failures without failing the batch', async () => {
  const good = join(root, 'good.txt');
  writeFileSync(good, 'ok\n');
  const result = body(await invokeTool('read_multiple_files', { paths: [good, join(root, 'nope.txt')] }));
  assert.match(result, /good\.txt:/);
  assert.match(result, /nope\.txt: error/);
});

test('edit_block replaces exact text and enforces the expected match count', async () => {
  const target = join(root, 'edit.txt');
  writeFileSync(target, 'one\ntwo\nthree\n');
  assert.equal(isError(await invokeTool('edit_block', { file_path: target, old_string: 'two', new_string: 'TWO' })), false);
  assert.equal(readFileSync(target, 'utf8'), 'one\nTWO\nthree\n');

  const missing = await invokeTool('edit_block', { file_path: target, old_string: 'absent', new_string: 'x' });
  assert.equal(isError(missing), true);
  assert.match(body(missing), /was not found/);

  writeFileSync(target, 'dup\ndup\n');
  const ambiguous = await invokeTool('edit_block', { file_path: target, old_string: 'dup', new_string: 'x' });
  assert.equal(isError(ambiguous), true);
  assert.match(body(ambiguous), /found 2/);

  assert.equal(isError(await invokeTool('edit_block', { file_path: target, old_string: 'dup', new_string: 'x', expected_replacements: 2 })), false);
  assert.equal(readFileSync(target, 'utf8'), 'x\nx\n');
});

test('list_directory lists entries with type prefixes and depth control', async () => {
  const base = join(root, 'tree');
  mkdirSync(join(base, 'child'), { recursive: true });
  writeFileSync(join(base, 'root.txt'), 'root');
  writeFileSync(join(base, 'child', 'deep.txt'), 'deep');

  const flat = body(await invokeTool('list_directory', { path: base }));
  assert.match(flat, /\[DIR\] child/);
  assert.match(flat, /\[FILE\] root\.txt/);
  assert.doesNotMatch(flat, /deep\.txt/);
  assert.match(body(await invokeTool('list_directory', { path: base, depth: 2 })), /deep\.txt/);
});

test('get_file_info returns metadata and line counts for text files', async () => {
  const target = join(root, 'info.txt');
  writeFileSync(target, 'a\nb\nc\n');
  chmodSync(target, 0o640);
  const info = JSON.parse(body(await invokeTool('get_file_info', { path: target })));
  assert.equal(info.type, 'file');
  assert.equal(info.lineCount, 3);
  // NTFS permission strings are not POSIX chmod semantics (ACLs are separate).
  if (process.platform === 'win32') assert.match(info.permissions, /^0[0-7]{3}$/);
  else assert.equal(info.permissions, '0640');
});

test('create_directory is idempotent', async () => {
  const directory = join(root, 'made', 'deeper');
  assert.equal(isError(await invokeTool('create_directory', { path: directory })), false);
  assert.equal(isError(await invokeTool('create_directory', { path: directory })), false);
  assert.equal(statSync(directory).isDirectory(), true);
});

test('move_file renames, replaces by default, and can refuse an existing destination', async () => {
  const source = join(root, 'move-src.txt');
  const destination = join(root, 'moved', 'move-dst.txt');
  writeFileSync(source, 'payload');
  assert.equal(isError(await invokeTool('move_file', { source, destination })), false);
  assert.equal(readFileSync(destination, 'utf8'), 'payload');

  writeFileSync(source, 'again');
  assert.equal(isError(await invokeTool('move_file', { source, destination })), false, 'moving over a file replaces it, like mv');
  assert.equal(readFileSync(destination, 'utf8'), 'again');

  writeFileSync(source, 'third');
  const blocked = await invokeTool('move_file', { source, destination, overwrite: false });
  assert.equal(isError(blocked), true);
  assert.match(body(blocked), /already exists/);
  assert.equal(existsSync(source), true);
});

test('copy_file keeps the source and replaces the destination by default', async () => {
  const source = join(root, 'copy-src.txt');
  const destination = join(root, 'copied', 'copy-dst.txt');
  writeFileSync(source, 'original');
  assert.equal(isError(await invokeTool('copy_file', { source, destination })), false);
  assert.equal(readFileSync(source, 'utf8'), 'original');
  assert.equal(readFileSync(destination, 'utf8'), 'original');

  writeFileSync(source, 'updated');
  assert.equal(isError(await invokeTool('copy_file', { source, destination })), false);
  assert.equal(readFileSync(destination, 'utf8'), 'updated');

  const refused = await invokeTool('copy_file', { source, destination, overwrite: false });
  assert.equal(isError(refused), true);
  assert.match(body(refused), /already exists/);
});

test('copy_file refuses directories', async () => {
  mkdirSync(join(root, 'copy-dir'), { recursive: true });
  const result = await invokeTool('copy_file', { source: join(root, 'copy-dir'), destination: join(root, 'copy-dir-2') });
  assert.equal(isError(result), true);
  assert.match(body(result), /single files only/);
});

test('edit_block falls back to whitespace-tolerant matching and says so', async () => {
  const target = join(root, 'fuzzy.js');
  writeFileSync(target, 'function outer() {\n    const value = 1;\n    return value;\n}\n');
  const stale = 'function outer() {\n  const value = 1;\n  return value;\n}';
  const result = await invokeTool('edit_block', { file_path: target, old_string: stale, new_string: 'function outer() {\n    return 2;\n}' });
  assert.equal(isError(result), false);
  assert.match(body(result), /whitespace-tolerant/);
  assert.match(readFileSync(target, 'utf8'), /return 2;/);
});

test('fuzzy matching still refuses ambiguous blocks', async () => {
  const target = join(root, 'fuzzy-ambiguous.txt');
  writeFileSync(target, '  alpha   beta\nother\nalpha beta\n');
  const result = await invokeTool('edit_block', { file_path: target, old_string: 'alpha  beta', new_string: 'x' });
  assert.equal(isError(result), true);
  assert.match(body(result), /matched 2 block/);
});

test('allow_fuzzy false keeps edit_block strict', async () => {
  const target = join(root, 'strict.txt');
  writeFileSync(target, 'one\n\t two\n');
  const result = await invokeTool('edit_block', { file_path: target, old_string: '  two', new_string: 'TWO', allow_fuzzy: false });
  assert.equal(isError(result), true);
  assert.match(body(result), /was not found/);
});

test('get_runtime_info reports the policy without exposing a way to change it', async () => {
  const info = JSON.parse(body(await invokeTool('get_runtime_info', {})));
  assert.equal(typeof info.policy.dangerousCommands, 'string');
  assert.ok(Array.isArray(info.policy.builtinGuardrailIds));
  assert.equal(info.telemetry.transport, 'paired-agent-only');
  assert.equal(info.telemetry.installPing, false);
  assert.equal(info.telemetry.remoteFeatureFlags, false);
});

test('get_runtime_stats counts local tool usage', async () => {
  const stats = JSON.parse(body(await invokeTool('get_runtime_stats', {})));
  assert.ok(stats.counters.toolCalls >= 1);
  assert.equal(typeof stats.sessions.processSessions, 'number');
  assert.equal(stats.telemetry.transport, 'paired-agent-only');
});


test('get_file_info reports files and directories but rejects symlink leaves', async () => {
  const { symlinkSync } = await import('node:fs');
  const regular = join(root, 'metadata-regular.txt');
  const directory = join(root, 'metadata-directory');
  const symlink = join(root, 'metadata-link');
  writeFileSync(regular, 'file\n');
  mkdirSync(directory, { recursive: true });
  symlinkSync(regular, symlink);
  const fileInfo = JSON.parse(body(await invokeTool('get_file_info', { path: regular })));
  const dirInfo = JSON.parse(body(await invokeTool('get_file_info', { path: directory })));
  assert.equal(fileInfo.type, 'file');
  assert.equal(dirInfo.type, 'directory');
  assert.equal(isError(await invokeTool('get_file_info', { path: symlink })), true);
});

test('read_multiple_files preserves request order with parallel workers and isolated failures', async () => {
  const entries = ['parallel-a.txt', 'parallel-b.txt', 'parallel-c.txt', 'parallel-d.txt'].map(name => join(root, name));
  entries.forEach((name, index) => writeFileSync(name, `entry-${index}\n`));
  const missing = join(root, 'parallel-missing.txt');
  const output = body(await invokeTool('read_multiple_files', { paths: [entries[3], missing, entries[0], entries[2], entries[1]] }));
  const labels = ['parallel-d.txt:', 'parallel-missing.txt:', 'parallel-a.txt:', 'parallel-c.txt:', 'parallel-b.txt:'];
  for (let index = 1; index < labels.length; index++) {
    assert.ok(output.indexOf(labels[index - 1]) < output.indexOf(labels[index]), `out-of-order: ${labels[index]}`);
  }
  assert.match(output, /parallel-missing.txt: error/);
  assert.match(output, /entry-3/);
});

test('read_multiple_files rejects oversized batches rather than starting unbounded I/O', async () => {
  const paths = Array.from({ length: 51 }, (_, index) => join(root, `oversized-${index}.txt`));
  const result = await invokeTool('read_multiple_files', { paths });
  assert.equal(isError(result), true);
});
