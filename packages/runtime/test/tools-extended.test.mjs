import { readFilesSource } from './helpers/files-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { body, freshWorkspace, isError } from './helpers.mjs';
import { applyLiveConfig, liveConfig } from '../src/config.mjs';
import { zipArchiveBackendAvailable } from '../src/tools/files.mjs';

const root = freshWorkspace('extended');
const { invokeTool } = await import('../src/invoke.mjs');
const zipArchiveReady = zipArchiveBackendAvailable();

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('write_file replaces by default and appends on request', async () => {
  const target = join(root, 'existing.txt');
  writeFileSync(target, 'important data\n');
  assert.equal(isError(await invokeTool('write_file', { path: target, content: 'replaced\n' })), false);
  assert.equal(readFileSync(target, 'utf8'), 'replaced\n');
  assert.equal(isError(await invokeTool('write_file', { path: target, content: 'more\n', mode: 'append' })), false);
  assert.equal(readFileSync(target, 'utf8'), 'replaced\nmore\n');
  assert.equal(isError(await invokeTool('write_file', { path: target, content: 'x', mode: 'sideways' })), true);
});

test('write_file still creates new files and points binary data at write_binary', async () => {
  assert.equal(isError(await invokeTool('write_file', { path: join(root, 'fresh.txt'), content: 'new\n' })), false);
  const binary = await invokeTool('write_file', { path: join(root, 'binary.bin'), content: 'a\0b' });
  assert.equal(isError(binary), true);
  assert.match(body(binary), /write_binary/);
});

test('read_binary and write_binary transfer a file byte for byte in chunks', async () => {
  const source = join(root, 'blob.bin');
  const payload = Buffer.alloc(2500 * 1024);
  for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
  writeFileSync(source, payload);

  const first = JSON.parse(body(await invokeTool('read_binary', { path: source })));
  assert.equal(first.size, payload.length);
  assert.equal(first.encoding, 'base64');
  assert.equal(first.complete, false);
  assert.ok(Buffer.from(first.data, "base64").length <= 1024 * 1024);

  const copy = join(root, 'blob-copy.bin');
  let offset = 0;
  let complete = false;
  let appended = false;
  while (!complete) {
    const chunk = JSON.parse(body(await invokeTool('read_binary', { path: source, offset_bytes: offset })));
    assert.equal(isError(await invokeTool('write_binary', { path: copy, data: chunk.data, mode: appended ? 'append' : 'rewrite' })), false);
    appended = true;
    complete = chunk.complete;
    offset = chunk.nextOffsetBytes ?? offset;
  }
  assert.equal(readFileSync(copy).equals(payload), true, 'the copy must be identical');
  const hashSource = body(await invokeTool('hash_file', { path: source }));
  const hashCopy = body(await invokeTool('hash_file', { path: copy }));
  assert.equal(hashSource.split(' ')[1], hashCopy.split(' ')[1]);
});

test('read_binary keeps JSON valid when the live output cap is smaller than a 1 MiB base64 envelope', async () => {
  const source = join(root, 'bounded-blob.bin');
  const payload = Buffer.alloc(512 * 1024, 0xa5);
  writeFileSync(source, payload);
  const previous = liveConfig('maxOutputBytes');
  applyLiveConfig('maxOutputBytes', 128 * 1024);
  try {
    const rendered = body(await invokeTool('read_binary', { path: source, length_bytes: payload.length }));
    assert.doesNotMatch(rendered, /output truncated/);
    const chunk = JSON.parse(rendered);
    assert.equal(chunk.size, payload.length);
    assert.equal(chunk.offsetBytes, 0);
    assert.ok(chunk.lengthBytes > 0);
    assert.ok(chunk.lengthBytes < payload.length);
    assert.equal(chunk.complete, false);
    assert.equal(chunk.nextOffsetBytes, chunk.lengthBytes);
    assert.equal(Buffer.from(chunk.data, 'base64').length, chunk.lengthBytes);
  } finally {
    applyLiveConfig('maxOutputBytes', previous);
  }
});

test('PDF split refuses an output filename that escapes output_dir', async () => {
  const source = join(root, 'split-fixture.pdf');
  const outputDir = join(root, 'split-output');
  writeFileSync(source, '%PDF-1.4\n%%EOF\n');
  const result = await invokeTool('pdf_action', { action: 'split', path: source, output_dir: outputDir, pattern: '../escaped-%d.pdf' });
  assert.equal(isError(result), true);
  assert.match(body(result), /filename without path separators/i);
  assert.equal(existsSync(join(root, 'escaped-1.pdf')), false);
});

test('archives can be created and extracted', async () => {
  const project = join(root, 'archive-project');
  mkdirSync(join(project, 'nested'), { recursive: true });
  writeFileSync(join(project, 'a.txt'), 'alpha\n');
  writeFileSync(join(project, 'nested', 'b.txt'), 'beta\n');
  const archive = join(root, 'bundle.tar.gz');
  const created = await invokeTool('create_archive', { paths: [project], destination: archive, format: 'tar.gz' });
  assert.equal(isError(created), false, body(created));
  assert.ok(statSync(archive).size > 0);
  const out = join(root, 'extracted');
  const extracted = await invokeTool('extract_archive', { archive, destination: out });
  assert.equal(isError(extracted), false, body(extracted));
  const nested = join(out, 'archive-project', 'nested', 'b.txt');
  assert.equal(readFileSync(nested, 'utf8'), 'beta\n');
});

test('ZIP archives can be created and extracted through the platform archive backend', { skip: !zipArchiveReady }, async () => {
  const project = join(root, 'archive-zip-project');
  mkdirSync(join(project, 'nested'), { recursive: true });
  writeFileSync(join(project, 'a.txt'), 'zip alpha\n');
  writeFileSync(join(project, 'nested', 'b.txt'), 'zip beta\n');
  const archive = join(root, 'bundle.zip');
  const created = await invokeTool('create_archive', { paths:[project], destination:archive, format:'zip' });
  assert.equal(isError(created), false, body(created));
  assert.ok(statSync(archive).size > 0);
  const out = join(root, 'extracted-zip');
  const extracted = await invokeTool('extract_archive', { archive, destination:out });
  assert.equal(isError(extracted), false, body(extracted));
  assert.equal(readFileSync(join(out, 'archive-zip-project', 'a.txt'), 'utf8'), 'zip alpha\n');
  assert.equal(readFileSync(join(out, 'archive-zip-project', 'nested', 'b.txt'), 'utf8'), 'zip beta\n');
});

test('archive creation passes option-like member names after the option terminator', async () => {
  const project = join(root, 'archive-option-project');
  mkdirSync(project, { recursive: true });
  const member = '--checkpoint-action=exec=printf';
  writeFileSync(join(project, member), 'safe\n');
  const archive = join(root, 'option-members.tar.gz');
  const created = await invokeTool('create_archive', { paths: [project], destination: archive, format: 'tar.gz' });
  assert.equal(isError(created), false, body(created));
  const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /archive-option-project/);
});

test('archive extraction rejects an expanded-size bomb before writing files', {
  skip: spawnSync('tar', ['--version'], { stdio: 'ignore' }).status !== 0,
}, async () => {
  const project = join(root, 'archive-bomb-project');
  mkdirSync(project, { recursive: true });
  const large = join(project, 'large.bin');
  writeFileSync(large, '');
  truncateSync(large, 513 * 1024 * 1024);
  const archive = join(root, 'large.tar');
  const created = spawnSync('tar', ['--sparse', '-cf', archive, '-C', project, 'large.bin'], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const destination = join(root, 'archive-bomb-output');
  const extracted = await invokeTool('extract_archive', { archive, destination });
  assert.equal(isError(extracted), true);
  assert.match(body(extracted), /extraction limit|safety limit/i);
  assert.equal(existsSync(join(destination, 'large.bin')), false);
});

test('archive extraction refuses to follow a pre-existing destination symlink', {
  skip: spawnSync('tar', ['--version'], { stdio: 'ignore' }).status !== 0,
}, async () => {
  const source = join(root, 'archive-symlink-source', 'out');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'pwned.txt'), 'nope\n');
  const archive = join(root, 'symlink-destination.tar');
  const packed = spawnSync('tar', ['-cf', archive, '-C', join(root, 'archive-symlink-source'), 'out'], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const outside = join(root, 'outside-target');
  mkdirSync(outside, { recursive: true });
  const destination = join(root, 'symlink-destination');
  mkdirSync(destination, { recursive: true });
  symlinkSync(outside, join(destination, 'out'), 'dir');
  const extracted = await invokeTool('extract_archive', { archive, destination });
  assert.equal(isError(extracted), true);
  assert.match(body(extracted), /unsafe path|symlink|destination/i);
  assert.equal(existsSync(join(outside, 'out', 'pwned.txt')), false);
});

test('archive extraction snapshots the source and enforces its size limit before inspection', {
  skip: spawnSync('tar', ['--version'], { stdio: 'ignore' }).status !== 0,
}, async () => {
  const archive = join(root, 'oversized-source.tar');
  writeFileSync(archive, '');
  truncateSync(archive, 513 * 1024 * 1024);
  const destination = join(root, 'oversized-source-output');
  const extracted = await invokeTool('extract_archive', { archive, destination });
  assert.equal(isError(extracted), true);
  assert.match(body(extracted), /snapshot limit/i);
  assert.equal(existsSync(destination), false);
});

test('archive extraction does not copy a destination after a symlink swap', {
  skip: process.platform === 'win32' || spawnSync('tar', ['--version'], { stdio: 'ignore' }).status !== 0,
}, async () => {
  const source = join(root, 'archive-swap-source');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'payload.txt'), 'archive payload\n');
  const archive = join(root, 'archive-swap.tar');
  const packed = spawnSync('tar', ['-cf', archive, '-C', source, 'payload.txt'], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);

  const destination = join(root, 'archive-swap-destination');
  const movedDestination = `${destination}.before-swap`;
  const outside = join(root, 'archive-swap-outside');
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'existing.txt'), 'existing\n');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'outside secret\n');

  const realTar = spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/tar';
  const bin = join(root, 'archive-swap-bin');
  const marker = join(root, 'archive-swap.marker');
  mkdirSync(bin, { recursive: true });
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const tarPath = join(bin, 'tar');
  writeFileSync(tarPath, `#!/bin/sh
if [ "$1" = "--version" ]; then exec ${quote(realTar)} "$@"; fi
${quote(realTar)} "$@"
status=$?
if [ ! -e ${quote(marker)} ]; then
  : > ${quote(marker)}
  mv ${quote(destination)} ${quote(movedDestination)}
  ln -s ${quote(outside)} ${quote(destination)}
fi
exit $status
`);
  chmodSync(tarPath, 0o700);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${oldPath || ''}`;
  try {
    const extracted = await invokeTool('extract_archive', { archive, destination });
    assert.equal(isError(extracted), true);
    assert.equal(existsSync(join(destination, 'secret.txt')), false);
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'outside secret\n');
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

test('archive file overlay is committed atomically instead of truncating a checked pathname', () => {
  const source = readFilesSource();
  const match = source.match(/async function copyOpenRegularFile\([\s\S]*?\n\}\n\n(?:export )?async function copyTreeContents/);
  assert.ok(match, 'archive copy implementation is present');
  const copy = match[0];
  assert.doesNotMatch(copy, /lstat\(destinationPath\)/, 'no check/use race is used to decide whether a destination is safe');
  assert.match(copy, /WRITE_CREATE_NOFOLLOW/, 'archive contents are first written to an exclusive no-follow temporary file');
  assert.match(copy, /rename\(temporary, destinationPath\)/, 'the completed file replaces the destination atomically');
});

test('archive extraction still overlays an existing regular file while preserving unrelated files', {
  skip: spawnSync('tar', ['--version'], { stdio: 'ignore' }).status !== 0,
}, async () => {
  const source = join(root, 'archive-overlay-source');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'replace.txt'), 'new payload\n');
  const archive = join(root, 'archive-overlay.tar');
  const packed = spawnSync('tar', ['-cf', archive, '-C', source, 'replace.txt'], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);

  const destination = join(root, 'archive-overlay-destination');
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'replace.txt'), 'old payload\n');
  writeFileSync(join(destination, 'keep.txt'), 'keep me\n');

  const extracted = await invokeTool('extract_archive', { archive, destination });
  assert.equal(isError(extracted), false, body(extracted));
  assert.equal(readFileSync(join(destination, 'replace.txt'), 'utf8'), 'new payload\n');
  assert.equal(readFileSync(join(destination, 'keep.txt'), 'utf8'), 'keep me\n');
});

test('zip archives use the Info-ZIP compatible unzip probe', {
  skip: spawnSync('zip', ['--version'], { stdio:'ignore' }).status !== 0
    || spawnSync('unzip', ['-v'], { stdio:'ignore' }).status !== 0,
}, async () => {
  const project = join(root, 'archive-zip-project');
  mkdirSync(project, { recursive:true });
  writeFileSync(join(project, 'inside.txt'), 'zip works\n');
  const archive = join(root, 'bundle.zip');
  const created = await invokeTool('create_archive', { paths:[project], destination:archive, format:'zip' });
  assert.equal(isError(created), false, body(created));
  const out = join(root, 'extracted-zip');
  const extracted = await invokeTool('extract_archive', { archive, destination:out });
  assert.equal(isError(extracted), false, body(extracted));
  assert.equal(readFileSync(join(out, 'archive-zip-project', 'inside.txt'), 'utf8'), 'zip works\n');
});

test('take_screenshot either returns an image or explains what is missing', async () => {
  const result = await invokeTool('take_screenshot', { directory: root });
  if (result.isError === true) {
    // The message is platform-specific now: no session at all, a missing Wayland capture tool, a
    // Windows session that nobody is signed in to, or macOS Screen Recording that was never granted.
    assert.match(body(result), /no graphical session|Could not capture the screen|Install one of|Screen Recording|interactive desktop session|grim/);
  } else {
    assert.equal(result.content[1].type, 'image');
    assert.equal(result.content[1].mimeType, 'image/png');
  }
});

test('whitespace-tolerant edits keep the file line endings', async () => {
  const target = join(root, 'crlf.txt');
  writeFileSync(target, 'alpha\r\n    beta\r\ncharlie\r\n');
  const result = await invokeTool('edit_block', {
    file_path: target,
    old_string: 'alpha\n  beta\ncharlie',
    new_string: 'alpha\n  BETA\ncharlie',
  });
  assert.equal(isError(result), false);
  assert.match(body(result), /line endings kept as CRLF/);
  const updated = readFileSync(target, 'utf8');
  assert.equal(updated, 'alpha\r\n  BETA\r\ncharlie\r\n');
  assert.equal(updated.includes('\n\n'), false);
});

test('edit_block can preview a change with dry_run', async () => {
  const target = join(root, 'dryrun.txt');
  writeFileSync(target, 'one\ntwo\nthree\n');
  const preview = await invokeTool('edit_block', { file_path: target, old_string: 'two', new_string: 'TWO', dry_run: true });
  assert.equal(isError(preview), false);
  assert.match(body(preview), /dry run/);
  assert.match(body(preview), /-two/);
  assert.match(body(preview), /\+TWO/);
  assert.equal(readFileSync(target, 'utf8'), 'one\ntwo\nthree\n', 'dry_run must not write');
});
