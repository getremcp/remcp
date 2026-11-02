import os from 'node:os';
import path from 'node:path';

// macOS protects Desktop, Documents, Downloads, iCloud Drive and external volumes behind TCC (the
// privacy layer that used to be callable "Full Disk Access"). A process without the grant gets a bare
// `EACCES: permission denied, mkdir '/Users/ada/Desktop/notes'` from the kernel, which tells the person
// nothing they can act on. ReMCP usually runs as a background service, and a background service cannot
// show the prompt macOS shows an app, so the grant has to be made by hand:
//     System Settings → Privacy & Security → Full Disk Access → + → the binary that runs the tools
// These helpers turn those errnos into that instruction. They never widen access — they explain it.
const MACOS_HOME_FOLDERS = Object.freeze(['Desktop', 'Documents', 'Downloads']);
const WINDOWS_HOME_FOLDERS = Object.freeze([['Desktop'], ['Documents'], ['Downloads'], ['OneDrive', 'Desktop'], ['OneDrive', 'Documents']]);
const PERMISSION_CODES = new Set(['EACCES', 'EPERM']);

// The protected location a path belongs to ("~/Desktop", "iCloud Drive", "an external volume"), or
// null when macOS does not treat that path as protected. Pure and injectable so it can be tested on
// any platform.
export function macosProtectedLocation(target, { platform = process.platform, home = os.homedir() } = {}) {
  if (platform !== 'darwin') return null;
  const value = typeof target === 'string' ? target.trim() : '';
  if (!value) return null;
  // Evaluate macOS paths with POSIX semantics even when diagnostics/tests run on
  // Windows. Using the host path module turns /Users/... into a Windows path.
  const resolved = path.posix.resolve(value);
  if (resolved === '/Volumes' || resolved.startsWith('/Volumes/')) return 'an external or network volume';
  // The kernel reports the absolute path, so a folder can be recognised even when it belongs to
  // another account: every /Users/<name>/Desktop is somebody's Desktop, and it is protected for the
  // process that is asking, whatever this runtime's own home directory is.
  const segments = resolved.split(path.posix.sep);
  const relative = home ? path.posix.relative(path.posix.resolve(home), resolved) : '';
  const insideHome = relative && !relative.startsWith('..') && !path.posix.isAbsolute(relative);
  const candidate = insideHome ? relative.split(path.posix.sep) : segments[0] === '' && segments[1] === 'Users' ? segments.slice(3) : null;
  if (!candidate?.length) return null;
  const [first, second] = candidate;
  if (MACOS_HOME_FOLDERS.includes(first)) return `~/${first}`;
  if (first === 'Library' && second === 'Mobile Documents') return 'iCloud Drive';
  return null;
}

// Windows 11 ships the same idea as TCC under a different name: Controlled folder access (Windows
// Security → Virus & threat protection → Ransomware protection) blocks Desktop, Documents and
// Downloads for every application that is not on its allow list, and the process sees EPERM/EACCES.
export function windowsProtectedLocation(target, { platform = process.platform, home = os.homedir() } = {}) {
  if (platform !== 'win32') return null;
  const value = typeof target === 'string' ? target.trim() : '';
  if (!value || !home) return null;
  const relative = path.win32.relative(path.win32.resolve(home), path.win32.resolve(value));
  if (!relative || relative.startsWith('..') || path.win32.isAbsolute(relative)) return null;
  const parts = relative.split(path.win32.sep);
  const match = WINDOWS_HOME_FOLDERS.find(entry => entry.every((segment, index) => (parts[index] || '').toLowerCase() === segment.toLowerCase()));
  return match ? `%USERPROFILE%\\${match.join('\\')}` : null;
}

// What the person should do about this failure, or null when the error is not a filesystem permission
// problem this module has better words for.
export function filesystemErrorExplanation(error, options = {}) {
  const {
    // Node puts the failing path on the error itself, so a caller that forgets to pass one still gets
    // the right sentence; an explicit path wins because some callers catch a re-thrown error.
    path: target = error?.path,
    platform = process.platform,
    home = os.homedir(),
    execPath = process.execPath,
  } = options;
  const code = typeof error?.code === 'string' ? error.code : '';
  const where = typeof target === 'string' && target.trim() ? target.trim() : 'that path';
  if (code === 'ENOSPC') return 'The disk is full (ENOSPC). Free some space or write to another volume.';
  if (code === 'EDQUOT') return 'The disk or temporary-file quota is exhausted (EDQUOT). Free quota space or select another writable volume.';
  if (code === 'ENOENT') return `The file or folder does not exist (ENOENT): ${where}. Check its name and drive letter.`;
  if (code === 'ENOTDIR') return `A component of ${where} is a file instead of a directory (ENOTDIR). Check the parent path.`;
  if (code === 'EROFS') return `${where} is on a read-only file system (EROFS). Write somewhere else, or remount it read-write.`;
  if (code === 'EBUSY') return `${where} is in use by another program (EBUSY). Close whatever holds it and try again.`;
  if (!PERMISSION_CODES.has(code)) return null;
  const protectedLocation = macosProtectedLocation(target, { platform, home });
  if (protectedLocation) {
    return `macOS protects ${protectedLocation} (${code}), and ReMCP runs as a background service, which cannot show the permission prompt. Grant it by hand: System Settings → Privacy & Security → Full Disk Access → + → ${execPath}, then restart the agent with \`remcp start\`. A folder outside Desktop, Documents, Downloads and iCloud Drive needs no new permission.`;
  }
  const windowsLocation = windowsProtectedLocation(target, { platform, home });
  if (windowsLocation) {
    return `Windows Controlled folder access is blocking ${windowsLocation} (${code}). Add the binary that runs the tools (${execPath}) under Windows Security → Virus & threat protection → Ransomware protection → Allow an app through Controlled folder access, then restart the agent with \`remcp start\`. A folder outside Desktop, Documents, Downloads and OneDrive needs no new permission.`;
  }
  if (platform === 'darwin') {
    return `macOS denied access to ${where} (${code}). Check that this user owns the folder and its parents, or choose another path. If normal permissions are correct and macOS privacy still blocks it, add ${execPath} to System Settings → Privacy & Security → Full Disk Access and restart the agent with \`remcp start\`.`;
  }
  if (platform === 'win32') {
    return `Windows denied access to ${where} (${code}). Check whether the file is read-only, open in another program, or inside a Controlled folder access area, then allow ${execPath} through Windows Security (Controlled folder access) and restart the agent with \`remcp start\`.`;
  }
  return `The operating system denied access to ${where} (${code}). Check that this user owns the folder and its parents, or choose another path.`;
}

// One line for the tool result: the original errno first (so a log or an engineer still sees exactly
// what the kernel said), then what to do about it.
export function describeFilesystemFailure(error, options = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const explanation = filesystemErrorExplanation(error, options);
  return explanation ? `${message} ${explanation}` : message;
}
