import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { readDocxXmlText, readPdfText } from '../documents.mjs';
import { openDirectoryPath } from '../tools/files.mjs';
import { resolveSafePath, text } from '../util.mjs';
import {
  clamp,
  commandExists,
  escapePowerShellSingle,
  jsonResult,
  optionalString,
  removeTemp,
  requireEnum,
  runFile,
  runPowerShell,
  tempDir,
  unavailable,
} from './common.mjs';

// Internal OOXML/PDF helpers; keep all file reads descriptor-bound and size-limited.

export function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
export function xmlUnescape(value) {
  return String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

const MAX_OOXML_ENTRIES = 10_000;
const MAX_OOXML_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 128 * 1024 * 1024;
const DOCUMENT_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);

export function descriptorAnchorsAvailable() {
  return process.platform === 'linux' && Boolean(constants.O_NOFOLLOW) && Boolean(constants.O_DIRECTORY);
}

export async function openDocumentSource(filePath) {
  if (!descriptorAnchorsAvailable()) {
    const handle = await open(filePath, DOCUMENT_READ_FLAGS);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('Document path must be a regular file');
      return { handle, close: () => handle.close() };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }
  const parent = await openDirectoryPath(path.dirname(filePath));
  let handle;
  try {
    handle = await open(path.join(parent.anchor, path.basename(filePath)), DOCUMENT_READ_FLAGS);
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Document path must be a regular file');
    return {
      handle,
      close: async () => {
        try { await handle.close(); }
        finally { await parent.close().catch(() => {}); }
      },
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await parent.close().catch(() => {});
    throw error;
  }
}

export async function openDocumentDirectoryPath(directory, { create = false } = {}) {
  const opened = await openDirectoryPath(directory, { create });
  return { ...opened, descriptorBound:opened.anchor !== directory || process.platform === 'linux' };
}

export async function createAnchoredTempDirectory(parent, prefix) {
  const directory = await openDocumentDirectoryPath(parent, { create:true });
  try {
    const childAnchor = directory.descriptorBound === false
      ? directory.anchor
      : directory.anchor.replace('/proc/self/fd/', `/proc/${process.pid}/fd/`);
    const directoryPath = await mkdtemp(path.join(childAnchor, prefix));
    return { path:directoryPath, close:directory.close };
  } catch (error) {
    await directory.close().catch(() => {});
    throw error;
  }
}

export async function readBounded(handle, maximum, label) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    if (!Number.isSafeInteger(offset + bytesRead) || offset + bytesRead > maximum) {
      throw new Error(`${label} exceeds the ${maximum}-byte safety limit`);
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    offset += bytesRead;
  }
  return Buffer.concat(chunks, offset);
}

export async function readDocumentFile(filePath) {
  const opened = await openDocumentSource(filePath);
  try {
    const info = await opened.handle.stat();
    if (!info.isFile()) throw new Error('Document path must be a regular file');
    if (info.size > MAX_DOCUMENT_BYTES) throw new Error(`Document is too large (maximum ${MAX_DOCUMENT_BYTES} bytes)`);
    return await readBounded(opened.handle, MAX_DOCUMENT_BYTES, 'Document');
  } finally {
    await opened.close();
  }
}

export async function copyRegularNoFollow(source, destination) {
  const opened = await openDocumentSource(source);
  try {
    const info = await opened.handle.stat();
    if (!info.isFile()) throw new Error('Document path must be a regular file');
    if (info.size > MAX_DOCUMENT_BYTES) throw new Error(`Document is too large (maximum ${MAX_DOCUMENT_BYTES} bytes)`);
    const destinationHandle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    try {
      const data = await readBounded(opened.handle, MAX_DOCUMENT_BYTES, 'Document');
      await destinationHandle.writeFile(data);
    } finally {
      await destinationHandle.close();
    }
  } finally {
    await opened.close();
  }
}

export async function snapshotDocumentFile(filePath) {
  const dir = await tempDir('remcp-pdf-input-');
  const snapshot = path.join(dir, `input-${randomUUID()}.pdf`);
  try {
    await copyRegularNoFollow(filePath, snapshot);
    return { dir, path: snapshot };
  } catch (error) {
    await removeTemp(dir);
    throw error;
  }
}

export async function assertSafeExtractedTree(root, state = { entries: 0 }) {
  const info = await lstat(root);
  if (info.isSymbolicLink()) throw new Error('OOXML archive contains a symbolic link');
  if (!info.isDirectory() && !info.isFile()) throw new Error('OOXML archive contains a special file');
  state.entries += 1;
  if (state.entries > MAX_OOXML_ENTRIES) throw new Error('OOXML archive has too many extracted entries');
  if (!info.isDirectory()) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    await assertSafeExtractedTree(path.join(root, entry.name), state);
  }
}

export function safePdfPattern(value, fallback) {
  const pattern = String(value || fallback);
  if (!pattern || pattern.length > 240 || pattern.includes('\0') || path.isAbsolute(pattern) || /[\\/]/.test(pattern) || pattern.split(/[\\/]/).includes('..')) {
    throw new Error('PDF split pattern must be a filename without path separators');
  }
  return pattern;
}

export function safeArchiveEntry(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return false;
  return !normalized.split('/').includes('..');
}

export async function validateZipArchive(source) {
  if (process.platform === 'win32') {
    const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem;$z=[IO.Compression.ZipFile]::OpenRead('${escapePowerShellSingle(source)}');try{$count=$z.Entries.Count;$total=0;foreach($e in $z.Entries){$n=$e.FullName.Replace('\\','/');if([IO.Path]::IsPathRooted($n) -or $n.StartsWith('/') -or ($n.Split('/') -contains '..')){throw ('unsafe archive path: '+$n)};$total += $e.Length};if($count -gt ${MAX_OOXML_ENTRIES}){throw 'too many archive entries'};if($total -gt ${MAX_OOXML_UNCOMPRESSED_BYTES}){throw 'archive expands beyond the OOXML limit'};[pscustomobject]@{count=$count;total=$total}|ConvertTo-Json -Compress}finally{$z.Dispose()}`;
    await runPowerShell(script, { label:'validate OOXML archive', timeout:30_000 });
    return;
  }
  if (!commandExists('unzip')) unavailable('OOXML document editing', 'unzip is required');
  const names = await runFile('unzip', ['-Z','-1',source], { label:'inspect OOXML archive', timeout:30_000, maxBuffer:16 * 1024 * 1024 });
  const entries = names.stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length > MAX_OOXML_ENTRIES) throw new Error(`OOXML archive has too many entries (${entries.length}; max ${MAX_OOXML_ENTRIES})`);
  const unsafe = entries.find(name => !safeArchiveEntry(name));
  if (unsafe) throw new Error(`OOXML archive contains an unsafe path: ${unsafe}`);
  const details = await runFile('unzip', ['-Z','-v',source], { label:'inspect OOXML entry types', timeout:30_000, maxBuffer:16 * 1024 * 1024 });
  if (/symbolic link|Unix file attributes \([^)]*\b12\d{4}/i.test(details.stdout)) throw new Error('OOXML archive contains a symbolic link');
  const totals = await runFile('unzip', ['-Z','-t',source], { label:'inspect OOXML archive size', timeout:30_000 });
  const uncompressed = Number(totals.stdout.match(/(?:^|,\s)([0-9]+) bytes uncompressed/)?.[1] || 0);
  if (uncompressed > MAX_OOXML_UNCOMPRESSED_BYTES) throw new Error(`OOXML archive expands to ${uncompressed} bytes; max ${MAX_OOXML_UNCOMPRESSED_BYTES}`);
}

export async function extractZip(source, destination) {
  const sourceDirectory = await tempDir('remcp-ooxml-source-');
  const sourceCopy = path.join(sourceDirectory, 'source.zip');
  try {
    await copyRegularNoFollow(source, sourceCopy);
    await validateZipArchive(sourceCopy);
    await mkdir(destination, { recursive:true });
    if (process.platform === 'win32') {
      await runPowerShell(`Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::ExtractToDirectory('${escapePowerShellSingle(sourceCopy)}','${escapePowerShellSingle(destination)}')`, { label:'extract OOXML archive', timeout:30_000 });
    } else {
      if (!commandExists('unzip')) unavailable('OOXML document editing', 'unzip is required');
      await runFile('unzip', ['-qq',sourceCopy,'-d',destination], { label:'extract OOXML archive', timeout:30_000 });
    }
    await assertSafeExtractedTree(destination);
  } finally {
    await removeTemp(sourceDirectory);
  }
}

export async function createZip(sourceDir, destination) {
  await rm(destination, { force:true }).catch(() => {});
  if (process.platform === 'win32') {
    await runPowerShell(`Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::CreateFromDirectory('${escapePowerShellSingle(sourceDir)}','${escapePowerShellSingle(destination)}',[IO.Compression.CompressionLevel]::Optimal,$false)`, { label:'create OOXML archive', timeout:30_000 });
    return;
  }
  if (!commandExists('zip')) unavailable('OOXML document editing', 'zip is required');
  await runFile('zip', ['-qr',destination,'.'], { cwd:sourceDir, label:'create OOXML archive', timeout:30_000 });
}

export async function commitDocumentOutput(staged, destination, { noReplace = false } = {}) {
  const parentDirectory = await openDocumentDirectoryPath(path.dirname(destination));
  const parentAnchor = parentDirectory.anchor;
  const destinationPath = path.join(parentAnchor, path.basename(destination));
  try {
    if (noReplace) {
      await link(staged, destinationPath);
      await unlink(staged);
      return;
    }
    try {
      await rename(staged, destinationPath);
      return;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
    }
    const backup = path.join(parentAnchor, `.${path.basename(destination)}.remcp-old-${randomUUID()}`);
    let moved = false;
    try {
      await rename(destinationPath, backup);
      moved = true;
      await rename(staged, destinationPath);
      await rm(backup, { force: true }).catch(() => {});
    } catch (error) {
      if (moved && !await lstat(destinationPath).catch(() => null)) await rename(backup, destinationPath).catch(() => {});
      throw error;
    }
  } finally {
    await parentDirectory.close().catch(() => {});
  }
}

export async function ensureCreateTargetIsNew(filePath) {
  try {
    await stat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Cannot create document because path already exists: ${filePath}`);
}

export async function writeOoxmlPart(root, relative, content) {
  const target = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive:true });
  await writeFile(target, content, 'utf8');
}
