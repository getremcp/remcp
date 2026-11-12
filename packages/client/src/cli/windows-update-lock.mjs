// Serializes writes to one Windows npm global prefix across manual and agent updates.
// The lock exists outside the npm-managed package/shim trees and is held through rollback.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';

const LOCK_NAME = '.remcp-update-lock';
const OWNER_NAME = 'owner.json';

function lockOwnerFile(directory) {
  return path.join(directory, OWNER_NAME);
}

function ownerIsLive(directory) {
  try {
    const owner = JSON.parse(fs.readFileSync(lockOwnerFile(directory), 'utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return true;
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    // On Windows and Unix, only ESRCH is reliable evidence the owner has exited.
    // Permission errors and damaged/incomplete owner metadata must fail closed.
    return error?.code !== 'ESRCH';
  }
}

function removeOwnedLock(directory, token) {
  let owner;
  try {
    if (!fs.lstatSync(directory).isDirectory()) return;
    owner = JSON.parse(fs.readFileSync(lockOwnerFile(directory), 'utf8'));
  } catch { return; }
  if (owner.token !== token || owner.pid !== process.pid) return;
  try {
    fs.unlinkSync(lockOwnerFile(directory));
    fs.rmdirSync(directory);
  } catch (error) {
    // Never force-remove unexpected files created by another process.
    if (error?.code !== 'ENOENT') console.error('ReMCP update lock cleanup failed:', error?.message);
  }
}

// Explicit local repair only. Preserve evidence rather than deleting an interrupted
// transaction. A failed/denied PID query is not proof that the owner exited.
export function recoverWindowsUpdateLock(prefix) {
  if (!path.isAbsolute(prefix)) throw new Error('Windows repair requires an absolute npm prefix.');
  const directory = path.join(prefix, LOCK_NAME);
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe Windows update lock metadata.');
  const entries = fs.readdirSync(directory);
  if (entries.length !== 1 || entries[0] !== OWNER_NAME) throw new Error('Unexpected Windows update lock contents; manual review required.');
  const file = lockOwnerFile(directory);
  const metadata = fs.lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) throw new Error('Unsafe Windows update owner metadata.');
  const raw = fs.readFileSync(file, 'utf8');
  let owner;
  try { owner = JSON.parse(raw); } catch { throw new Error('Invalid Windows update owner metadata.'); }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string' ||
      !owner.token || !Number.isFinite(owner.startedAt)) throw new Error('Invalid Windows update owner metadata.');
  try {
    process.kill(owner.pid, 0);
    throw new Error('Windows update owner is still active; repair refused.');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  // Fail closed if another actor changed ownership while it was inspected.
  if (fs.readFileSync(file, 'utf8') !== raw || fs.readdirSync(directory).length !== 1) {
    throw new Error('Windows update owner changed during repair.');
  }
  const archived = path.join(prefix, '.remcp-update-lock-recovered-' + crypto.randomUUID());
  fs.renameSync(directory, archived);
  return archived;
}

export function withWindowsUpdateLock(prefix, operation) {
  if (!path.isAbsolute(prefix)) throw new Error('Windows update lock requires an absolute npm prefix.');
  if (typeof operation !== 'function') throw new TypeError('Windows update operation is required.');
  fs.mkdirSync(prefix, { recursive:true });
  const directory = path.join(prefix, LOCK_NAME);
  try {
    fs.mkdirSync(directory, { mode:0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const stale = !ownerIsLive(directory);
    throw new Error(stale
      ? 'ReMCP previous Windows update exited without releasing its lock; repair the stale update lock before retrying.'
      : 'ReMCP update already in progress for this Windows npm prefix; retry after it finishes.');
  }

  const token = crypto.randomUUID();
  try {
    fs.writeFileSync(lockOwnerFile(directory), JSON.stringify({
      pid:process.pid, token, startedAt:Date.now(),
    }), { flag:'wx', mode:0o600 });
  } catch (error) {
    try { fs.rmdirSync(directory); } catch {}
    throw error;
  }

  const onExit = () => removeOwnedLock(directory, token);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener('exit', onExit);
    removeOwnedLock(directory, token);
  };
  process.once('exit', onExit);
  try {
    const result = operation();
    // A future async installer must retain the prefix lock until it settles.
    // Releasing here would let another updater move the same package/shims.
    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).finally(release);
    }
    release();
    return result;
  } catch (error) {
    release();
    throw error;
  }
}
