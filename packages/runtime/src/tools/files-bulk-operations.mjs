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


import { READ_NOFOLLOW, ensureDirectoryPath, openDirectoryPath, openRegularFile, withExistingParent, withWritableParent, writeResolvedFile } from './files-secure-paths.mjs';
import { collectTree, confineAll, getPathInfo, readTextFile } from './files-read-traversal.mjs';
import { assertWritableSize } from './files-write-edit.mjs';
import { copyTreeContents } from './files-archive-safety.mjs';

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

export async function setLinuxPermissions(target, mode, uid, gid, recursive, displayTarget, failures) {
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

export async function pathExists(target) {
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
