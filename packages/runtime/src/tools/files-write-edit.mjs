import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, chmod, chown, copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { liveConfig, runtimeConfig } from '../config.mjs';
import { documentKind, readDocxText, readPdfText } from '../documents.mjs';
import { diffStats, unifiedDiff } from '../diff.mjs';
import { describeFilesystemFailure } from '../permissions.mjs';
import { capturePortalScreenshot, isWaylandSession } from '../screenshot-portal.mjs';
import { applyHunks, parseUnifiedDiff } from '../patch.mjs';
import { countEvent, recordEvent } from '../telemetry.mjs';
import { clampInteger, decodeText, displayPath, fail, fitsOutput, globToRegExp, image, isInsideRoot, looksBinary, multi, pageLines, resolveSafePath, splitLines, text, throwIfCancelled } from '../util.mjs';


import { MAX_BINARY_CHUNK_BYTES, MAX_INLINE_FILE_BYTES, READWRITE_NOFOLLOW, READ_NOFOLLOW, ensureDirectoryPath, openRegularFile, overwriteOpenFile, withExistingParent, withWritableParent, writeResolvedFile } from './files-secure-paths.mjs';
import { collectTree, confineAll, getPathInfo, readTextFile } from './files-read-traversal.mjs';
import { copyTreeContents } from './files-archive-safety.mjs';

export function assertWritableSize(content) {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > runtimeConfig.maxWriteBytes) {
    countEvent('writeDenials');
    recordEvent('write_denied', { reason: 'size_limit' });
    fail(`Content is ${bytes} bytes, above the ${runtimeConfig.maxWriteBytes}-byte write limit for this device`);
  }
  return bytes;
}

export async function writeFileTool(args) {
  const absolute = await resolveSafePath(args.path);
  const content = typeof args.content === 'string' ? args.content : fail('content must be a string');
  const providedMode = typeof args.mode === 'string' && args.mode.trim() ? args.mode.trim().toLowerCase() : '';
  if (providedMode && !['rewrite', 'append'].includes(providedMode)) fail('mode must be rewrite or append');
  const mode = providedMode || 'rewrite';
  const bytes = Buffer.byteLength(content, 'utf8');
  if (mode === 'rewrite') {
    assertWritableSize(content);
    if (content.includes('\0')) fail('content contains NUL bytes. For binary data pass encoding: "base64" (or use write_binary) so the file is written byte for byte.');
  } else {
    const existing = await stat(absolute).catch(() => null);
    const existingSize = existing?.isFile() ? existing.size : 0;
    if (existingSize + bytes > runtimeConfig.maxWriteBytes) {
      countEvent('writeDenials');
      recordEvent('write_denied', { reason: 'size_limit' });
      fail(`Appending ${bytes} bytes would grow ${displayPath(absolute)} to ${existingSize + bytes} bytes, above the ${runtimeConfig.maxWriteBytes}-byte write limit for this device`);
    }
  }
  await writeResolvedFile(absolute, content, { append: mode === 'append' });
  countEvent('bytesWritten', bytes);
  return text(`${mode === 'append' ? 'Appended' : 'Wrote'} ${bytes} bytes to ${displayPath(absolute)}.`);
}

// Binary transfer in both directions, in chunks: the relay carries MCP results, so a
// large file is read as a sequence of base64 slices and written back the same way.
export async function readBinaryTool(args) {
  const absolute = await resolveSafePath(args.path);
  let opened;
  try { opened = await openRegularFile(absolute); }
  catch (error) {
    if (error?.code === 'ENOENT') fail(`File not found: ${displayPath(absolute)}`);
    throw error;
  }
  const { handle, info } = opened;
  const offset = Math.max(0, Number.isFinite(Number(args.offset_bytes)) ? Math.trunc(Number(args.offset_bytes)) : 0);
  const length = clampInteger(args.length_bytes, MAX_BINARY_CHUNK_BYTES, 1, MAX_BINARY_CHUNK_BYTES);
  const start = Math.min(offset, info.size);
  const end = Math.min(info.size, start + length);
  try {
    const buffer = Buffer.alloc(end - start);
    if (buffer.length) await handle.read(buffer, 0, buffer.length, start);
    const renderPayload = lengthBytes => {
      const actualEnd = start + lengthBytes;
      return JSON.stringify({
        path: displayPath(absolute),
        size: info.size,
        offsetBytes: start,
        lengthBytes,
        nextOffsetBytes: actualEnd < info.size ? actualEnd : null,
        complete: actualEnd >= info.size,
        encoding: 'base64',
        data: buffer.subarray(0, lengthBytes).toString('base64'),
      });
    };
    let returnedLength = buffer.length;
    let payload = renderPayload(returnedLength);
    if (!fitsOutput(payload)) {
      let low = 0;
      let high = returnedLength;
      while (low < high) {
        const candidate = Math.ceil((low + high) / 2);
        if (fitsOutput(renderPayload(candidate))) low = candidate;
        else high = candidate - 1;
      }
      returnedLength = low;
      payload = renderPayload(returnedLength);
      if (!fitsOutput(payload)) fail('Runtime output limit is too small to return read_binary metadata');
    }
    return text(payload);
  } finally {
    await opened.close();
  }
}

export async function writeBinaryTool(args) {
  const absolute = await resolveSafePath(args.path);
  const data = typeof args.data === 'string' ? args.data : fail('data must be a base64 string');
  const mode = String(args.mode || 'rewrite').toLowerCase();
  if (!['rewrite', 'append'].includes(mode)) fail('mode must be rewrite or append');
  let buffer;
  try {
    buffer = Buffer.from(data.replace(/\s+/g, ''), 'base64');
  } catch {
    fail('data must be valid base64');
  }
  if (buffer.length > runtimeConfig.maxWriteBytes) {
    countEvent('writeDenials');
    recordEvent('write_denied', { reason: 'size_limit' });
    fail(`Decoded content is ${buffer.length} bytes, above the ${runtimeConfig.maxWriteBytes}-byte write limit for this device`);
  }
  await writeResolvedFile(absolute, buffer, { append: mode === 'append' });
  countEvent('bytesWritten', buffer.length);
  return text(`${mode === 'append' ? 'Appended' : 'Wrote'} ${buffer.length} bytes to ${displayPath(absolute)}.`);
}

export function normalizeForFuzzy(value) {
  return splitLines(value).map(line => line.replace(/[ \t]+/g, ' ').trim());
}

// Whitespace-tolerant fallback: models frequently re-indent an exact block they just
// read. Every candidate window is compared with collapsed whitespace, and the edit is
// applied only when the number of candidate windows matches expected_replacements.
export function fuzzyMatchStarts(lines, target) {
  const normalized = lines.map(line => line.replace(/[ \t]+/g, ' ').trim());
  const starts = [];
  for (let start = 0; start + target.length <= normalized.length; start += 1) {
    let equal = true;
    for (let index = 0; index < target.length; index += 1) {
      if (normalized[start + index] !== target[index]) { equal = false; break; }
    }
    if (equal) starts.push(start);
  }
  return starts;
}

export async function editBlockTool(args) {
  const absolute = await resolveSafePath(args.file_path, 'file_path');
  const oldString = typeof args.old_string === 'string' ? args.old_string : fail('old_string must be a string');
  const newString = typeof args.new_string === 'string' ? args.new_string : fail('new_string must be a string');
  if (!oldString) fail('old_string must not be empty');
  if (oldString === newString) fail('old_string and new_string are identical');
  const allowFuzzy = args.allow_fuzzy !== false;
  const dryRun = args.dry_run === true;
  const expected = Number.isInteger(Number(args.expected_replacements)) ? Math.max(1, Math.trunc(Number(args.expected_replacements))) : 1;
  const { content, eol } = await readTextFile(absolute);
  const occurrences = content.split(oldString).length - 1;

  const present = (updated, how) => {
    const stats = diffStats(content, updated);
    const summary = `${how} in ${displayPath(absolute)} (+${stats.added}/-${stats.removed} lines)`;
    if (!dryRun) return `${summary}.`;
    return `${summary}\n(dry run: nothing was written)\n${unifiedDiff(content, updated, { oldLabel: displayPath(absolute), newLabel: 'after' })}`;
  };

  if (occurrences === expected) {
    const updated = content.split(oldString).join(newString);
    assertWritableSize(updated);
    if (!dryRun) await writeResolvedFile(absolute, updated);
    return text(present(updated, `Replaced ${occurrences} occurrence(s)`));
  }
  if (occurrences > 0) {
    fail(`Expected ${expected} occurrence(s) of old_string but found ${occurrences}. Add more surrounding context.`);
  }
  if (!allowFuzzy) fail('old_string was not found in the file');
  const target = normalizeForFuzzy(oldString);
  const lines = splitLines(content);
  const starts = target.length ? fuzzyMatchStarts(lines, target) : [];
  if (starts.length !== expected) {
    fail(starts.length
      ? `old_string matched ${starts.length} block(s) after whitespace normalization, expected ${expected}. Add more surrounding context.`
      : 'old_string was not found in the file, even after whitespace normalization');
  }
  const replacement = splitLines(newString);
  const endsWithNewline = /\n$/.test(content);
  for (const start of [...starts].reverse()) lines.splice(start, target.length, ...replacement);
  // Rebuild with the file's own line ending: hard-coding \n silently rewrote every CRLF
  // file to LF and turned a one-line change into a whole-file diff on Windows.
  const updated = `${lines.join(eol)}${endsWithNewline && lines.length ? eol : ''}`;
  assertWritableSize(updated);
  if (!dryRun) await writeResolvedFile(absolute, updated);
  return text(present(updated, `Replaced ${starts.length} occurrence(s) using whitespace-tolerant matching (line endings kept as ${eol === '\r\n' ? 'CRLF' : 'LF'})`));
}

export async function replaceLinesTool(args) {
  const absolute = await resolveSafePath(args.path);
  const startLine = Number(args.start_line);
  const endLine = Number(args.end_line);
  if (!Number.isInteger(startLine) || startLine < 1) fail('start_line must be a positive integer (1-based)');
  if (!Number.isInteger(endLine) || endLine < startLine) fail('end_line must be an integer greater than or equal to start_line');
  const content = typeof args.content === 'string' ? args.content : fail('content must be a string');
  const dryRun = args.dry_run === true;
  const { content: original, eol } = await readTextFile(absolute);
  const lines = splitLines(original);
  if (startLine > lines.length) fail(`${displayPath(absolute)} has ${lines.length} lines; start_line ${startLine} is past the end`);
  const endsWithNewline = /\n$/.test(original);
  const replacement = splitLines(content);
  const updated = [...lines.slice(0, startLine - 1), ...replacement, ...lines.slice(Math.min(endLine, lines.length))];
  const updatedText = `${updated.join(eol)}${endsWithNewline && updated.length ? eol : ''}`;
  assertWritableSize(updatedText);
  const stats = diffStats(original, updatedText);
  const summary = `Replaced lines ${startLine}-${Math.min(endLine, lines.length)} of ${displayPath(absolute)} (+${stats.added}/-${stats.removed} lines)`;
  if (dryRun) {
    return text(`${summary}\n(dry run: nothing was written)\n${unifiedDiff(original, updatedText, { oldLabel: displayPath(absolute), newLabel: 'after' })}`);
  }
  await writeResolvedFile(absolute, updatedText);
  return text(`${summary}.`);
}

export async function replaceInFilesTool(args, extra = {}) {
  const root = await resolveSafePath(args.path);
  const pattern = typeof args.pattern === 'string' && args.pattern ? args.pattern : fail('pattern is required');
  const replacement = typeof args.replacement === 'string' ? args.replacement : fail('replacement must be a string');
  const filePattern = typeof args.filePattern === 'string' && args.filePattern.trim() ? args.filePattern.trim() : null;
  const isRegex = args.regex === true;
  // Applying is the default: the agent is expected to act, and a dry run is available
  // when a caller explicitly wants a preview.
  const dryRun = args.dry_run === true;
  const maxFiles = clampInteger(args.maxFiles, 100, 1, 500);
  let matcher = null;
  if (isRegex) {
    try { matcher = new RegExp(pattern, 'g'); } catch (error) {
      fail(`pattern is not a valid regular expression (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const info = await getPathInfo(root).catch(() => fail(`Path not found: ${displayPath(root)}`));
  const walk = info.isFile() ? { files: [root], denied: [] } : await collectTree(root, { maxFiles, skip: ['.git', 'node_modules', '.remcp-trash*'], signal: extra.signal });
  const files = await confineAll(walk.files);
  const glob = filePattern ? globToRegExp(filePattern) : null;
  const changed = [];
  let scanned = 0;
  for (const file of files) {
    throwIfCancelled(extra.signal);
    if (changed.length >= maxFiles) break;
    if (glob && !glob.test(path.basename(file))) continue;
    let opened;
    try { opened = await openRegularFile(file, dryRun ? READ_NOFOLLOW : READWRITE_NOFOLLOW); }
    catch { continue; }
    const { handle, info: fileInfo } = opened;
    try {
      if (fileInfo.size > MAX_INLINE_FILE_BYTES) continue;
      const buffer = await handle.readFile();
      const decoded = decodeText(buffer);
      if (decoded.encoding === 'utf8' && looksBinary(buffer)) continue;
      scanned += 1;
      const original = decoded.text;
      const count = isRegex ? (original.match(matcher) || []).length : original.split(pattern).length - 1;
      if (!count) continue;
      if (isRegex) matcher.lastIndex = 0;
      const updated = isRegex ? original.replace(matcher, replacement) : original.split(pattern).join(replacement);
      if (updated === original) continue;
      assertWritableSize(updated);
      if (!dryRun) await overwriteOpenFile(handle, updated);
      const stats = diffStats(original, updated);
      changed.push({ file: displayPath(file), replacements: count, added: stats.added, removed: stats.removed });
    } finally {
      await opened.close();
    }
  }
  if (!changed.length) return text(`No matches for ${JSON.stringify(pattern)} in ${displayPath(root)} (${scanned} text files scanned).`);
  const rows = changed.map(entry => `${dryRun ? 'would change' : 'changed'} ${entry.file} · ${entry.replacements} replacement(s) · +${entry.added}/-${entry.removed} lines`);
  const header = `${dryRun ? 'Dry run' : 'Applied'}: ${changed.length} file(s), ${changed.reduce((sum, entry) => sum + entry.replacements, 0)} replacement(s)`;
  const hint = dryRun ? '\nNothing was written. Call again with dry_run: false to apply.' : '';
  return text(`${header}\n${rows.join('\n')}${hint}`);
}

export async function diffFilesTool(args) {
  const left = await resolveSafePath(args.left, 'left');
  const right = await resolveSafePath(args.right, 'right');
  const context = clampInteger(args.context_lines, 3, 0, 20);
  const a = await readTextFile(left);
  const b = await readTextFile(right);
  const diff = unifiedDiff(a.content, b.content, { oldLabel: displayPath(left), newLabel: displayPath(right), context });
  if (!diff) return text(`${displayPath(left)} and ${displayPath(right)} are identical (${a.content.length} bytes).`);
  const stats = diffStats(a.content, b.content);
  return text(`${displayPath(left)} → ${displayPath(right)} (+${stats.added}/-${stats.removed} lines)\n${diff}`);
}

export function trashDirectoryFor() {
  if (process.platform === 'darwin') return path.join(os.homedir(), '.Trash');
  if (process.platform === 'win32') return null;
  return path.join(os.homedir(), '.local', 'share', 'Trash', 'files');
}

export async function moveToTrashTool(args) {
  const source = await resolveSafePath(args.source, 'source');
  const trash = trashDirectoryFor();
  let destination = null;
  if (trash) {
    // The trash lives outside the allowed roots, so only use it when confinement permits
    // it; otherwise fall back to a trash folder beside the file.
    try {
      await resolveSafePath(trash, 'trash');
      destination = trash;
    } catch { destination = null; }
  }
  if (!destination) destination = path.join(path.dirname(source), '.remcp-trash');
  const existingDestination = await lstat(destination).catch(() => null);
  if (existingDestination?.isSymbolicLink()) fail('Refusing to use a symlink as the trash directory');
  if (existingDestination && !existingDestination.isDirectory()) fail('Trash destination is not a directory');
  await ensureDirectoryPath(destination);
  destination = await resolveSafePath(destination, 'trash');
  const destinationInfo = await lstat(destination);
  if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) fail('Refusing to use a symlink as the trash directory');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let target = path.join(destination, `${stamp}-${path.basename(source)}`);
  let counter = 1;
  while (await lstat(target).then(value => Boolean(value), () => false)) {
    target = path.join(destination, `${stamp}-${counter}-${path.basename(source)}`);
    counter += 1;
  }
  await withExistingParent(source, async anchoredSource => {
    const sourceInfo = await lstat(anchoredSource).catch(() => fail(`Path not found: ${displayPath(source)}`));
    if (sourceInfo.isSymbolicLink()) fail('source cannot be a symbolic link');
    await withWritableParent(target, async anchoredTarget => {
      await rename(anchoredSource, anchoredTarget).catch(async error => {
        if (error?.code !== 'EXDEV') throw error;
        if (sourceInfo.isDirectory()) fail('Moving a directory to the trash across filesystems is not supported');
        await copyTreeContents(anchoredSource, anchoredTarget, { entries:0, bytes:0, maxBytes:Number.MAX_SAFE_INTEGER });
        await rm(anchoredSource, { force:true });
      });
    });
  });
  return text(`Moved ${displayPath(source)} to ${displayPath(target)}. Restore it with move_file if this was a mistake.`);
}
