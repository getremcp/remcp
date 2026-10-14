import path from 'node:path';
import process from 'node:process';
import { closeSync, fchmodSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 16;
const MAX_SNAPSHOTS = 12;
const NOFOLLOW = constants.O_NOFOLLOW || 0;
const DIRECTORY = constants.O_DIRECTORY || 0;

function ownedRegularFile(file, maxBytes) {
  let fd;
  try {
    if (process.platform === 'win32' && lstatSync(file).isSymbolicLink()) return null;
    fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return null;
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function sessionMetadata(profile) {
  const file = path.join(profile, 'Default', 'Preferences');
  let fd;
  try {
    if (process.platform === 'win32' && lstatSync(file).isSymbolicLink()) return null;
    fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return null;
    return JSON.parse(readFileSync(fd, 'utf8'))?.profile?.exit_type || null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function safeDirectory(dir) {
  try { mkdirSync(dir, { recursive: false, mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  // Open first and validate the handle, not the path: an lstat-then-open
  // check would leave a filesystem race at the recovery destination.
  if (process.platform === 'win32' && lstatSync(dir).isSymbolicLink()) throw new Error('Unsafe recovery directory');
  const fd = openSync(dir, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    if (!fstatSync(fd).isDirectory()) throw new Error('Unsafe recovery directory');
    if (process.platform !== 'win32') fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
}

function rawCopy(from, to, expected) {
  let source;
  let destination;
  try {
    source = openSync(from, constants.O_RDONLY | NOFOLLOW);
    const before = fstatSync(source);
    if (!before.isFile() || before.size !== expected.size || before.mtimeMs !== expected.mtimeMs) {
      throw new Error('Browser session changed while preparing the snapshot');
    }
    destination = openSync(to, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
    const buffer = Buffer.alloc(128 * 1024);
    let total = 0;
    while (total < expected.size) {
      const count = readSync(source, buffer, 0, Math.min(buffer.length, expected.size - total), null);
      if (count === 0) throw new Error('Browser session was truncated during snapshot');
      let written = 0;
      while (written < count) {
        const next = writeSync(destination, buffer, written, count - written);
        if (!next) throw new Error('Could not finish session backup write');
        written += next;
      }
      total += count;
    }
    const after = fstatSync(source);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('Browser session changed during snapshot');
    }
    fsyncSync(destination);
  } finally {
    if (source !== undefined) closeSync(source);
    if (destination !== undefined) closeSync(destination);
  }
}

// Called only before auto-launch of a *crashed* dedicated ReMCP CDP profile.
// The source data stays on the user's computer; no tab URLs are parsed or sent
// across the MCP connection. Never delete prior snapshots automatically.
export function preserveInterruptedBrowserSession(profile) {
  if (sessionMetadata(profile) !== 'Crashed') return { saved: false, reason: 'clean-or-missing' };
  const sessionDir = path.join(profile, 'Default', 'Sessions');
  let dirFd;
  try {
    if (process.platform !== 'win32') {
      try { dirFd = openSync(sessionDir, constants.O_RDONLY | DIRECTORY | NOFOLLOW); }
      catch (error) { if (error?.code === 'ENOENT') return { saved: false, reason: 'no-sessions' }; throw error; }
      if (!fstatSync(dirFd).isDirectory()) throw new Error('Session directory is unsafe');
    }
    const readableDir = dirFd === undefined ? sessionDir : `${process.platform === 'darwin' ? '/dev/fd' : '/proc/self/fd'}/${dirFd}`;
    const files = [];
    let total = 0;
    for (const name of readdirSync(readableDir).sort()) {
      if (!/^(?:Session|Tabs)_\d+$/.test(name)) continue;
      const details = ownedRegularFile(path.join(readableDir, name), MAX_FILE_BYTES);
      if (!details) throw new Error('Session file is unsafe, empty or oversized');
      total += details.size;
      files.push({ name, ...details });
      if (files.length > MAX_FILES || total > MAX_TOTAL_BYTES) throw new Error('Session data exceeds safe snapshot limits');
    }
    if (!files.some(file => file.name.startsWith('Tabs_'))) return { saved: false, reason: 'no-tabs' };

    const recoveryDir = path.join(path.dirname(profile), `${path.basename(profile)}-recovery`);
    safeDirectory(recoveryDir);
    const fingerprint = JSON.stringify(files);
    const snapshots = readdirSync(recoveryDir).filter(name => /^snapshot-[A-Za-z0-9]+$/.test(name));
    for (const name of snapshots) {
      const manifest = path.join(recoveryDir, name, 'manifest.json');
      try {
        const fd = openSync(manifest, constants.O_RDONLY | NOFOLLOW);
        let content;
        try { if (fstatSync(fd).size > 8192) continue; content = JSON.parse(readFileSync(fd, 'utf8')); }
        finally { closeSync(fd); }
        if (content?.fingerprint === fingerprint) return { saved: false, reason: 'already-saved' };
      } catch { /* Ignore incomplete previous attempts; never overwrite them. */ }
    }
    if (snapshots.length >= MAX_SNAPSHOTS) throw new Error('Session recovery snapshot limit reached');
    const snapshotDir = mkdtempSync(path.join(recoveryDir, 'snapshot-'));
    try {
      for (const file of files) rawCopy(path.join(readableDir, file.name), path.join(snapshotDir, file.name), file);
      writeFileSync(path.join(snapshotDir, 'manifest.json'), JSON.stringify({ fingerprint, count: files.length, hasWindowSession: files.some(f => f.name.startsWith('Session_')) }), { flag: 'wx', mode: 0o600 });
      return { saved: true, reason: 'saved', count: files.length, bytes: total };
    } catch (error) {
      rmSync(snapshotDir, { recursive: true, force: true });
      throw error;
    }
  } finally { if (dirFd !== undefined) closeSync(dirFd); }
}
