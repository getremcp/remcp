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


import { ensureDirectoryPath } from './files-secure-paths.mjs';
import { MAX_ARCHIVE_EXPANDED_BYTES, archiveExpandedSize, archiveTarExpandedSize, archiveTool, assertArchiveExpandedSize, assertExtractedTree, copyTreeContents, installExtractedTree, moveArchiveFile, recoverExtractionArtifacts, safeArchiveEntry, snapshotRegularFile } from './files-archive-safety.mjs';

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
  const archiveNames = names.map(name => {
    const portable = name.split(path.sep).join('/');
    return portable.startsWith('-') ? `./${portable}` : portable;
  });
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
       if (process.platform === 'win32') {
         if (!tools.tar) fail('Windows archive backend is unavailable: tar.exe is required');
         const result = spawnSync(tools.tar, ['-a', '-c', '-f', staging, '--', ...archiveNames], { cwd: snapshotRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
         if (result.status !== 0) fail(`tar.exe ZIP creation failed: ${(result.stderr || result.stdout || '').trim() || `exit ${result.status}`}`);
       } else {
         if (!tools.zip) fail('zip is not installed on this device; use format "tar.gz"');
         const result = spawnSync(tools.zip, ['-r', '-q', '-y', staging, '--', ...archiveNames], { cwd: snapshotRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
         if (result.status !== 0) fail(`zip failed: ${(result.stderr || result.stdout || '').trim() || `exit ${result.status}`}`);
       }
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

export function archiveFormatForPath(value) {
  if (/\.zip$/i.test(value)) return 'zip';
  if (/\.(tar\.gz|tgz)$/i.test(value)) return 'tar.gz';
  if (/\.(tar\.bz2|tbz2?)$/i.test(value)) return 'tar.bz2';
  if (/\.tar\.xz$/i.test(value)) return 'tar.xz';
  return 'tar';
}

export function archiveSnapshotSuffix(format) {
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
    if (format === 'zip' && process.platform !== 'win32') {
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
      if (!tools.tar) fail(process.platform === 'win32' ? 'Windows archive backend is unavailable: tar.exe is required' : 'tar is not installed on this device');
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
