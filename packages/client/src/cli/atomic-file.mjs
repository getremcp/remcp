import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// Same-directory exclusive staging ensures that a short write or failed fsync
// never truncates the current file. No fallback to in-place writes.
export function replaceFileAtomically(file, data, {mode = 0o600, preserveMode = false, followSymlink = false} = {}) {
  let target = file;
  if (followSymlink) {
    try { target = fs.realpathSync(file); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      // A dangling profile symlink must not be replaced with a regular file.
      try { if (fs.lstatSync(file).isSymbolicLink()) throw error; }
      catch (statError) { if (statError === error || statError?.code !== 'ENOENT') throw statError; }
    }
  }
  if (preserveMode) {
    try { mode = fs.statSync(target).mode & 0o777; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  const temporary = path.join(path.dirname(target), '.remcp-write-' + randomUUID() + '.tmp');
  const fd = fs.openSync(temporary, 'wx', mode);
  try {
    try {
      fs.writeFileSync(fd, data);
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}
