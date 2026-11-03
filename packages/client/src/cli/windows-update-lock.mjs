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
  process.once('exit', onExit);
  try {
    return operation();
  } finally {
    process.removeListener('exit', onExit);
    removeOwnedLock(directory, token);
  }
}
