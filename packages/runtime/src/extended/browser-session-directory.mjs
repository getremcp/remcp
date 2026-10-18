// Keep Chrome recovery's directory-file-descriptor safety on Unix, while
// accommodating macOS: its /dev/fd/N aliases cannot be scanned as directories.
// This profile belongs to ReMCP, not to the user's normal Chrome profile.
import process from 'node:process';
import path from 'node:path';
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync,
} from 'node:fs';

const NOFOLLOW = constants.O_NOFOLLOW || 0;
const DIRECTORY = constants.O_DIRECTORY || 0;

export function verifySessionDirectory(directory, fd, platform = process.platform) {
  if (platform !== 'darwin') return;
  const opened = fstatSync(fd);
  const current = lstatSync(directory);
  if (!opened.isDirectory() || !current.isDirectory() ||
      opened.dev !== current.dev || opened.ino !== current.ino ||
      (typeof process.getuid === 'function' && current.uid !== process.getuid())) {
    throw new Error('Browser session directory changed or is unsafe');
  }
}

export function scanSessionDirectory(directory, fd, platform = process.platform) {
  const readable = platform === 'win32' ? directory
    : platform === 'darwin' ? directory : `/proc/self/fd/${fd}`;
  verifySessionDirectory(directory, fd, platform);
  const names = readdirSync(readable);
  verifySessionDirectory(directory, fd, platform);
  return { readable, names };
}

export function shouldRestoreBrowserSession(profile) {
  let prefsFd;
  let sessionFd;
  try {
    const defaultProfile = path.join(profile, 'Default');
    prefsFd = openSync(path.join(defaultProfile, 'Preferences'), constants.O_RDONLY | NOFOLLOW);
    const prefsStat = fstatSync(prefsFd);
    if (!prefsStat.isFile() || prefsStat.size > 4 * 1024 * 1024) return false;
    const prefs = JSON.parse(readFileSync(prefsFd, 'utf8'));
    if (prefs?.profile?.exit_type !== 'Crashed') return false;

    const sessionDir = path.join(defaultProfile, 'Sessions');
    if (process.platform !== 'win32') {
      sessionFd = openSync(sessionDir, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
      if (!fstatSync(sessionFd).isDirectory()) return false;
    }
    const { readable, names } = scanSessionDirectory(sessionDir, sessionFd);
    const found = names.some(name => {
      if (!/^Tabs_\d+$/.test(name)) return false;
      let tabFd;
      try {
        verifySessionDirectory(sessionDir, sessionFd);
        tabFd = openSync(path.join(readable, name), constants.O_RDONLY | NOFOLLOW);
        const stat = fstatSync(tabFd);
        verifySessionDirectory(sessionDir, sessionFd);
        return stat.isFile() && stat.size > 0;
      } catch { return false; }
      finally { if (tabFd !== undefined) closeSync(tabFd); }
    });
    verifySessionDirectory(sessionDir, sessionFd);
    return found;
  } catch {
    // Never restore from missing, malformed, symlinked or inaccessible evidence.
    return false;
  } finally {
    if (sessionFd !== undefined) closeSync(sessionFd);
    if (prefsFd !== undefined) closeSync(prefsFd);
  }
}
