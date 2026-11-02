import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { body, freshWorkspace, isError } from './helpers.mjs';

const windowsOnly = { skip: process.platform !== 'win32' };
const root = freshWorkspace('win-file-qa');
const { invokeTool } = await import('../src/invoke.mjs');

test('native Windows: Unicode paths support list, info, read, hash and copy', windowsOnly, async () => {
  const folder = join(root, 'Space folder', 'Клиенты 日本語');
  mkdirSync(folder, { recursive: true });
  const source = join(folder, 'Résumé 2026.txt');
  const destination = join(folder, 'Copied résumé.txt');
  const data = 'first line\r\nsecond line\r\n';
  writeFileSync(source, data);

  const listing = await invokeTool('list_directory', { path: folder, depth: 2 });
  assert.equal(isError(listing), false, body(listing));
  assert.match(body(listing), /Résumé 2026\.txt/);
  const info = await invokeTool('get_file_info', { path: source });
  assert.equal(isError(info), false, body(info));
  assert.equal(JSON.parse(body(info)).lineCount, 2);
  const read = await invokeTool('read_file', { path: source });
  assert.equal(isError(read), false, body(read));
  assert.match(body(read), /second line/);

  const hash = await invokeTool('hash_file', { path: source });
  assert.equal(isError(hash), false, body(hash));
  assert.match(body(hash), new RegExp(createHash('sha256').update(data).digest('hex')));
  const copied = await invokeTool('copy_file', { source, destination });
  assert.equal(isError(copied), false, body(copied));
  assert.equal(readFileSync(destination, 'utf8'), data);

  const caseVariant = source.replace('Résumé 2026.txt', 'RÉSUMÉ 2026.TXT');
  const refused = await invokeTool('copy_file', { source, destination: caseVariant });
  assert.equal(isError(refused), true);
  assert.match(body(refused), /same path/);
  assert.equal(readFileSync(source, 'utf8'), data);
});

test('native Windows: missing targets produce actionable errors without uncaught failures', windowsOnly, async () => {
  const missing = join(root, 'missing folder');
  const absent = join(missing, 'missing.txt');
  for (const [name, args] of [
    ['list_directory', { path: missing }],
    ['get_file_info', { path: absent }],
    ['read_file', { path: absent }],
    ['hash_file', { path: absent }],
    ['copy_file', { source: absent, destination: join(root, 'other.txt') }],
  ]) {
    const result = await invokeTool(name, args);
    assert.equal(isError(result), true, name);
    assert.match(body(result), /not found|does not exist|ENOENT|source not found/i, name);
  }
  const regular = join(root, 'not-a-folder.txt');
  writeFileSync(regular, 'hello');
  const result = await invokeTool('list_directory', { path: regular });
  assert.equal(isError(result), true);
  assert.match(body(result), /not a directory|safe directory/i);
});

test('native Windows: get_file_info works for a file with exclusive read lock', windowsOnly, async () => {
  const locked = join(root, 'exclusively locked.txt');
  writeFileSync(locked, 'file metadata must stay visible');
  const quoted = locked.replace(/'/g, "''");
  const script = `$f=[System.IO.File]::Open('${quoted}',[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); try { [Console]::Out.WriteLine('LOCKED'); Start-Sleep -Seconds 20 } finally { $f.Dispose() }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      let stdout = '';
      const timer = setTimeout(() => reject(new Error('PowerShell exclusive-lock setup timed out')), 8000);
      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
        if (stdout.includes('LOCKED')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('error', err => { clearTimeout(timer); reject(err); });
      child.once('exit', code => {
        if (!stdout.includes('LOCKED')) {
          clearTimeout(timer);
          reject(new Error(`Exclusive-lock helper exited early: ${code}`));
        }
      });
    });
    const result = await invokeTool('get_file_info', { path: locked });
    assert.equal(isError(result), false, body(result));
    assert.equal(JSON.parse(body(result)).type, 'file');
  } finally {
    child.kill();
  }
});
