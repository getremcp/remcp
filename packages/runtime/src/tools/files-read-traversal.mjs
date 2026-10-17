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


import { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_INLINE_FILE_BYTES, READ_NOFOLLOW_NONBLOCK, detectEol, openDirectoryPath, openEntryAtPath, openRegularFile, readRegularBuffer } from './files-secure-paths.mjs';

export async function collectTree(root, { maxFiles = 500, skip = [], signal = null } = {}) {
  const found = [];
  const denied = [];
  const skipName = name => skip.some(entry => (entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : name === entry));
  const visitDirectory = async (directory, logicalBase) => {
    let entries;
    try {
      entries = await readdir(directory.anchor, { withFileTypes: true });
    } catch {
      denied.push(logicalBase);
      return;
    }
    for (const entry of entries) {
      throwIfCancelled(signal);
      if (found.length >= maxFiles) return;
      if (entry.isSymbolicLink() || skipName(entry.name)) continue;
      const childLogical = path.join(logicalBase, entry.name);
      const childAnchor = path.join(directory.anchor, entry.name);
      if (entry.isDirectory()) {
        let child;
        try {
          child = await openDirectoryPath(childAnchor);
          const info = await child.handle.stat();
          if (!info.isDirectory()) fail('Filesystem path component is not a directory');
          await visitDirectory(child, childLogical);
        } catch {
          denied.push(childLogical);
        } finally {
          if (child) await child.close().catch(() => {});
        }
      } else if (entry.isFile()) {
        let opened;
        try {
          opened = await openEntryAtPath(childAnchor, READ_NOFOLLOW_NONBLOCK);
          const info = await opened.handle.stat();
          if (info.isFile()) found.push(childLogical);
        } catch {
          denied.push(childLogical);
        } finally {
          if (opened) await opened.close().catch(() => {});
        }
      }
      if (found.length >= maxFiles) return;
    }
  };
  let directory;
  try {
    directory = await openDirectoryPath(root);
    await visitDirectory(directory, root);
  } catch {
    // A cancelled walk must not degrade into the "root is a single file" fallback below.
    throwIfCancelled(signal);
    let opened;
    try {
      opened = await openEntryAtPath(root, READ_NOFOLLOW_NONBLOCK);
      const info = await opened.handle.stat();
      if (info.isFile()) found.push(root);
      else denied.push(root);
    } catch {
      denied.push(root);
    } finally {
      if (opened) await opened.close().catch(() => {});
    }
  } finally {
    if (directory) await directory.close().catch(() => {});
  }
  return { files: found, denied };
}

// Every path a multi-file tool is about to touch passes through the same confinement check as a
// single-file call, so dropping the traversal shortcut cannot widen what is reachable.
export async function confineAll(paths) {
  const safe = [];
  for (const target of paths) {
    try { safe.push(await resolveSafePath(target)); } catch { /* outside the allowed roots: skip it */ }
  }
  return safe;
}

export async function readTextFile(absolute) {
  let opened;
  try { opened = await readRegularBuffer(absolute, MAX_INLINE_FILE_BYTES); }
  catch (error) {
    if (error?.code === 'ENOENT') fail(`File not found: ${displayPath(absolute)}`);
    throw error;
  }
  const { info, buffer } = opened;
  const decoded = decodeText(buffer);
  if (decoded.encoding === 'utf8' && looksBinary(buffer)) {
    fail(`${displayPath(absolute)} looks like a binary file and cannot be read as text. Use read_image for images, or get_file_info and hash_file for other binaries.`);
  }
  return { info, content: decoded.text, encoding: decoded.encoding, eol: detectEol(decoded.text) };
}

export async function readFileTool(args) {
  const absolute = await resolveSafePath(args.path);
  // Documents first: a .docx or .pdf is not text, and the binary guard below would refuse it.
  const kind = documentKind(absolute);
  if (kind) {
    const { buffer } = await readRegularBuffer(absolute, MAX_INLINE_FILE_BYTES);
    const extracted = kind === 'docx' ? readDocxText(buffer) : readPdfText(buffer);
    const documentLines = splitLines(extracted);
    const offset = Number.isFinite(Number(args.offset)) ? Math.trunc(Number(args.offset)) : 0;
    const length = clampInteger(args.length, liveConfig('maxReadLines'), 1, 10000);
    const page = pageLines(documentLines, offset, length);
    const label = kind === 'docx' ? 'Word document' : 'PDF text';
    const header = documentLines.length
      ? `${displayPath(absolute)} (${label}, lines ${page.start + 1}-${page.end} of ${documentLines.length})`
      : `${displayPath(absolute)} (${label}, no text)`;
    return text(`${header}
${page.slice.join('\n')}`);
  }
  const { content, encoding, eol } = await readTextFile(absolute);
  const lines = splitLines(content);
  const offset = Number.isFinite(Number(args.offset)) ? Math.trunc(Number(args.offset)) : 0;
  const length = clampInteger(args.length, liveConfig('maxReadLines'), 1, 10000);
  const { start, end, slice } = pageLines(lines, offset, length);
  const notes = `${encoding === 'utf8' ? '' : ` ${encoding}`}${eol === '\r\n' ? ' CRLF' : ''}`;
  const header = lines.length
    ? `${displayPath(absolute)} (lines ${start + 1}-${end} of ${lines.length}${notes})`
    : `${displayPath(absolute)} (empty file)`;
  return text(`${header}\n${slice.join('\n')}`);
}

export async function readMultipleFilesTool(args, extra = {}) {
  if (!Array.isArray(args.paths) || !args.paths.length) fail('paths must be a non-empty array');
  if (args.paths.length > 50) fail('paths accepts at most 50 entries per call');
  const sections = [];
  for (const entry of args.paths) {
    throwIfCancelled(extra.signal);
    let absolute;
    try {
      absolute = await resolveSafePath(entry, 'paths[]');
    } catch (error) {
      sections.push(`${String(entry)}: error - ${describeFilesystemFailure(error, { path: error?.path })}`);
      continue;
    }
    try {
      const { content } = await readTextFile(absolute);
      const lines = splitLines(content);
      const limit = liveConfig('maxReadLines');
      const slice = lines.slice(0, limit);
      const suffix = lines.length > limit ? `\n… ${lines.length - limit} more lines truncated` : '';
      sections.push(`${displayPath(absolute)}:\n${slice.join('\n')}${suffix}`);
    } catch (error) {
      sections.push(`${displayPath(absolute)}: error - ${describeFilesystemFailure(error, { path: error?.path })}`);
    }
  }
  return text(sections.join('\n\n'));
}

export async function readImageTool(args) {
  const absolute = await resolveSafePath(args.path);
  let opened;
  try { opened = await readRegularBuffer(absolute, MAX_IMAGE_BYTES); }
  catch (error) {
    if (error?.code === 'ENOENT') fail(`File not found: ${displayPath(absolute)}`);
    throw error;
  }
  const { info, buffer } = opened;
  const mimeType = IMAGE_TYPES.get(path.extname(absolute).toLowerCase());
  if (!mimeType) fail(`${displayPath(absolute)} is not a supported image type (${[...IMAGE_TYPES.keys()].join(', ')})`);
  if (mimeType === 'image/svg+xml') {
    const decoded = decodeText(buffer);
    if (decoded.encoding === 'utf8' && looksBinary(buffer)) fail(`${displayPath(absolute)} looks like a binary file`);
    return text(`SVG image ${displayPath(absolute)} (${info.size} bytes):\n${decoded.text}`);
  }
  return multi([
    { type: 'text', text: `${displayPath(absolute)} — ${mimeType}, ${info.size} bytes` },
    image(buffer.toString('base64'), mimeType),
  ]);
}

export async function hashFileTool(args) {
  const absolute = await resolveSafePath(args.path);
  let opened;
  try { opened = await openRegularFile(absolute); }
  catch (error) {
    if (error?.code === 'ENOENT') fail(`File not found: ${displayPath(absolute)}`);
    throw error;
  }
  const { handle, info } = opened;
  const algorithm = String(args.algorithm || 'sha256').toLowerCase();
  if (!['sha256', 'sha1', 'md5'].includes(algorithm)) { await opened.close(); fail('algorithm must be sha256, sha1, or md5'); }
  const hash = createHash(algorithm);
  try {
    await pipeline(createReadStream(absolute, { fd: handle.fd, autoClose: false }), hash);
    return text(`${algorithm} ${hash.digest('hex')}  ${displayPath(absolute)} (${info.size} bytes)`);
  } finally {
    await opened.close();
  }
}

export async function openListEntry(base, name) {
  const opened = await openEntryAtPath(path.join(base, name), READ_NOFOLLOW_NONBLOCK);
  try {
    return { handle: opened.handle, info: await opened.handle.stat(), close: opened.close };
  } catch (error) {
    await opened.close().catch(() => {});
    throw error;
  }
}

export async function listEntry(directory, depth, maxDepth, prefix, pattern, displayBase) {
  let entries;
  try {
    entries = await readdir(directory.anchor, { withFileTypes: true });
  } catch (error) {
    return [`${prefix}[DENIED] ${path.basename(displayBase)} (${error instanceof Error ? error.code || error.message : 'unreadable'})`];
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const rows = [];
  for (const entry of entries) {
    const childDisplay = path.join(displayBase, entry.name);
    if (entry.isDirectory()) {
      rows.push(`${prefix}[DIR] ${entry.name}`);
      if (depth >= maxDepth) continue;
      let child;
      try {
        child = await openDirectoryPath(path.join(directory.anchor, entry.name));
        const childInfo = await child.handle.stat();
        if (!childInfo.isDirectory()) fail('Filesystem path component is not a directory');
        rows.push(...await listEntry(child, depth + 1, maxDepth, `${prefix}  `.replace(/ {2}$/, '') + '  ', pattern, childDisplay));
      } catch (error) {
        rows.push(`${prefix}  [DENIED] ${entry.name} (${error instanceof Error ? error.code || error.message : 'unreadable'})`);
      } finally {
        if (child) await child.close().catch(() => {});
      }
    } else if (entry.isSymbolicLink()) {
      rows.push(`${prefix}[LINK] ${entry.name}`);
    } else {
      if (pattern && !pattern.test(entry.name)) continue;
      let opened;
      try {
        opened = await openListEntry(directory.anchor, entry.name);
        rows.push(`${prefix}[${opened.info.isFile() ? 'FILE' : 'SPECIAL'}] ${entry.name}${opened.info.isFile() ? ` (${opened.info.size} bytes)` : ''}`);
      } catch (error) {
        rows.push(`${prefix}[DENIED] ${entry.name} (${error instanceof Error ? error.code || error.message : 'unreadable'})`);
      } finally {
        if (opened) await opened.close().catch(() => {});
      }
    }
  }
  return rows;
}

export async function listDirectoryTool(args) {
  const absolute = await resolveSafePath(args.path);
  const depth = clampInteger(args.depth, 1, 1, 5);
  const pattern = typeof args.pattern === 'string' && args.pattern.trim() ? globToRegExp(args.pattern.trim()) : null;
  let directory;
  try {
    directory = await openDirectoryPath(absolute);
    const info = await directory.handle.stat();
    if (!info.isDirectory()) fail(`${displayPath(absolute)} is not a directory`);
    const rows = await listEntry(directory, 1, depth, '', pattern, absolute);
    return text(`${displayPath(absolute)}${pattern ? ` · matching ${args.pattern}` : ''}\n${rows.join('\n') || '(empty)'}`);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') fail(`Path not found: ${displayPath(absolute)}`);
    throw error;
  } finally {
    if (directory) await directory.close().catch(() => {});
  }
}

export async function openPathForInfo(absolute) {
  let directory;
  try {
    directory = await openDirectoryPath(absolute);
    return { info: await directory.handle.stat(), close: directory.close };
  } catch (directoryError) {
    const canTryFile = directoryError?.code === 'ENOTDIR'
      || directoryError?.code === 'EISDIR'
      || (!directoryError?.code && /not a directory/i.test(directoryError?.message || ''));
    if (!canTryFile) throw directoryError;
  }
  const opened = await openEntryAtPath(absolute, READ_NOFOLLOW_NONBLOCK);
  try {
    return { info: await opened.handle.stat(), close: opened.close };
  } catch (error) {
    await opened.close().catch(() => {});
    throw error;
  }
}

export async function getPathInfo(absolute) {
  const opened = await openPathForInfo(absolute);
  try { return opened.info; }
  finally { await opened.close().catch(() => {}); }
}

export async function getFileInfoTool(args) {
  const absolute = await resolveSafePath(args.path);
  let opened;
  try {
    opened = await openPathForInfo(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') fail(`Path not found: ${displayPath(absolute)}`);
    throw error;
  }
  const { info } = opened;
  try {
    const payload = {
      path: displayPath(absolute),
      type: info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : 'special',
      size: info.size,
      createdAt: info.birthtime.toISOString(),
      modifiedAt: info.mtime.toISOString(),
      permissions: `0${(info.mode & 0o777).toString(8)}`,
    };
    if (info.isFile() && info.size <= MAX_INLINE_FILE_BYTES) {
      const regular = await readRegularBuffer(absolute, MAX_INLINE_FILE_BYTES).catch(() => null);
      if (regular) {
        const decoded = decodeText(regular.buffer);
        if (decoded.encoding !== 'utf8') payload.encoding = decoded.encoding;
        if (decoded.encoding !== 'utf8' || !looksBinary(regular.buffer)) {
          const lines = splitLines(decoded.text);
          payload.lineCount = lines.length;
          payload.lastLine = Math.max(0, lines.length - 1);
          payload.eol = detectEol(decoded.text) === '\r\n' ? 'CRLF' : 'LF';
        }
      }
    }
    return text(JSON.stringify(payload, null, 2));
  } finally {
    await opened.close().catch(() => {});
  }
}
