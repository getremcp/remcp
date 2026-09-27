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
import { clampInteger, decodeText, displayPath, fail, globToRegExp, image, isInsideRoot, looksBinary, multi, pageLines, resolveSafePath, splitLines, text, throwIfCancelled } from '../util.mjs';

const MAX_INLINE_FILE_BYTES = 20 * 1024 * 1024;
// An image travels base64-encoded, which costs a third more bytes. The agent's stdio transport holds
// 24 MiB and the relay's WebSocket frames hold 32 MiB, so 8 MiB of image is ~11 MiB on the wire with
// room to spare; anything larger goes through read_binary in chunks instead. Binary chunks are 4 MiB
// for the same reason: four times fewer round trips for the same file.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_BINARY_CHUNK_BYTES = 1024 * 1024;
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.bmp', 'image/bmp'], ['.svg', 'image/svg+xml'], ['.avif', 'image/avif'],
]);

function detectEol(content) {
  const crlf = (content.match(/\r\n/g) || []).length;
  const lf = (content.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}

// Only regular files can be read: a FIFO blocks until a writer appears, a device node can be
// endless, and both would hang or flood a tool call instead of returning an answer.
function assertRegularFile(info, absolute) {
  if (info.isDirectory()) fail(`${displayPath(absolute)} is a directory, not a file`);
  if (!info.isFile()) fail(`${displayPath(absolute)} is not a regular file`);
  return info;
}

const NOFOLLOW = constants.O_NOFOLLOW || 0;
const NONBLOCK = constants.O_NONBLOCK || 0;
const READ_NOFOLLOW = constants.O_RDONLY | NOFOLLOW;
const READ_NOFOLLOW_NONBLOCK = READ_NOFOLLOW | NONBLOCK;
const READWRITE_NOFOLLOW = constants.O_RDWR | NOFOLLOW;
const WRITE_CREATE_NOFOLLOW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW | NONBLOCK;
const WRITE_TRUNCATE_NOFOLLOW = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW | NONBLOCK;
const DIRECTORY_READ_NOFOLLOW = constants.O_RDONLY | (constants.O_DIRECTORY || 0) | NOFOLLOW | NONBLOCK;

async function openDirectoryFromFilesystemRoot(absolute) {
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  const directories = [];
  let current = root;
  const closeDirectories = async () => {
    for (const handle of directories.reverse()) await handle.close().catch(() => {});
  };
  try {
    const rootHandle = await open(root, DIRECTORY_READ_NOFOLLOW);
    directories.push(rootHandle);
    current = `/proc/self/fd/${rootHandle.fd}`;
    for (const part of parts) {
      const candidate = path.join(current, part);
      const next = await open(candidate, DIRECTORY_READ_NOFOLLOW);
      try {
        const info = await next.stat();
        if (!info.isDirectory()) fail('Filesystem path component is not a directory');
        directories.push(next);
        current = `/proc/self/fd/${next.fd}`;
      } catch (error) {
        await next.close().catch(() => {});
        throw error;
      }
    }
    const handle = directories.pop();
    return {
      handle,
      anchor: current,
      close: async () => {
        try { await handle.close(); }
        finally { await closeDirectories(); }
      },
    };
  } catch (error) {
    await closeDirectories();
    throw error;
  }
}

const secureRootPromises = new Map();

async function secureAllowedRoot(root) {
  if (!secureRootPromises.has(root)) {
    secureRootPromises.set(root, openDirectoryFromFilesystemRoot(root));
  }
  try {
    return await secureRootPromises.get(root);
  } catch (error) {
    secureRootPromises.delete(root);
    throw error;
  }
}

async function cloneDirectory(directory) {
  const handle = await open(`${directory.anchor}/.`, DIRECTORY_READ_NOFOLLOW);
  return {
    handle,
    anchor: `/proc/self/fd/${handle.fd}`,
    close: () => handle.close(),
  };
}

async function openConfinedDirectoryPath(absolute, create) {
  if (!runtimeConfig.allowedRoots.length || absolute.startsWith('/proc/')) return null;
  const root = runtimeConfig.allowedRoots.find(candidate => isInsideRoot(absolute, candidate));
  if (!root) return null;
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const rootDirectory = await secureAllowedRoot(root);
  const directories = [];
  let current = rootDirectory.anchor;
  const closeDirectories = async () => {
    for (const handle of directories.reverse()) await handle.close().catch(() => {});
  };
  try {
    for (const part of relative.split(path.sep).filter(Boolean)) {
      const candidate = path.join(current, part);
      if (create) {
        await mkdir(candidate, { mode:0o700 }).catch(error => {
          if (error?.code !== 'EEXIST') throw error;
        });
      }
      const handle = await open(candidate, DIRECTORY_READ_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isDirectory()) {
        await handle.close().catch(() => {});
        fail('Filesystem path component is not a directory');
      }
      directories.push(handle);
      current = `/proc/self/fd/${handle.fd}`;
    }
    if (!directories.length) return cloneDirectory(rootDirectory);
    const handle = directories.pop();
    return {
      handle,
      anchor: current,
      close: async () => {
        try { await handle.close(); }
        finally { await closeDirectories(); }
      },
    };
  } catch (error) {
    await closeDirectories();
    throw error;
  }
}

async function openDescriptorDirectoryPath(absolute, create) {
  const match = absolute.match(/^(\/proc\/(?:self|\d+)\/fd\/\d+)(?:\/(.*))?$/);
  if (!match) return null;
  // The proc-fd entry itself is a symlink. Make it an intermediate component so
  // O_NOFOLLOW protects the referenced directory entry rather than rejecting procfs.
  const base = await open(`${match[1]}/.`, DIRECTORY_READ_NOFOLLOW);
  const directories = [base];
  let current = `/proc/self/fd/${base.fd}`;
  const closeDirectories = async () => {
    for (const handle of directories.reverse()) await handle.close().catch(() => {});
  };
  try {
    for (const part of (match[2] || '').split(path.sep).filter(Boolean)) {
      const candidate = path.join(current, part);
      if (create) {
        await mkdir(candidate, { mode:0o700 }).catch(error => {
          if (error?.code !== 'EEXIST') throw error;
        });
      }
      const handle = await open(candidate, DIRECTORY_READ_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isDirectory()) {
        await handle.close().catch(() => {});
        fail('Filesystem path component is not a directory');
      }
      directories.push(handle);
      current = `/proc/self/fd/${handle.fd}`;
    }
    const handle = directories.pop();
    return {
      handle,
      anchor: current,
      close: async () => {
        try { await handle.close(); }
        finally { await closeDirectories(); }
      },
    };
  } catch (error) {
    await closeDirectories();
    throw error;
  }
}

export async function openDirectoryPath(absolute, { create = false, allowOutside = false } = {}) {
  const descriptorBound = process.platform === 'linux' && Boolean(constants.O_NOFOLLOW) && Boolean(constants.O_DIRECTORY);
  if (!descriptorBound) {
    if (create) await mkdir(absolute, { recursive:true, mode:0o700 });
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isDirectory()) fail('Filesystem path component is not a safe directory');
    const handle = {
      stat: () => stat(absolute),
      chmod: mode => chmod(absolute, mode),
      close: async () => {},
    };
    return { handle, anchor:absolute, descriptorBound:false, close: handle.close };
  }
  const confinedPath = await openConfinedDirectoryPath(absolute, create);
  if (confinedPath) return confinedPath;
  const descriptorPath = await openDescriptorDirectoryPath(absolute, create);
  if (descriptorPath) return descriptorPath;
  if (runtimeConfig.allowedRoots.length && !allowOutside) fail('Path is outside the directories this device allows');
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  if (!parts.length) {
    const handle = await open(root, DIRECTORY_READ_NOFOLLOW);
    return { handle, anchor: `/proc/self/fd/${handle.fd}`, close: () => handle.close() };
  }
  const directories = [];
  let current = root;
  const closeDirectories = async () => {
    for (const handle of directories.reverse()) await handle.close().catch(() => {});
  };
  try {
    for (const part of parts) {
      const candidate = path.join(current, part);
      if (create) {
        await mkdir(candidate, { mode:0o700 }).catch(error => {
          if (error?.code !== 'EEXIST') throw error;
        });
      }
      const handle = await open(candidate, DIRECTORY_READ_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isDirectory()) {
        await handle.close().catch(() => {});
        fail('Filesystem path component is not a directory');
      }
      directories.push(handle);
      current = `/proc/self/fd/${handle.fd}`;
    }
    const handle = directories.pop();
    return {
      handle,
      anchor: current,
      close: async () => {
        try { await handle.close(); }
        finally { await closeDirectories(); }
      },
    };
  } catch (error) {
    await closeDirectories();
    throw error;
  }
}

async function openEntryAtPath(absolute, flags) {
  const descriptorFile = /^\/proc\/(?:self|\d+)\/fd\/\d+$/.test(absolute);
  if (process.platform === 'linux' && constants.O_NOFOLLOW && constants.O_DIRECTORY && !descriptorFile) {
    const parent = await openDirectoryPath(path.dirname(absolute));
    try {
      const handle = await open(path.join(parent.anchor, path.basename(absolute)), flags);
      return {
        handle,
        close: async () => {
          try { await handle.close(); }
          finally { await parent.close().catch(() => {}); }
        },
      };
    } catch (error) {
      await parent.close().catch(() => {});
      throw error;
    }
  }
  const handle = await open(absolute, flags);
  return { handle, close: () => handle.close() };
}

// A hard link inside an allowed root is the one escape path-based confinement cannot see: the very
// same inode is reachable from outside the root, so a read or write here is visible there (round 2
// audit R2-14). The allowlist is a guardrail, not an inode boundary, so this warns instead of
// refusing — refusing would break legitimate layouts (backups, dotfile managers, deduplicated
// stores). One warning per path keeps a hot loop from flooding the log.
const hardlinkWarned = new Set();

function warnOnHardlink(label, info) {
  if (!Number.isFinite(info?.nlink) || info.nlink <= 1 || hardlinkWarned.has(label)) return;
  if (hardlinkWarned.size > 1000) hardlinkWarned.clear();
  hardlinkWarned.add(label);
  countEvent('hardlinkWarnings');
  console.warn(`ReMCP runtime: ${label} has ${info.nlink} hard links, so the same file is reachable from outside the allowed roots`);
}

async function openRegularFileAtPath(absolute, flags, label = absolute) {
  const opened = await openEntryAtPath(absolute, flags);
  try {
    const info = assertRegularFile(await opened.handle.stat(), label);
    warnOnHardlink(label, info);
    return { handle: opened.handle, info, close: opened.close };
  } catch (error) {
    await opened.close().catch(() => {});
    throw error;
  }
}

export async function openRegularFile(absolute, flags = READ_NOFOLLOW) {
  return openRegularFileAtPath(absolute, flags, absolute);
}

async function openWritableParent(absolute, options = {}) {
  if (process.platform === 'linux' && constants.O_NOFOLLOW && constants.O_DIRECTORY) {
    return openDirectoryPath(absolute, { create:true, ...options });
  }
  await mkdir(absolute, { recursive:true });
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) fail('Filesystem path component is not a directory');
  return { anchor:absolute, close:async() => {} };
}

async function writeResolvedFile(absolute, content, { append = false } = {}) {
  const parent = await openWritableParent(path.dirname(absolute));
  let handle;
  try {
    const flags = append
      ? constants.O_WRONLY | constants.O_CREAT | (constants.O_APPEND || 0) | NOFOLLOW | NONBLOCK
      : WRITE_TRUNCATE_NOFOLLOW;
    handle = await open(path.join(parent.anchor, path.basename(absolute)), flags, 0o600);
    await handle.writeFile(content);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await parent.close().catch(() => {});
  }
}

async function withWritableParent(absolute, callback) {
  const parent = await openWritableParent(path.dirname(absolute));
  try {
    return await callback(path.join(parent.anchor, path.basename(absolute)));
  } finally {
    await parent.close().catch(() => {});
  }
}

async function openExistingParent(absolute) {
  if (process.platform === 'linux' && constants.O_NOFOLLOW && constants.O_DIRECTORY) {
    return openDirectoryPath(absolute);
  }
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) fail('Filesystem path component is not a directory');
  return { anchor:absolute, close:async() => {} };
}

async function withExistingParent(absolute, callback) {
  const parent = await openExistingParent(path.dirname(absolute));
  try {
    return await callback(path.join(parent.anchor, path.basename(absolute)));
  } finally {
    await parent.close().catch(() => {});
  }
}

async function ensureDirectoryPath(absolute, options = {}) {
  if (process.platform === 'linux' && constants.O_NOFOLLOW && constants.O_DIRECTORY) {
    const directory = await openDirectoryPath(absolute, { create:true, ...options });
    await directory.close();
    return;
  }
  await mkdir(absolute, { recursive:true });
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) fail('Filesystem path component is not a directory');
}

async function readRegularBuffer(absolute, maxBytes = Infinity) {
  const opened = await openRegularFile(absolute);
  const { handle, info } = opened;
  try {
    if (info.size > maxBytes) fail(`File is too large to read inline (${info.size} bytes)`);
    return { info, buffer: await handle.readFile() };
  } finally {
    await opened.close();
  }
}

async function overwriteOpenFile(handle, content) {
  const buffer = Buffer.from(content, 'utf8');
  await handle.truncate(0);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);
    if (!bytesWritten) throw new Error('Could not finish writing the open file');
    offset += bytesWritten;
  }
  await handle.truncate(buffer.length);
}

// Traversal helper for every multi-file tool. A symbolic link inside an allowed root can point
// anywhere, so links are never followed and each collected path is resolved through
// resolveSafePath again before a tool reads or writes it. `stat` follows links, which is exactly
// how a symlinked directory inside a root used to expose files outside it.
async function collectTree(root, { maxFiles = 500, skip = [], signal = null } = {}) {
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
async function confineAll(paths) {
  const safe = [];
  for (const target of paths) {
    try { safe.push(await resolveSafePath(target)); } catch { /* outside the allowed roots: skip it */ }
  }
  return safe;
}

async function readTextFile(absolute) {
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

async function openListEntry(base, name) {
  const opened = await openEntryAtPath(path.join(base, name), READ_NOFOLLOW_NONBLOCK);
  try {
    return { handle: opened.handle, info: await opened.handle.stat(), close: opened.close };
  } catch (error) {
    await opened.close().catch(() => {});
    throw error;
  }
}

async function listEntry(directory, depth, maxDepth, prefix, pattern, displayBase) {
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

async function openPathForInfo(absolute) {
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

async function getPathInfo(absolute) {
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

function assertWritableSize(content) {
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
    const payload = JSON.stringify({
      path: displayPath(absolute),
      size: info.size,
      offsetBytes: start,
      lengthBytes: buffer.length,
      nextOffsetBytes: end < info.size ? end : null,
      complete: end >= info.size,
      encoding: 'base64',
      data: buffer.toString('base64'),
    });
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

function normalizeForFuzzy(value) {
  return splitLines(value).map(line => line.replace(/[ \t]+/g, ' ').trim());
}

// Whitespace-tolerant fallback: models frequently re-indent an exact block they just
// read. Every candidate window is compared with collapsed whitespace, and the edit is
// applied only when the number of candidate windows matches expected_replacements.
function fuzzyMatchStarts(lines, target) {
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

function trashDirectoryFor() {
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

export async function readFilesTool(args, extra = {}) {
  // Glob-first bulk read: one call fills the model's context with every file that matters
  // instead of one round trip per path.
  const root = await resolveSafePath(args.path || '.');
  const pattern = typeof args.pattern === 'string' && args.pattern.trim() ? args.pattern.trim() : '**/*';
  const maxFiles = clampInteger(args.max_files, 100, 1, 500);
  const maxLinesPerFile = clampInteger(args.max_lines_per_file, liveConfig('maxReadLines'), 1, 20000);
  const includeIgnored = args.include_ignored === true;
  const matcher = globToRegExp(pattern);
  const rootInfo = await getPathInfo(root).catch(() => null);
  // A file path is matched directly; a directory is walked without following links.
  const walk = rootInfo?.isFile()
    ? { files: [root], denied: [] }
    : await collectTree(root, {
      maxFiles: maxFiles + 1,
      skip: includeIgnored ? ['.remcp-trash*'] : ['node_modules', '.git', '.remcp-trash*'],
      signal: extra.signal,
    });
  const candidates = await confineAll(walk.files);
  const matched = candidates.filter(target => {
    const relative = path.relative(root, target) || path.basename(target);
    return matcher.test(relative.split(path.sep).join('/')) || matcher.test(path.basename(target));
  });
  const files = matched.slice(0, maxFiles);
  if (!files.length) return text(`No files matched ${pattern} under ${displayPath(root)}.`);
  const sections = [];
  let skipped = 0;
  for (const file of files.slice(0, maxFiles)) {
    throwIfCancelled(extra.signal);
    try {
      const { content, encoding } = await readTextFile(file);
      const lines = splitLines(content);
      const slice = lines.slice(0, maxLinesPerFile);
      const suffix = lines.length > maxLinesPerFile ? `\n… ${lines.length - maxLinesPerFile} more lines (use read_file with offset)` : '';
      sections.push(`===== ${displayPath(file)} (${lines.length} lines${encoding === 'utf8' ? '' : `, ${encoding}`}) =====\n${slice.join('\n')}${suffix}`);
    } catch (error) {
      skipped += 1;
      sections.push(`===== ${displayPath(file)} =====\n(skipped: ${describeFilesystemFailure(error, { path: error?.path })})`);
    }
  }
  const notes = [];
  if (matched.length > files.length) notes.push(`showing the first ${files.length}`);
  if (skipped) notes.push(`${skipped} unreadable`);
  if (walk.denied.length) notes.push(`${walk.denied.length} unreadable director${walk.denied.length === 1 ? 'y' : 'ies'} skipped`);
  const header = `${matched.length} file(s) matched ${pattern} under ${displayPath(root)}${notes.length ? ` (${notes.join(', ')})` : ''}`;
  return text(`${header}\n\n${sections.join('\n\n')}`);
}

export async function writeFilesTool(args, extra = {}) {
  // Bulk write for scaffolding: one call creates or replaces many files.
  const files = Array.isArray(args.files) ? args.files : fail('files must be an array of { path, content } objects');
  if (!files.length) fail('files must not be empty');
  if (files.length > 200) fail('files accepts at most 200 entries per call');
  const results = [];
  let totalBytes = 0;
  for (const entry of files) {
    throwIfCancelled(extra.signal);
    const target = typeof entry?.path === 'string' ? entry.path : null;
    if (!target) { results.push('skipped: entry without a path'); continue; }
    if (typeof entry.content !== 'string') { results.push(`skipped ${target}: content must be a string`); continue; }
    try {
      const absolute = await resolveSafePath(target);
      const content = entry.content;
      if (content.includes('\0')) throw new Error('content contains NUL bytes; use write_binary for binary data');
      const bytes = assertWritableSize(content);
      totalBytes += bytes;
      if (totalBytes > runtimeConfig.maxWriteBytes * 4) fail(`This call would write ${totalBytes} bytes, above the ${runtimeConfig.maxWriteBytes * 4}-byte batch limit`);
      await writeResolvedFile(absolute, content, { append: entry.mode === 'append' });
      results.push(`${entry.mode === 'append' ? 'appended' : 'wrote'} ${displayPath(absolute)} (${bytes} bytes)`);
    } catch (error) {
      results.push(`failed ${target}: ${describeFilesystemFailure(error, { path: error?.path })}`);
    }
  }
  countEvent('bytesWritten', totalBytes);
  const failed = results.filter(line => line.startsWith('failed') || line.startsWith('skipped')).length;
  return text(`${results.length - failed}/${results.length} file(s) written, ${totalBytes} bytes total\n${results.join('\n')}`, failed > 0);
}

export async function deletePathTool(args) {
  const absolute = await resolveSafePath(args.path);
  if (path.dirname(absolute) === absolute) fail(`Refusing to delete the filesystem root ${displayPath(absolute)}`);
  const recursive = args.recursive !== false;
  let info;
  let entries = [];
  await withExistingParent(absolute, async target => {
    info = await lstat(target).catch(() => fail(`Path not found: ${displayPath(absolute)}`));
    if (info.isDirectory() && !recursive) {
      entries = await readdir(target).catch(() => []);
      if (entries.length) fail(`Directory is not empty: ${displayPath(absolute)}. Pass recursive: true to delete it with its contents.`);
    }
    if (info.isDirectory()) entries = await readdir(target).catch(() => []);
    await rm(target, { recursive:true, force:false });
  });
  return text(`Deleted ${info.isDirectory() ? 'directory' : 'file'} ${displayPath(absolute)}${info.isDirectory() ? ` and its ${entries.length} top-level entr${entries.length === 1 ? 'y' : 'ies'}` : ''}.`);
}

export async function deletePathsTool(args, extra = {}) {
  const paths = Array.isArray(args.paths) ? args.paths : fail('paths must be an array of absolute paths');
  if (!paths.length) fail('paths must not be empty');
  if (paths.length > 500) fail('paths accepts at most 500 entries per call');
  const recursive = args.recursive !== false;
  const results = [];
  let deleted = 0;
  for (const entry of paths) {
    throwIfCancelled(extra.signal);
    try {
      const absolute = await resolveSafePath(entry, 'paths[]');
      if (path.dirname(absolute) === absolute) throw new Error('refusing to delete the filesystem root');
      await withExistingParent(absolute, async target => {
        const info = await lstat(target).catch(() => null);
        if (!info) throw new Error('not found');
        if (info.isDirectory() && !recursive) {
          const children = await readdir(target).catch(() => []);
          if (children.length) throw new Error('directory is not empty (pass recursive: true)');
        }
        await rm(target, { recursive:true, force:false });
      });
      deleted += 1;
      results.push(`deleted ${displayPath(absolute)}`);
    } catch (error) {
      results.push(`failed ${entry}: ${describeFilesystemFailure(error, { path: error?.path })}`);
    }
  }
  return text(`${deleted}/${paths.length} path(s) deleted\n${results.join('\n')}`, deleted !== paths.length);
}

// Recursive copy for files and whole directories, so a project or a backup can be
// duplicated in one call.
export async function copyPathsTool(args, extra = {}) {
  const pairs = Array.isArray(args.paths) ? args.paths : fail('paths must be an array of { source, destination } objects');
  if (!pairs.length) fail('paths must not be empty');
  if (pairs.length > 200) fail('paths accepts at most 200 entries per call');
  const overwrite = args.overwrite !== false;
  const results = [];
  let copied = 0;
  for (const entry of pairs) {
    throwIfCancelled(extra.signal);
    try {
      const source = await resolveSafePath(entry?.source, 'paths[].source');
      const destination = await resolveSafePath(entry?.destination, 'paths[].destination');
      if (source === destination) throw new Error('source and destination are the same path');
      await withWritableParent(destination, async anchoredDestination => {
        const existing = await lstat(anchoredDestination).catch(() => null);
        if (existing && !overwrite) throw new Error('destination already exists (pass overwrite: true)');
        await copyTreeContents(source, anchoredDestination, { entries:0, bytes:0, maxBytes:Number.MAX_SAFE_INTEGER, signal: extra.signal });
      });
      copied += 1;
      results.push(`copied ${displayPath(source)} → ${displayPath(destination)}`);
    } catch (error) {
      results.push(`failed ${entry?.source ?? '?'}: ${describeFilesystemFailure(error, { path: error?.path })}`);
    }
  }
  return text(`${copied}/${pairs.length} path(s) copied\n${results.join('\n')}`, copied !== pairs.length);
}

export async function movePathsTool(args, extra = {}) {
  const pairs = Array.isArray(args.paths) ? args.paths : fail('paths must be an array of { source, destination } objects');
  if (!pairs.length) fail('paths must not be empty');
  if (pairs.length > 200) fail('paths accepts at most 200 entries per call');
  const overwrite = args.overwrite !== false;
  const results = [];
  let moved = 0;
  for (const entry of pairs) {
    throwIfCancelled(extra.signal);
    try {
      const source = await resolveSafePath(entry?.source, 'paths[].source');
      const destination = await resolveSafePath(entry?.destination, 'paths[].destination');
      if (source === destination) throw new Error('source and destination are the same path');
      await withExistingParent(source, async anchoredSource => {
        const sourceInfo = await lstat(anchoredSource).catch(() => null);
        if (!sourceInfo) throw new Error('source not found');
        if (sourceInfo.isSymbolicLink()) throw new Error('source cannot be a symbolic link');
        await withWritableParent(destination, async anchoredDestination => {
          const existing = await lstat(anchoredDestination).catch(() => null);
          if (existing && !overwrite) throw new Error('destination already exists (pass overwrite: true)');
          try {
            await rename(anchoredSource, anchoredDestination);
          } catch (error) {
            if (error?.code !== 'EXDEV') throw error;
            await copyTreeContents(anchoredSource, anchoredDestination, { entries:0, bytes:0, maxBytes:Number.MAX_SAFE_INTEGER, signal: extra.signal });
            await rm(anchoredSource, { recursive:true, force:true });
          }
        });
      });
      moved += 1;
      results.push(`moved ${displayPath(source)} → ${displayPath(destination)}`);
    } catch (error) {
      results.push(`failed ${entry?.source ?? '?'}: ${describeFilesystemFailure(error, { path: error?.path })}`);
    }
  }
  return text(`${moved}/${pairs.length} path(s) moved\n${results.join('\n')}`, moved !== pairs.length);
}

// Applying a unified diff is the fastest path from "the model knows the change" to "the
// change is on disk": no exact-block matching, no re-sending whole files.
export async function applyPatchTool(args) {
  const patch = typeof args.patch === 'string' && args.patch.trim() ? args.patch : fail('patch must be a unified diff');
  const dryRun = args.dry_run === true;
  const forcePath = typeof args.path === 'string' && args.path.trim() ? args.path : null;
  const files = parseUnifiedDiff(patch);
  if (!files.length) fail('patch does not contain any @@ hunks');
  const results = [];
  let changed = 0;
  for (const file of files) {
    const target = forcePath || (file.newPath && file.newPath !== '/dev/null' ? file.newPath : file.oldPath);
    if (!target || target === '/dev/null') { results.push('failed: a hunk has no target path; pass path explicitly'); continue; }
    try {
      const absolute = await resolveSafePath(target);
      let original = '';
      try { original = (await readTextFile(absolute)).content; } catch (error) {
        if (file.oldPath === '/dev/null' || /not found/i.test(error?.message || '')) original = '';
        else throw error;
      }
      const { updated, applied, failed } = applyHunks(original, file.hunks);
      if (failed.length && !applied.length) { results.push(`failed ${displayPath(absolute)}: none of the ${file.hunks.length} hunk(s) matched`); continue; }
      const stats = diffStats(original, updated);
      if (!dryRun) {
        assertWritableSize(updated);
        await writeResolvedFile(absolute, updated);
      }
      changed += 1;
      const fuzzy = applied.filter(entry => entry.fuzz > 0).length;
      results.push(`${dryRun ? 'would patch' : 'patched'} ${displayPath(absolute)} · ${applied.length}/${file.hunks.length} hunk(s), +${stats.added}/-${stats.removed} lines${fuzzy ? `, ${fuzzy} with fuzz` : ''}${failed.length ? `, ${failed.length} hunk(s) did not match` : ''}`);
      if (dryRun) results.push(unifiedDiff(original, updated, { oldLabel: displayPath(absolute), newLabel: 'after' }));
    } catch (error) {
      results.push(`failed ${target}: ${describeFilesystemFailure(error, { path: error?.path })}`);
    }
  }
  const failedCount = results.filter(line => line.startsWith('failed')).length;
  return text([`${changed}/${files.length} file(s) ${dryRun ? 'would be patched' : 'patched'}`, ...results].join('\n'), failedCount > 0);
}

async function setLinuxPermissions(target, mode, uid, gid, recursive, displayTarget, failures) {
  let directory = null;
  let file = null;
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) {
      failures.push(`${displayTarget}: symbolic links are not changed`);
      return 0;
    }
    if (info.isDirectory()) {
      directory = await openDirectoryPath(target);
      let changed = 0;
      if (recursive) {
        for (const entry of await readdir(directory.anchor, { withFileTypes:true })) {
          if (entry.isSymbolicLink()) continue;
          changed += await setLinuxPermissions(path.join(directory.anchor, entry.name), mode, uid, gid, true, path.join(displayTarget, entry.name), failures);
        }
      }
      await directory.handle.chmod(mode);
      if (uid !== null || gid !== null) await directory.handle.chown(uid ?? -1, gid ?? -1);
      return changed + 1;
    }
    if (!info.isFile()) {
      failures.push(`${displayTarget}: special files are not changed`);
      return 0;
    }
    file = await openRegularFile(target, READ_NOFOLLOW);
    await file.handle.chmod(mode);
    if (uid !== null || gid !== null) await file.handle.chown(uid ?? -1, gid ?? -1);
    return 1;
  } catch (error) {
    failures.push(`${displayTarget}: ${describeFilesystemFailure(error, { path:error?.path })}`);
    return 0;
  } finally {
    if (file) await file.close().catch(() => {});
    if (directory) await directory.close().catch(() => {});
  }
}

export async function setPermissionsTool(args) {
  const absolute = await resolveSafePath(args.path);
  const raw = typeof args.mode === 'string' ? args.mode.trim() : String(args.mode ?? '');
  if (!/^[0-7]{3,4}$/.test(raw)) fail('mode must be an octal string such as "755" or "0644"');
  const mode = Number.parseInt(raw, 8);
  const recursive = args.recursive === true;
  const uid = Number.isInteger(Number(args.uid)) ? Number(args.uid) : null;
  const gid = Number.isInteger(Number(args.gid)) ? Number(args.gid) : null;
  const failures = [];
  let changed = 0;
  if (process.platform === 'linux' && constants.O_NOFOLLOW && constants.O_DIRECTORY) {
    changed = await setLinuxPermissions(absolute, mode, uid, gid, recursive, displayPath(absolute), failures);
  } else {
    // macOS/Windows fallback: Node exposes no directory-fd-relative chmod/chown there, so this
    // branch re-resolves each path lexically (confineAll) and then acts on the path. Between those
    // two steps another process can swap a component, so confinement is a guardrail on this
    // platform rather than a descriptor-bound guarantee — the same residual the archive/document
    // staging path documents. Linux uses the descriptor-bound path above.
    const info = await stat(absolute).catch(() => fail(`Path not found: ${displayPath(absolute)}`));
    const targets = [absolute];
    if (recursive && info.isDirectory()) {
      const walk = async target => {
        const entries = await readdir(target, { withFileTypes:true }).catch(() => []);
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const child = path.join(target, entry.name);
          targets.push(child);
          if (entry.isDirectory()) await walk(child);
        }
      };
      await walk(absolute);
    }
    const confined = await confineAll(targets);
    for (const target of confined) {
      try {
        await chmod(target, mode);
        if (uid !== null || gid !== null) await chown(target, uid ?? -1, gid ?? -1);
        changed += 1;
      } catch (error) {
        failures.push(`${displayPath(target)}: ${describeFilesystemFailure(error, { path:error?.path })}`);
      }
    }
  }
  const summary = `Set mode ${raw}${uid !== null || gid !== null ? ` (uid ${uid ?? '-'} gid ${gid ?? '-'})` : ''} on ${changed} path(s) starting at ${displayPath(absolute)}.`;
  if (!failures.length) return text(summary);
  return text(`${summary}\n${failures.length} path(s) could not be changed:\n${failures.slice(0, 20).join('\n')}`, true);
}

export async function createDirectoryTool(args) {
  const list = Array.isArray(args.paths) ? args.paths : [args.path];
  if (!list.filter(Boolean).length) fail('path (or paths) is required');
  if (list.length > 200) fail('paths accepts at most 200 entries per call');
  const created = [];
  const failed = [];
  for (const entry of list) {
    try {
      const absolute = await resolveSafePath(entry);
      await ensureDirectoryPath(absolute);
      created.push(displayPath(absolute));
    } catch (error) {
      failed.push(`${entry}: ${describeFilesystemFailure(error, { path: error?.path })}`);
    }
  }
  const header = `${created.length} director${created.length === 1 ? 'y' : 'ies'} ready`;
  return text([header, ...created, ...failed.map(line => `failed ${line}`)].join('\n'), failed.length > 0);
}

async function pathExists(target) {
  try { await access(target, constants.F_OK); return true; } catch { return false; }
}

export async function moveFileTool(args) {
  const source = await resolveSafePath(args.source, 'source');
  const destination = await resolveSafePath(args.destination, 'destination');
  if (source === destination) fail('source and destination are the same path');
  const overwrite = args.overwrite !== false;
  await withExistingParent(source, async anchoredSource => {
    const sourceInfo = await lstat(anchoredSource).catch(() => fail(`Source not found: ${displayPath(source)}`));
    if (sourceInfo.isSymbolicLink()) fail('source cannot be a symbolic link');
    await withWritableParent(destination, async anchoredDestination => {
      const existing = await lstat(anchoredDestination).catch(() => null);
      if (existing?.isSymbolicLink()) fail('destination cannot be a symbolic link');
      if (existing && !overwrite) fail(`Destination already exists: ${displayPath(destination)}. Pass overwrite: true to replace it.`);
      if (existing?.isDirectory()) {
        const entries = await readdir(anchoredDestination).catch(() => []);
        if (entries.length) fail(`Destination is a non-empty directory: ${displayPath(destination)}. Move it aside or pick another name.`);
      }
      try {
        await rename(anchoredSource, anchoredDestination);
      } catch (error) {
        if (error?.code !== 'EXDEV') throw error;
        if (sourceInfo.isDirectory()) fail('Moving a directory across filesystems is not supported; copy it manually or move within one volume');
        await copyTreeContents(anchoredSource, anchoredDestination, { entries:0, bytes:0, maxBytes:Number.MAX_SAFE_INTEGER });
        await rm(anchoredSource, { force:true });
      }
    });
  });
  return text(`Moved ${displayPath(source)} to ${displayPath(destination)}.`);
}

export async function copyFileTool(args) {
  const source = await resolveSafePath(args.source, 'source');
  const destination = await resolveSafePath(args.destination, 'destination');
  if (source === destination) fail('source and destination are the same path');
  const overwrite = args.overwrite !== false;
  let info;
  await withExistingParent(source, async anchoredSource => {
    const sourceInfo = await lstat(anchoredSource).catch(() => fail(`Source not found: ${displayPath(source)}`));
    if (sourceInfo.isSymbolicLink()) fail('source cannot be a symbolic link');
    if (sourceInfo.isDirectory()) fail('copy_file copies single files only; create the directory and copy its files individually');
    info = sourceInfo;
    await withWritableParent(destination, async anchoredDestination => {
      const existing = await lstat(anchoredDestination).catch(() => null);
      if (existing?.isSymbolicLink()) fail('destination cannot be a symbolic link');
      if (existing && !overwrite) fail(`Destination already exists: ${displayPath(destination)}. Pass overwrite: true to replace it.`);
      await copyTreeContents(anchoredSource, anchoredDestination, { entries:0, bytes:0, maxBytes:Number.MAX_SAFE_INTEGER });
    });
  });
  return text(`Copied ${displayPath(source)} to ${displayPath(destination)} (${info.size} bytes).`);
}

// --- archives -------------------------------------------------------------------------
const MAX_ARCHIVE_EXPANDED_BYTES = Math.min(
  4 * 1024 * 1024 * 1024,
  Math.max(64 * 1024 * 1024, Number(process.env.REMCP_MAX_ARCHIVE_EXPANDED_BYTES) || 512 * 1024 * 1024),
);

function safeArchiveEntry(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  return Boolean(normalized) && !normalized.startsWith('/') && !/^[A-Za-z]:\//.test(normalized) && !normalized.split('/').includes('..');
}

function archiveExpandedSize(lines, pattern, label, expectedEntries = null) {
  let total = 0;
  let matched = 0;
  for (const line of lines) {
    const match = line.match(pattern);
    if (!match) continue;
    total += Number(match[1]);
    matched += 1;
    if (!Number.isSafeInteger(total) || total > MAX_ARCHIVE_EXPANDED_BYTES) fail(`${label} exceeds the ${MAX_ARCHIVE_EXPANDED_BYTES}-byte extraction limit`);
  }
  if ((!matched && expectedEntries !== 0) || (expectedEntries !== null && matched < expectedEntries)) fail(`Could not determine ${label} size safely`);
  return total;
}

function tarEntrySize(line) {
  const tokens = String(line || '').trim().split(/\s+/);
  for (const index of [2, 3, 4]) {
    const size = Number(tokens[index]);
    if (!Number.isSafeInteger(size) || size < 0) continue;
    const tail = tokens.slice(index + 1);
    const gnuDate = /^\d{4}-\d{2}-\d{2}$/.test(tail[0] || '');
    const bsdDate = /^[A-Z][a-z]{2}$/.test(tail[0] || '')
      && /^\d{1,2}$/.test(tail[1] || '')
      && ((/^\d{2}:\d{2}(?::\d{2})?$/.test(tail[2] || '') && /^\d{4}$/.test(tail[3] || ''))
        || /^\d{4}$/.test(tail[2] || ''));
    if (gnuDate || bsdDate) return size;
  }
  return null;
}

function archiveTarExpandedSize(lines, label, expectedEntries) {
  let total = 0;
  let matched = 0;
  for (const line of lines) {
    const size = tarEntrySize(line);
    if (size === null) continue;
    total += size;
    matched += 1;
    if (!Number.isSafeInteger(total) || total > MAX_ARCHIVE_EXPANDED_BYTES) fail(`${label} exceeds the ${MAX_ARCHIVE_EXPANDED_BYTES}-byte extraction limit`);
  }
  if (matched < expectedEntries) fail(`Could not determine ${label} size safely`);
  return total;
}

function assertArchiveExpandedSize(bytes, label) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_ARCHIVE_EXPANDED_BYTES) {
    fail(`${label} exceeds the ${MAX_ARCHIVE_EXPANDED_BYTES}-byte extraction limit`);
  }
}

async function assertExtractedTree(root, state = { entries: 0, bytes: 0 }) {
  const info = await lstat(root);
  if (info.isSymbolicLink()) fail('Archive extraction produced a symbolic link');
  if (!info.isDirectory() && !info.isFile()) fail('Archive extraction produced a special file');
  state.entries += 1;
  state.bytes += info.isFile() ? info.size : 0;
  if (state.entries > 100_000 || state.bytes > MAX_ARCHIVE_EXPANDED_BYTES) fail('Archive extraction exceeded the safety limit');
  if (!info.isDirectory()) return;
  for (const entry of await readdir(root, { withFileTypes: true })) await assertExtractedTree(path.join(root, entry.name), state);
}

async function openArchiveSource(absolute) {
  return openRegularFile(absolute, READ_NOFOLLOW_NONBLOCK);
}

async function snapshotRegularFile(source, destination, maxBytes) {
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink()) fail(`Archive source is a symbolic link: ${displayPath(source)}`);
  if (!sourceInfo.isFile()) fail(`Archive source is not a regular file: ${displayPath(source)}`);
  const opened = await openArchiveSource(source);
  const { handle, info } = opened;
  let output;
  try {
    if (info.size > maxBytes) fail(`Archive is ${info.size} bytes, above the ${maxBytes}-byte snapshot limit`);
    output = await open(destination, WRITE_CREATE_NOFOLLOW, 0o400);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      if (!Number.isSafeInteger(offset + bytesRead) || offset + bytesRead > maxBytes) {
        fail(`Archive grew beyond the ${maxBytes}-byte snapshot limit`);
      }
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, offset + written);
        if (!result.bytesWritten) throw new Error('Could not finish writing the archive snapshot');
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await output.truncate(offset);
    await output.sync();
    await output.chmod(0o400);
    return offset;
  } finally {
    if (output) await output.close().catch(() => {});
    await opened.close().catch(() => {});
  }
}

async function copyOpenRegularFile(sourceHandle, sourceInfo, destinationPath, state) {
  const mode = sourceInfo.mode & 0o777;
  const currentBytes = state.bytes || 0;
  if (state.maxBytes !== undefined && sourceInfo.size > state.maxBytes - currentBytes) {
    fail(`Archive contents exceed the ${state.maxBytes}-byte extraction limit`);
  }
  // Never validate a pathname and then truncate it: another local process could replace that entry
  // between the check and open. Build a brand-new inode beside the destination and commit it with
  // rename(), which replaces the directory entry atomically without following a raced symlink or
  // truncating a hard-linked file.
  const temporary = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.remcp-${randomUUID()}.tmp`,
  );
  let output;
  try {
    output = await open(temporary, WRITE_CREATE_NOFOLLOW, mode);
    const outputInfo = await output.stat();
    if (!outputInfo.isFile()) fail('Archive contains a link or special file; archive destination is unsafe');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      if (!Number.isSafeInteger(offset + bytesRead) || (state.maxBytes !== undefined && currentBytes + offset + bytesRead > state.maxBytes)) {
        fail(`Archive contents exceed the ${state.maxBytes}-byte extraction limit`);
      }
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, offset + written);
        if (!result.bytesWritten) throw new Error('Could not finish copying archive contents');
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await output.sync();
    await output.chmod(mode);
    await output.close();
    output = null;
    await rename(temporary, destinationPath);
    state.bytes = currentBytes + offset;
  } finally {
    if (output) await output.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

async function copyTreeContents(source, destination, state = { entries: 0, bytes: 0, maxBytes: MAX_ARCHIVE_EXPANDED_BYTES }) {
  throwIfCancelled(state.signal);
  const initial = await lstat(source);
  if (initial.isSymbolicLink() || (!initial.isDirectory() && !initial.isFile())) fail('Archive contains symbolic links or special files; archive destination is unsafe');
  state.entries += 1;
  if (state.entries > 100_000) fail('Archive contains too many entries');
  if (initial.isFile()) {
    const opened = source.startsWith('/proc/self/fd/')
      ? await openRegularFile(source, READ_NOFOLLOW_NONBLOCK)
      : await openArchiveSource(source);
    try { await copyOpenRegularFile(opened.handle, opened.info, destination, state); }
    finally { if (opened.close) await opened.close(); else await opened.handle.close(); }
    return;
  }
  let directoryHandle = null;
  let sourcePath = source;
  let info = initial;
  try {
    try {
      directoryHandle = await openDirectoryPath(source, { allowOutside:state.allowOutsideSource === true });
      info = await directoryHandle.handle.stat();
      if (!info.isDirectory()) fail('Archive contains a link or special file; archive destination is unsafe');
      sourcePath = directoryHandle.anchor;
    } catch (error) {
      if (['ELOOP', 'ENOTDIR'].includes(error?.code)) fail('Archive contains a link or special file; archive destination is unsafe');
      throw error;
    }
    const mode = info.mode & 0o777;
    const existing = await lstat(destination).catch(() => null);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) fail('Archive contains a link or special file; archive destination is unsafe');
    try { await ensureDirectoryPath(destination, { allowOutside:true }); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const destinationInfo = await lstat(destination);
    if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) fail('Archive contains a link or special file; archive destination is unsafe');
    let destinationHandle;
    try {
      destinationHandle = await openDirectoryPath(destination, { allowOutside:true });
      const openedDestination = await destinationHandle.handle.stat();
      if (!openedDestination.isDirectory()) fail('Archive contains a link or special file; archive destination is unsafe');
      await destinationHandle.handle.chmod(mode | 0o700);
      const destinationAnchor = destinationHandle.anchor;
      for (const name of await readdir(sourcePath)) {
        await copyTreeContents(path.join(sourcePath, name), path.join(destinationAnchor, name), state);
      }
      await destinationHandle.handle.chmod(mode);
    } finally {
      if (destinationHandle) await destinationHandle.close().catch(() => {});
    }
  } finally {
    if (directoryHandle) await directoryHandle.close().catch(() => {});
  }
}

async function removeExtractionArtifact(target) {
  const info = await lstat(target).catch(() => null);
  if (!info) return;
  if (info.isDirectory() && !info.isSymbolicLink()) await rm(target, { recursive: true, force: true });
  else await unlink(target).catch(error => { if (error?.code !== 'ENOENT') throw error; });
}

async function recoverExtractionArtifacts(parent, destination, prefix) {
  const parentDirectory = await openDirectoryPath(parent, { create:true });
  const anchor = parentDirectory.anchor;
  const destinationPath = path.join(anchor, path.basename(destination));
  try {
    const entries = await readdir(anchor, { withFileTypes: true });
    const staleBefore = Date.now() - 60 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.name.startsWith('.remcp-extract-txn-')) continue;
      const candidate = path.join(anchor, entry.name);
      const info = await lstat(candidate).catch(() => null);
      if (info && info.mtimeMs < staleBefore) await removeExtractionArtifact(candidate);
    }
    const backups = entries.filter(entry => entry.name.startsWith(prefix)).map(entry => path.join(anchor, entry.name));
    for (const backup of backups) {
      const destinationInfo = await lstat(destinationPath).catch(() => null);
      if (destinationInfo) {
        await removeExtractionArtifact(backup);
        continue;
      }
      const backupInfo = await lstat(backup).catch(() => null);
      if (!backupInfo) continue;
      if (backupInfo.isSymbolicLink() || !backupInfo.isDirectory()) {
        await removeExtractionArtifact(backup);
        continue;
      }
      try {
        await rename(backup, destinationPath);
      } catch {
        continue;
      }
    }
  } finally {
    await parentDirectory.close().catch(() => {});
  }
}

async function restoreExtractionBackup(backup, destination) {
  if (await lstat(destination).catch(() => null)) return false;
  const info = await lstat(backup).catch(() => null);
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isDirectory()) {
    await removeExtractionArtifact(backup);
    return false;
  }
  try {
    await rename(backup, destination);
    return true;
  } catch {
    return false;
  }
}

async function installExtractedTree(source, destination) {
  const parent = path.dirname(destination);
  if (destination === path.parse(destination).root) fail('Archive destination cannot be a filesystem root');
  const backupPrefix = `.remcp-extract-backup-${createHash('sha256').update(destination).digest('hex').slice(0, 16)}-`;
  await recoverExtractionArtifacts(parent, destination, backupPrefix);
  const parentDirectory = await openDirectoryPath(parent, { create:true });
  const parentAnchor = parentDirectory.anchor;
  const destinationPath = path.join(parentAnchor, path.basename(destination));
  const existing = await lstat(destinationPath).catch(() => null);
  const destinationMode = existing?.isDirectory() ? existing.mode & 0o777 : 0o700;
  let transaction = '';
  let backup = '';
  let backupOwned = false;
  let preserveBackup = false;
  try {
    transaction = await mkdtemp(path.join(parentAnchor, '.remcp-extract-txn-'));
    if (existing) {
      backup = path.join(parentAnchor, `${backupPrefix}${randomUUID()}`);
      try {
        await rename(destinationPath, backup);
        backupOwned = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        backup = '';
      }
    }
    if (backupOwned) {
      const backupInfo = await lstat(backup);
      if (backupInfo.isSymbolicLink() || !backupInfo.isDirectory()) fail('Archive destination is not a safe directory');
      await copyTreeContents(backup, transaction, { entries:0, bytes:0, maxBytes:MAX_ARCHIVE_EXPANDED_BYTES, allowOutsideSource:true });
    }
    await copyTreeContents(source, transaction, { entries:0, bytes:0, maxBytes:MAX_ARCHIVE_EXPANDED_BYTES, allowOutsideSource:true });
    await chmod(transaction, destinationMode);
    await rename(transaction, destinationPath);
    if (backupOwned) {
      await removeExtractionArtifact(backup);
      backupOwned = false;
    }
  } catch (error) {
    if (backupOwned) {
      try {
        await restoreExtractionBackup(backup, destinationPath);
        if (!await lstat(backup).catch(() => null)) backupOwned = false;
        else preserveBackup = true;
      } catch (restoreError) {
        preserveBackup = true;
        throw new AggregateError([error, restoreError], 'Could not restore archive destination after extraction failure');
      }
    }
    throw error;
  } finally {
    if (transaction) await rm(transaction, { recursive: true, force: true });
    if (backupOwned && !preserveBackup) await removeExtractionArtifact(backup);
    await parentDirectory.close().catch(() => {});
  }
}

async function moveArchiveFile(source, destination) {
  const parent = path.dirname(destination);
  const parentDirectory = await openDirectoryPath(parent, { create:true });
  const destinationPath = path.join(parentDirectory.anchor, path.basename(destination));
  try {
    try {
      await rename(source, destinationPath);
    } catch (error) {
      if (!['EXDEV', 'EPERM'].includes(error?.code)) throw error;
      const temporary = path.join(parentDirectory.anchor, `.${path.basename(destination)}.remcp-${randomUUID()}.tmp`);
      try {
        await copyFile(source, temporary, constants.COPYFILE_EXCL);
        await rename(temporary, destinationPath);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      await unlink(source);
    }
  } finally {
    await parentDirectory.close().catch(() => {});
  }
}

function archiveTool() {
  const probe = (name, versionArgs = ['--version']) => {
    const result = spawnSync(name, versionArgs, { encoding: 'utf8' });
    return !result.error && result.status === 0 ? name : null;
  };
  // Info-ZIP unzip (the default on Debian/Ubuntu) treats --version as an invalid combination and
  // exits 10 even though the binary is healthy. Its portable version probe is -v.
  return { tar: probe('tar'), zip: probe('zip'), unzip: probe('unzip', ['-v']) };
}

export async function createArchiveTool(args, extra = {}) {
  const tools = archiveTool();
  const sources = Array.isArray(args.paths) ? args.paths : [args.paths].filter(Boolean);
  if (!sources.length) fail('paths must list at least one file or directory');
  const resolved = [];
  for (const entry of sources) {
    throwIfCancelled(extra.signal);
    resolved.push(await resolveSafePath(entry, 'paths[]'));
  }
  const destination = await resolveSafePath(args.destination, 'destination');
  const existingDestination = await lstat(destination).catch(() => null);
  if (existingDestination?.isSymbolicLink()) fail('Archive destination cannot be a symbolic link');
  const format = String(args.format || (destination.endsWith('.zip') ? 'zip' : 'tar.gz')).toLowerCase();
  const baseDir = path.dirname(resolved[0]);
  const names = resolved.map(entry => path.relative(baseDir, entry));
  if (names.some(name => !name || name.startsWith('..') || path.isAbsolute(name))) fail('Archive sources must share one parent directory');
  const archiveNames = names.map(name => name.startsWith('-') ? `./${name}` : name);
  const suffix = format === 'zip' ? '.zip' : format === 'tar' ? '.tar' : '.tar.gz';
  const stagingDirectory = await mkdtemp(path.join(os.tmpdir(), 'remcp-archive-'));
  if (resolved.some(entry => !path.relative(entry, stagingDirectory).startsWith('..') && !path.isAbsolute(path.relative(entry, stagingDirectory)))) {
    await rm(stagingDirectory, { recursive: true, force: true });
    fail('Archive source must not contain the system temporary directory');
  }
   const staging = path.join(stagingDirectory, `payload${suffix}`);
   const snapshotRoot = path.join(stagingDirectory, 'source');
   try {
      await ensureDirectoryPath(snapshotRoot, { allowOutside:true });

     const snapshotState = { entries: 0, bytes: 0, maxBytes: MAX_ARCHIVE_EXPANDED_BYTES, signal: extra.signal };
     for (let index = 0; index < resolved.length; index += 1) {
       throwIfCancelled(extra.signal);
       const snapshotPath = path.join(snapshotRoot, names[index]);
        await ensureDirectoryPath(path.dirname(snapshotPath), { allowOutside:true });

       await copyTreeContents(resolved[index], snapshotPath, snapshotState);
     }
     if (format === 'zip') {
       if (!tools.zip) fail('zip is not installed on this device; use format "tar.gz"');
       const result = spawnSync(tools.zip, ['-r', '-q', '-y', staging, '--', ...archiveNames], { cwd: snapshotRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      if (result.status !== 0) fail(`zip failed: ${(result.stderr || result.stdout || '').trim() || `exit ${result.status}`}`);
    } else if (format === 'tar' || format === 'tar.gz' || format === 'tgz') {
      if (!tools.tar) fail('tar is not installed on this device');
      const flags = format === 'tar' ? '-cf' : '-czf';
       const result = spawnSync(tools.tar, [flags, staging, '--', ...archiveNames], { cwd: snapshotRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      if (result.status !== 0) fail(`tar failed: ${(result.stderr || result.stdout || '').trim() || `exit ${result.status}`}`);
     } else {
       fail('format must be tar, tar.gz, or zip');
     }
      const stagedInfo = await stat(staging);
      assertArchiveExpandedSize(stagedInfo.size, 'archive output');

      await moveArchiveFile(staging, destination);

     const info = await stat(destination).catch(() => null);
     const note = ' (built outside the tree in temporary staging and committed atomically)';

    return text(`Created ${displayPath(destination)} (${format}, ${info?.size ?? 0} bytes) from ${resolved.length} path(s)${note}.`);
  } finally {
    if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true });
  }
}

function archiveFormatForPath(value) {
  if (/\.zip$/i.test(value)) return 'zip';
  if (/\.(tar\.gz|tgz)$/i.test(value)) return 'tar.gz';
  if (/\.(tar\.bz2|tbz2?)$/i.test(value)) return 'tar.bz2';
  if (/\.tar\.xz$/i.test(value)) return 'tar.xz';
  return 'tar';
}

function archiveSnapshotSuffix(format) {
  if (format === 'zip') return '.zip';
  if (format === 'tar.bz2') return '.tar.bz2';
  if (format === 'tar.xz') return '.tar.xz';
  if (format === 'tar.gz') return '.tar.gz';
  return '.tar';
}

export async function extractArchiveTool(args) {
  const tools = archiveTool();
  const archive = await resolveSafePath(args.archive, 'archive');
  const destination = await resolveSafePath(args.destination || path.dirname(archive), 'destination');
  if (destination === path.parse(destination).root) fail('Archive destination cannot be a filesystem root');
  const parent = path.dirname(destination);
  const backupPrefix = `.remcp-extract-backup-${createHash('sha256').update(destination).digest('hex').slice(0, 16)}-`;
  const format = archiveFormatForPath(archive);
  const stagingDirectory = await mkdtemp(path.join(os.tmpdir(), 'remcp-extract-'));
  const archiveSnapshot = path.join(stagingDirectory, `source${archiveSnapshotSuffix(format)}`);
  const staging = path.join(stagingDirectory, 'tree');
  try {
    await mkdir(staging, { mode: 0o700 });
    await snapshotRegularFile(archive, archiveSnapshot, MAX_ARCHIVE_EXPANDED_BYTES);
    await recoverExtractionArtifacts(parent, destination, backupPrefix);
    const existingDestination = await lstat(destination).catch(() => null);
    if (existingDestination?.isSymbolicLink() || (existingDestination && !existingDestination.isDirectory())) fail('Archive destination is not a safe directory');
    if (format === 'zip') {
      if (!tools.unzip) fail('unzip is not installed on this device');
      const listing = spawnSync(tools.unzip, ['-Z', '-1', archiveSnapshot], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
      if (listing.error || listing.status !== 0) fail(`Could not inspect ZIP archive: ${(listing.stderr || listing.error?.message || `exit ${listing.status}`).trim()}`);
      const names = String(listing.stdout || '').split(/\r?\n/).filter(Boolean);
      if (names.length > 100_000 || names.some(name => !safeArchiveEntry(name))) fail('ZIP archive contains an unsafe path or too many entries');
      const details = spawnSync(tools.unzip, ['-Z', '-v', archiveSnapshot], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
      if (details.error || details.status !== 0) fail(`Could not inspect ZIP sizes: ${(details.stderr || details.error?.message || `exit ${details.status}`).trim()}`);
      const detailText = String(details.stdout || '');
      if (/symbolic link|Unix file attributes \([^)]*\b12\d{4}/i.test(detailText)) fail('ZIP archive contains a symbolic link');
      const expandedBytes = archiveExpandedSize(detailText.split(/\r?\n/), /uncompressed size:\s*(\d+)\s*bytes/i, 'ZIP archive', names.length);
      assertArchiveExpandedSize(expandedBytes, 'ZIP archive');
      const result = spawnSync(tools.unzip, ['-o', '-q', archiveSnapshot, '-d', staging], { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      if (result.status !== 0) fail(`unzip failed: ${(result.stderr || result.stdout || '').trim() || `exit ${result.status}`}`);
    } else {
      if (!tools.tar) fail('tar is not installed on this device');
      const listFlags = format === 'tar.gz' ? '-tzf' : format === 'tar.bz2' ? '-tjf' : format === 'tar.xz' ? '-tJf' : '-tf';
      const listing = spawnSync(tools.tar, [listFlags, archiveSnapshot], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
      if (listing.error || listing.status !== 0) fail(`Could not inspect archive: ${(listing.stderr || listing.error?.message || `exit ${listing.status}`).trim()}`);
      const names = String(listing.stdout || '').split(/\r?\n/).filter(Boolean);
      if (names.length > 100_000 || names.some(name => !safeArchiveEntry(name))) fail('Archive contains an unsafe path or too many entries');
      const verboseFlags = format === 'tar.gz' ? '-tvzf' : format === 'tar.bz2' ? '-tvjf' : format === 'tar.xz' ? '-tvJf' : '-tvf';
      const details = spawnSync(tools.tar, [verboseFlags, archiveSnapshot], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
      if (details.error || details.status !== 0) fail(`Could not inspect archive sizes: ${(details.stderr || details.error?.message || `exit ${details.status}`).trim()}`);
      const detailLines = String(details.stdout || '').split(/\r?\n/);
      if (detailLines.some(line => /^[bclph]/.test(line))) fail('Archive contains a link or special file; archive destination is unsafe');
      const expandedBytes = archiveTarExpandedSize(detailLines, 'archive', names.length);
      assertArchiveExpandedSize(expandedBytes, 'archive');
      const flags = format === 'tar.gz' ? '-xzf' : format === 'tar.bz2' ? '-xjf' : format === 'tar.xz' ? '-xJf' : '-xf';
      const result = spawnSync(tools.tar, [flags, archiveSnapshot, '-C', staging], { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      if (result.status !== 0) fail(`tar failed: ${(result.stderr || result.stdout || '').trim() || `exit ${result.status}`}`);
    }
    await assertExtractedTree(staging);
    await installExtractedTree(staging, destination);
    const entries = await readdir(destination).catch(() => []);
    return text(`Extracted ${displayPath(archive)} into ${displayPath(destination)} (${entries.length} top-level entries).`);
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

// --- screenshots ----------------------------------------------------------------------
const SCREENSHOT_COMMANDS = [
  { command: 'grim', args: file => [file] },
  { command: 'gnome-screenshot', args: file => ['-f', file] },
  { command: 'spectacle', args: file => ['-b', '-n', '-o', file] },
  { command: 'scrot', args: file => ['-o', file] },
  { command: 'import', args: file => ['-window', 'root', file] },
  { command: 'screencapture', args: file => ['-x', file] },
];

// What to tell the person when no capture worked. The general "install a screenshot tool" line was
// wrong on a Mac, where `screencapture` ships with the system and fails only because TCC has not
// granted Screen Recording — the exact failure behind "the screenshot returned an error" reports.
function screenshotAdvice(attempts, { platform = process.platform, env = process.env, execPath = process.execPath } = {}) {
  if (platform === 'darwin') {
    return `macOS refused the screen capture (${attempts.join('; ') || 'no capture command ran'}). Grant Screen Recording to the binary that runs the tools — System Settings → Privacy & Security → Screen Recording → + → ${execPath} — then restart the agent with \`remcp start\`. macOS requires it for screencapture even when the file itself is writable.`;
  }
  if (platform === 'win32') {
    return `Windows refused the screen capture (${attempts.join('; ') || 'no capture command ran'}). Screen capture needs an interactive desktop session: a machine where nobody is signed in, or a locked session, cannot be captured. Sign in on that computer and try again.`;
  }
  const wayland = /wayland/i.test(String(env.XDG_SESSION_TYPE || '')) || Boolean(env.WAYLAND_DISPLAY);
  if (!env.DISPLAY && !wayland) {
    return `This computer has no graphical session (no DISPLAY and no Wayland display), so there is nothing to capture — servers and containers usually have none.`;
  }
  // GNOME on Wayland is its own case: Mutter does not expose wlr-screencopy, so grim cannot
  // capture it. ReMCP tries the compositor-supported XDG Desktop Portal first; local screenshot
  // commands remain fallbacks for environments where the portal is unavailable.
  if (wayland && /gnome/i.test(String(env.XDG_CURRENT_DESKTOP || ''))) {
    return `Could not capture the screen on GNOME Wayland (${attempts.join('; ') || 'no capture backend ran'}). ReMCP tried the XDG Desktop Portal first, which is GNOME's supported screenshot API. Make sure xdg-desktop-portal and xdg-desktop-portal-gnome are installed and the agent is running inside the signed-in user's graphical session; command-line capture helpers are only fallbacks.`;
  }
  if (wayland) {
    return `Could not capture the screen on Wayland (${attempts.join('; ') || 'no capture backend ran'}). ReMCP tried the XDG Desktop Portal first. Verify xdg-desktop-portal is running; on wlroots compositors, \`grim\` is also supported as a fallback.`;
  }
  return `Could not capture the screen. Install one of grim, gnome-screenshot, spectacle, scrot, or ImageMagick import (tried: ${attempts.join('; ') || 'none available'}).`;
}

function windowsScreenshotScript(file) {
  return [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)',
    `$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  ].join('; ');
}

export async function takeScreenshotTool(args) {
  const requestedDirectory = args.directory ? await resolveSafePath(args.directory, 'directory') : '';
  const temporaryDirectory = requestedDirectory ? '' : await mkdtemp(path.join(os.tmpdir(), 'remcp-screenshot-'));
  const directory = requestedDirectory || temporaryDirectory;
  let outputDirectory = null;
  if (requestedDirectory) {
    await ensureDirectoryPath(directory);
    outputDirectory = await openWritableParent(directory);
  }
  const outputAnchor = outputDirectory
    ? outputDirectory.anchor.replace('/proc/self/fd/', `/proc/${process.pid}/fd/`)
    : directory;
  const fileName = `capture-${randomUUID()}.png`;
  const file = path.join(outputAnchor, fileName);
  const displayFile = path.join(directory, fileName);
  const attempts = [];
  let preserveCapture = false;
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsScreenshotScript(file)], { encoding: 'utf8', timeout: 30000 });
      attempts.push(`powershell: ${(result.stderr || '').trim() || ('exit ' + result.status)}`);
    } else {
      if (process.platform === 'linux' && isWaylandSession()) {
        try {
          await capturePortalScreenshot(file);
        } catch (error) {
          const message = error instanceof Error ? error.message : `xdg-desktop-portal: ${String(error)}`;
          attempts.push(message);
          if (error && typeof error === 'object' && error.code === 'PORTAL_CANCELLED') {
            fail(`Screen capture was cancelled in the desktop permission dialog (${message}).`);
          }
        }
      }
      if (!await pathExists(file)) {
        for (const candidate of SCREENSHOT_COMMANDS) {
          if (spawnSync('which', [candidate.command], { encoding: 'utf8' }).status !== 0) continue;
          const result = spawnSync(candidate.command, candidate.args(file), { encoding: 'utf8', timeout: 30000 });
          if (result.status === 0 && await pathExists(file)) break;
          attempts.push(`${candidate.command}: ${(result.stderr || '').trim() || ('exit ' + result.status)}`);
        }
      }
    }
    if (!await pathExists(file)) fail(screenshotAdvice(attempts));

    const opened = await openRegularFile(file);
    const { handle, info } = opened;
    try {
      if (info.size <= MAX_IMAGE_BYTES) {
        const buffer = await handle.readFile();
        preserveCapture = args.keep === true;
        return multi([
          { type: 'text', text: `Screenshot of ${os.hostname()} (${info.size} bytes)${preserveCapture ? (' saved at ' + displayPath(displayFile)) : ''}` },
          image(buffer.toString('base64'), 'image/png'),
        ]);
      }
      preserveCapture = true;
      return text(`Screenshot of ${os.hostname()} captured: ${info.size} bytes, above the ${MAX_IMAGE_BYTES}-byte inline limit, so it is saved at ${displayPath(displayFile)} instead of being returned as an image. Fetch it with read_binary using chunks of up to ${MAX_BINARY_CHUNK_BYTES} bytes (offset_bytes and length_bytes), or ask for a smaller region.`);
    } finally {
      await opened.close();
    }
  } finally {
    if (!preserveCapture) {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
      else await rm(file, { force: true }).catch(() => {});
    }
    if (outputDirectory) await outputDirectory.close().catch(() => {});
  }
}
export const fileToolHandlers = {
  read_file: readFileTool,
  read_files: readFilesTool,
  read_multiple_files: readMultipleFilesTool,
  read_image: readImageTool,
  read_binary: readBinaryTool,
  hash_file: hashFileTool,
  list_directory: listDirectoryTool,
  get_file_info: getFileInfoTool,
  write_file: writeFileTool,
  write_files: writeFilesTool,
  write_binary: writeBinaryTool,
  edit_block: editBlockTool,
  replace_lines: replaceLinesTool,
  replace_in_files: replaceInFilesTool,
  diff_files: diffFilesTool,
  create_directory: createDirectoryTool,
  apply_patch: applyPatchTool,
  set_permissions: setPermissionsTool,
  delete_path: deletePathTool,
  delete_paths: deletePathsTool,
  move_file: moveFileTool,
  move_paths: movePathsTool,
  copy_file: copyFileTool,
  copy_paths: copyPathsTool,
  move_to_trash: moveToTrashTool,
  create_archive: createArchiveTool,
  extract_archive: extractArchiveTool,
  take_screenshot: takeScreenshotTool,
};
