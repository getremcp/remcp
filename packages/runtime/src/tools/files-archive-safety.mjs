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


import { READ_NOFOLLOW_NONBLOCK, WRITE_CREATE_NOFOLLOW, ensureDirectoryPath, openDirectoryPath, openRegularFile } from './files-secure-paths.mjs';

export const MAX_ARCHIVE_EXPANDED_BYTES = Math.min(
  4 * 1024 * 1024 * 1024,
  Math.max(64 * 1024 * 1024, Number(process.env.REMCP_MAX_ARCHIVE_EXPANDED_BYTES) || 512 * 1024 * 1024),
);

export function safeArchiveEntry(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  return Boolean(normalized) && !normalized.startsWith('/') && !/^[A-Za-z]:\//.test(normalized) && !normalized.split('/').includes('..');
}

export function archiveExpandedSize(lines, pattern, label, expectedEntries = null) {
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

export function tarEntrySize(line) {
  const tokens = String(line || '').trim().split(/\s+/);
  for (const index of [2, 3, 4]) {
    const size = Number(tokens[index]);
    if (!Number.isSafeInteger(size) || size < 0) continue;
    const tail = tokens.slice(index + 1);
    const gnuDate = /^\d{4}-\d{2}-\d{2}$/.test(tail[0] || '');
    const bsdMonthDay = /^[A-Z][a-z]{2}$/.test(tail[0] || '') && /^\d{1,2}$/.test(tail[1] || '');
    const bsdTime = /^\d{2}:\d{2}(?::\d{2})?$/.test(tail[2] || '');
    const bsdDate = bsdMonthDay && (bsdTime || /^\d{4}$/.test(tail[2] || ''));
    if (gnuDate || bsdDate) return size;
  }
  return null;
}

export function archiveTarExpandedSize(lines, label, expectedEntries) {
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

export function assertArchiveExpandedSize(bytes, label) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_ARCHIVE_EXPANDED_BYTES) {
    fail(`${label} exceeds the ${MAX_ARCHIVE_EXPANDED_BYTES}-byte extraction limit`);
  }
}

export async function assertExtractedTree(root, state = { entries: 0, bytes: 0 }) {
  const info = await lstat(root);
  if (info.isSymbolicLink()) fail('Archive extraction produced a symbolic link');
  if (!info.isDirectory() && !info.isFile()) fail('Archive extraction produced a special file');
  state.entries += 1;
  state.bytes += info.isFile() ? info.size : 0;
  if (state.entries > 100_000 || state.bytes > MAX_ARCHIVE_EXPANDED_BYTES) fail('Archive extraction exceeded the safety limit');
  if (!info.isDirectory()) return;
  for (const entry of await readdir(root, { withFileTypes: true })) await assertExtractedTree(path.join(root, entry.name), state);
}

export async function openArchiveSource(absolute) {
  return openRegularFile(absolute, READ_NOFOLLOW_NONBLOCK);
}

export async function snapshotRegularFile(source, destination, maxBytes) {
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

export async function copyOpenRegularFile(sourceHandle, sourceInfo, destinationPath, state) {
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

export async function copyTreeContents(source, destination, state = { entries: 0, bytes: 0, maxBytes: MAX_ARCHIVE_EXPANDED_BYTES }) {
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

export async function removeExtractionArtifact(target) {
  const info = await lstat(target).catch(() => null);
  if (!info) return;
  if (info.isDirectory() && !info.isSymbolicLink()) await rm(target, { recursive: true, force: true });
  else await unlink(target).catch(error => { if (error?.code !== 'ENOENT') throw error; });
}

export async function recoverExtractionArtifacts(parent, destination, prefix) {
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

export async function restoreExtractionBackup(backup, destination) {
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

export async function installExtractedTree(source, destination) {
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

export async function moveArchiveFile(source, destination) {
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

export function archiveCommandProbe(name, versionArgs = ['--version']) {
  const result = spawnSync(name, versionArgs, { encoding: 'utf8' });
  return !result.error && result.status === 0 ? name : null;
}

export function archiveTool({ platform = process.platform, probe = archiveCommandProbe } = {}) {
  const tarName = platform === 'win32' ? 'tar.exe' : 'tar';
  // Windows ships libarchive/bsdtar as tar.exe. It can create/read ZIP as well as tar-family
  // archives, so keeping one backend avoids introducing a second extraction/safety path.
  if (platform === 'win32') return { tar: probe(tarName), zip:null, unzip:null };
  // Info-ZIP unzip (the default on Debian/Ubuntu) treats --version as an invalid combination and
  // exits 10 even though the binary is healthy. Its portable version probe is -v.
  return { tar: probe(tarName), zip: probe('zip'), unzip: probe('unzip', ['-v']) };
}

export function archiveBackendAvailable({ platform = process.platform, probe = archiveCommandProbe } = {}) {
  if (platform === 'win32') return Boolean(archiveTool({ platform, probe }).tar);
  return platform === 'linux' || platform === 'darwin';
}

export function zipArchiveBackendAvailable({ platform = process.platform, probe = archiveCommandProbe } = {}) {
  const tools = archiveTool({ platform, probe });
  if (platform === 'win32') return Boolean(tools.tar);
  if (platform === 'linux' || platform === 'darwin') return Boolean(tools.zip && tools.unzip);
  return false;
}
