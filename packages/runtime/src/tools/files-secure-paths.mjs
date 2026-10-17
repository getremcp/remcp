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



export const MAX_INLINE_FILE_BYTES = 20 * 1024 * 1024;
// An image travels base64-encoded, which costs a third more bytes. The agent's stdio transport holds
// 24 MiB and the relay's WebSocket frames hold 32 MiB, so 8 MiB of image is ~11 MiB on the wire with
// room to spare; anything larger goes through read_binary in chunks instead. Binary chunks are 4 MiB
// for the same reason: four times fewer round trips for the same file.
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_BINARY_CHUNK_BYTES = 1024 * 1024;
export const IMAGE_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.bmp', 'image/bmp'], ['.svg', 'image/svg+xml'], ['.avif', 'image/avif'],
]);

export function detectEol(content) {
  const crlf = (content.match(/\r\n/g) || []).length;
  const lf = (content.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}

// Only regular files can be read: a FIFO blocks until a writer appears, a device node can be
// endless, and both would hang or flood a tool call instead of returning an answer.
export function assertRegularFile(info, absolute) {
  if (info.isDirectory()) fail(`${displayPath(absolute)} is a directory, not a file`);
  if (!info.isFile()) fail(`${displayPath(absolute)} is not a regular file`);
  return info;
}

export const NOFOLLOW = constants.O_NOFOLLOW || 0;
export const NONBLOCK = constants.O_NONBLOCK || 0;
export const READ_NOFOLLOW = constants.O_RDONLY | NOFOLLOW;
export const READ_NOFOLLOW_NONBLOCK = READ_NOFOLLOW | NONBLOCK;
export const READWRITE_NOFOLLOW = constants.O_RDWR | NOFOLLOW;
export const WRITE_CREATE_NOFOLLOW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW | NONBLOCK;
export const WRITE_TRUNCATE_NOFOLLOW = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW | NONBLOCK;
export const DIRECTORY_READ_NOFOLLOW = constants.O_RDONLY | (constants.O_DIRECTORY || 0) | NOFOLLOW | NONBLOCK;

export async function openDirectoryFromFilesystemRoot(absolute) {
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

export const secureRootPromises = new Map();

export async function secureAllowedRoot(root) {
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

export async function cloneDirectory(directory) {
  const handle = await open(`${directory.anchor}/.`, DIRECTORY_READ_NOFOLLOW);
  return {
    handle,
    anchor: `/proc/self/fd/${handle.fd}`,
    close: () => handle.close(),
  };
}

export async function openConfinedDirectoryPath(absolute, create) {
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

export async function openDescriptorDirectoryPath(absolute, create) {
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

export async function openEntryAtPath(absolute, flags) {
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
export const hardlinkWarned = new Set();

export function warnOnHardlink(label, info) {
  if (!Number.isFinite(info?.nlink) || info.nlink <= 1 || hardlinkWarned.has(label)) return;
  if (hardlinkWarned.size > 1000) hardlinkWarned.clear();
  hardlinkWarned.add(label);
  countEvent('hardlinkWarnings');
  console.warn(`ReMCP runtime: ${label} has ${info.nlink} hard links, so the same file is reachable from outside the allowed roots`);
}

export async function openRegularFileAtPath(absolute, flags, label = absolute) {
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

export async function openWritableParent(absolute, options = {}) {
  if (process.platform === 'linux' && constants.O_NOFOLLOW && constants.O_DIRECTORY) {
    return openDirectoryPath(absolute, { create:true, ...options });
  }
  await mkdir(absolute, { recursive:true });
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) fail('Filesystem path component is not a directory');
  return { anchor:absolute, close:async() => {} };
}

export async function writeResolvedFile(absolute, content, { append = false } = {}) {
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

export async function withWritableParent(absolute, callback) {
  const parent = await openWritableParent(path.dirname(absolute));
  try {
    return await callback(path.join(parent.anchor, path.basename(absolute)));
  } finally {
    await parent.close().catch(() => {});
  }
}

export async function openExistingParent(absolute) {
  if (process.platform === 'linux' && constants.O_NOFOLLOW && constants.O_DIRECTORY) {
    return openDirectoryPath(absolute);
  }
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) fail('Filesystem path component is not a directory');
  return { anchor:absolute, close:async() => {} };
}

export async function withExistingParent(absolute, callback) {
  const parent = await openExistingParent(path.dirname(absolute));
  try {
    return await callback(path.join(parent.anchor, path.basename(absolute)));
  } finally {
    await parent.close().catch(() => {});
  }
}

export async function ensureDirectoryPath(absolute, options = {}) {
  if (process.platform === 'linux' && constants.O_NOFOLLOW && constants.O_DIRECTORY) {
    const directory = await openDirectoryPath(absolute, { create:true, ...options });
    await directory.close();
    return;
  }
  await mkdir(absolute, { recursive:true });
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) fail('Filesystem path component is not a directory');
}

export async function readRegularBuffer(absolute, maxBytes = Infinity) {
  const opened = await openRegularFile(absolute);
  const { handle, info } = opened;
  try {
    if (info.size > maxBytes) fail(`File is too large to read inline (${info.size} bytes)`);
    return { info, buffer: await handle.readFile() };
  } finally {
    await opened.close();
  }
}

export async function overwriteOpenFile(handle, content) {
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
