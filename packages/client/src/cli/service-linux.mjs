// Linux headless agents may be supervised by PID 1. Never mistake a system unit for
// a session-owned user unit during status checks, repairs or auto-updates.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { home, linuxServiceFile, linuxServiceLauncherFile } from './env.mjs';
import { resolvedCliScript, shellQuote } from './service-paths.mjs';

export const linuxSystemServiceFile = '/etc/systemd/system/remcp-agent.service';

export function isManagedLinuxSystemUnit(text, launcher = linuxServiceLauncherFile) {
  if (typeof text !== 'string') return false;
  const expected = new Set([
    'ExecStart="' + launcher.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '" start --service',
    'ExecStart=' + launcher + ' start --service',
  ]);
  return text.split(/\r?\n/).some(line => expected.has(line.trim()));
}

// Discover BOTH supervisors before uninstalling either. A PID-1 migration may
// leave a disabled historical user unit behind; removing only the active scope
// makes status incorrectly report an installed service after uninstall.
// Pin every Linux path component, then validate the opened unit descriptor.
// A check-before-open lstat or a symlinked parent could redirect a later read.
function readOwnedLinuxUnit(file, launcher, expected = null) {
  const pinnedDirs = [];
  let fd;
  try {
    let source = file;
    if (process.platform === 'linux') {
      if (!path.isAbsolute(file)) throw new Error('ReMCP systemd unit path must be absolute');
      const parts = path.normalize(file).split(path.sep).filter(Boolean);
      const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
      let parent = fs.openSync(path.parse(file).root, flags);
      pinnedDirs.push(parent);
      for (const part of parts.slice(0, -1)) {
        parent = fs.openSync(`/proc/self/fd/${parent}/${part}`, flags);
        pinnedDirs.push(parent);
      }
      source = `/proc/self/fd/${parent}/${parts.at(-1)}`;
    }
    fd = fs.openSync(source, fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(fd);
    const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
    const limit = 64 * 1024;
    if (!opened.isFile() || opened.size > limit ||
        (expected && !same(expected, opened))) {
      throw new Error('Unrecognized or replaced ReMCP systemd unit: ' + file);
    }
    // Bound reads even if a malicious actor grows the file after fstat.
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < buffer.length) {
      const bytes = fs.readSync(fd, buffer, count, buffer.length - count, count);
      if (bytes === 0) break;
      count += bytes;
    }
    if (count > limit) throw new Error('Oversized ReMCP systemd unit: ' + file);
    const body = buffer.toString('utf8', 0, count);
    const after = fs.lstatSync(source);
    const readStat = fs.fstatSync(fd);
    if (!after.isFile() || after.isSymbolicLink() || !same(after, opened) ||
        readStat.size !== opened.size || readStat.mtimeMs !== opened.mtimeMs ||
        !isManagedLinuxSystemUnit(body, launcher)) {
      throw new Error('Unrecognized or changed ReMCP systemd unit: ' + file);
    }
    return { dev: opened.dev, ino: opened.ino };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    for (const parent of pinnedDirs.reverse()) fs.closeSync(parent);
  }
}

export function discoverOwnedLinuxUnits({
  systemFile = linuxSystemServiceFile,
  userFile = linuxServiceFile,
  launcher = linuxServiceLauncherFile,
  includeSystem = process.getuid?.() === 0,
} = {}) {
  const candidates = [
    ...(includeSystem ? [{ scope:'system', file:systemFile }] : []),
    { scope:'user', file:userFile },
  ];
  const found = [];
  for (const unit of candidates) {
    // Only a file missing at initial discovery may be skipped. If it is
    // removed while we verify the open descriptor, fail closed instead.
    try { fs.lstatSync(unit.file); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    let identity;
    try { identity = readOwnedLinuxUnit(unit.file, launcher); }
    catch (error) {
      throw new Error('Refusing to uninstall an unrecognized ReMCP systemd unit: ' +
        unit.file, { cause: error });
    }
    found.push({ ...unit, ...identity });
  }
  return found;
}

// Stop and remove all owned scopes, not just the newest one. Require the
// stop and daemon-reload to succeed; never claim success after a failed stop.
export function uninstallOwnedLinuxUnits({
  systemFile = linuxSystemServiceFile,
  userFile = linuxServiceFile,
  launcher = linuxServiceLauncherFile,
  includeSystem = process.getuid?.() === 0,
  runner = spawnSync,
} = {}) {
  const units = discoverOwnedLinuxUnits({ systemFile, userFile, launcher, includeSystem });
  for (const { scope, file, dev, ino } of units) {
    const option = scope === 'user' ? ['--user'] : [];
    const stop = runner('systemctl', [...option, 'disable', '--now', 'remcp-agent.service'],
      { encoding:'utf8', timeout:20000 });
    if (stop.status !== 0) {
      throw new Error('Failed to stop ReMCP ' + scope +
        ' systemd service; refusing to report a successful uninstall');
    }
    const active = runner('systemctl', [...option, 'is-active', '--quiet', 'remcp-agent.service'],
      { stdio:'ignore', timeout:10000 });
    if (active.status === 0) {
      throw new Error('ReMCP ' + scope + ' systemd service remains active after stop');
    }
    // Another actor must not replace an owned unit with a symlink or foreign
    // content between discovery and removal.
    try { readOwnedLinuxUnit(file, launcher, { dev, ino }); }
    catch (error) {
      throw new Error('ReMCP systemd unit changed during uninstall: ' + file,
        { cause: error });
    }
    fs.unlinkSync(file);
    const reload = runner('systemctl', [...option, 'daemon-reload'],
      { encoding:'utf8', timeout:20000 });
    if (reload.status !== 0) {
      throw new Error('Failed to reload ' + scope + ' systemd after removing ReMCP service');
    }
  }
  return units.map(unit => unit.scope);
}

export function linuxSystemAgentOwned() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return false;
  try {
    readOwnedLinuxUnit(linuxSystemServiceFile, linuxServiceLauncherFile);
    return true;
  } catch {
    return false;
  }
}

export function linuxServiceScope() {
  return linuxSystemAgentOwned() ? 'system' : 'user';
}

export function linuxActiveServiceFile() {
  return linuxServiceScope() === 'system' ? linuxSystemServiceFile : linuxServiceFile;
}

// Without linger, logind terminates user@UID.service at the final logout,
// even if systemctl --user enable --now reported success.
export function ensureLinuxLinger() {
  if (process.platform !== 'linux') return;
  // Test-only synthetic HOME has no logind account and must never mutate the host.
  // Guard before os.userInfo(): an isolated CI UID may not have a passwd entry.
  if (process.env.NODE_ENV === 'test' && process.env.REMCP_TEST_PLATFORM === 'linux') return;
  let account;
  try { account = os.userInfo(); }
  catch { throw new Error('ReMCP cannot resolve the current Linux account for persistent systemd supervision.'); }
  if (path.resolve(home) !== path.resolve(account.homedir)) {
    throw new Error('Refusing a persistent Linux service with HOME different from the account home directory.');
  }
  const username = account.username;
  const query = () => spawnSync('loginctl', ['show-user', username, '-p', 'Linger', '--value'],
    { encoding:'utf8', timeout:10000 });
  let state = query();
  if (state.status === 0 && state.stdout.trim() === 'yes') return;
  const enabled = spawnSync('loginctl', ['enable-linger', username],
    { encoding:'utf8', timeout:10000 });
  if (enabled.status !== 0) {
    throw new Error('ReMCP cannot guarantee background operation after logout: '
      + 'loginctl enable-linger failed. Ask an administrator to enable lingering for this account.');
  }
  state = query();
  if (state.status !== 0 || state.stdout.trim() !== 'yes') {
    throw new Error('ReMCP cannot verify systemd lingering; refusing to claim persistent installation.');
  }
}

// The vetted bootstrap may install npm under ~/.local/share/remcp/npm and Node
// under ~/.local/share/remcp/bootstrap; neither bin is necessarily on login PATH.
export function linuxCliShimText(cliPath, nodePath) {
  const entry = resolvedCliScript(cliPath);
  const suffix = path.join('lib', 'node_modules', '@remcp', 'remcp', 'bin', 'remcp.mjs');
  const prefix = entry.endsWith(path.sep + suffix)
    ? entry.slice(0, -(suffix.length + 1)) : path.dirname(path.dirname(cliPath));
  return '#!/bin/sh\n# ReMCP managed CLI shim\nNPM_CONFIG_PREFIX=' + shellQuote(prefix)
    + '\nexport NPM_CONFIG_PREFIX\nPATH=' + shellQuote(path.dirname(nodePath)) + ':$PATH'
    + '\nexport PATH\nexec ' + shellQuote(nodePath) + ' ' + shellQuote(entry) + ' "$@"\n';
}

const linuxCliPathBlockStart = '# >>> ReMCP CLI PATH >>>';
const linuxCliPathBlockEnd = '# <<< ReMCP CLI PATH <<<';

// Put the managed command before NVM's global bins after the shell's normal
// startup logic. This updates only the owning user's shell profiles, never
// Node versions, npm packages, system profiles, or another account.
export function ensureLinuxCliInShellPath(homeDir = home) {
  if (process.platform !== 'linux' || process.getuid?.() === 0) return;
  const block = [linuxCliPathBlockStart,
    'case ":$PATH:" in',
    '  *":$HOME/.local/bin:"*) ;;',
    '  *) export PATH="$HOME/.local/bin:$PATH" ;;',
    'esac', linuxCliPathBlockEnd].join('\n');
  for (const basename of ['.bashrc', '.profile']) {
    const profile = path.join(homeDir, basename);
    let current = '';
    let mode = 0o600;
    try {
      const stat = fs.lstatSync(profile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) continue;
      if (stat.size > 1024 * 1024) continue;
      mode = stat.mode & 0o777;
      current = fs.readFileSync(profile, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') continue;
    }
    const start = current.indexOf(linuxCliPathBlockStart);
    const end = start >= 0 ? current.indexOf(linuxCliPathBlockEnd, start) : -1;
    // An unclosed marker might be user-maintained; do not rewrite it.
    if (start >= 0 && end < 0) continue;
    const replacement = start >= 0
      ? current.slice(0, start) + block + current.slice(end + linuxCliPathBlockEnd.length)
      : current + (current && !current.endsWith('\n') ? '\n' : '') + '\n' + block + '\n';
    if (replacement === current) continue;
    const temporary = profile + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, replacement, { mode, flag:'wx' });
    try { fs.renameSync(temporary, profile); }
    catch (error) { fs.unlinkSync(temporary); throw error; }
  }
}

export function ensureLinuxCliCommand(cliPath, nodePath) {
  if (process.platform !== 'linux') return;
  const destination = process.getuid?.() === 0
    ? '/usr/local/bin/remcp' : path.join(home, '.local', 'bin', 'remcp');
  fs.mkdirSync(path.dirname(destination), { recursive:true, mode:0o755 });
  const marker = '# ReMCP managed CLI shim';
  if (fs.existsSync(destination)) {
    const current = fs.readFileSync(destination, 'utf8');
    if (!current.includes(marker)) return; // Never overwrite an unrelated executable.
  }
  const content = linuxCliShimText(cliPath, nodePath);
  const temp = destination + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, content, { mode:0o755 });
  fs.renameSync(temp, destination);
  ensureLinuxCliInShellPath();
}
