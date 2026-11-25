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
  let section = '';
  const commands = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.endsWith('\\')) return false;
    if (/^\[.*\]$/.test(line)) section = line;
    if (/^ExecStart\s*=/.test(line)) commands.push({section, line});
    else if (/^Exec[A-Za-z]*\s*=/.test(line)) return false; // Do not assume ownership of additional executable hooks.
  }
  return commands.length === 1 && commands[0].section === '[Service]' && expected.has(commands[0].line);
}

// Inspect disk candidates even when the systemd manager has not reloaded yet.
// Cover type-wide, dash-prefix and exact service drop-ins. Preserve benign
// local Environment/UMask overrides; reject additional executable directives.
export function assertNoLinuxExecDropIns(file, scope, {runner = spawnSync, unitPaths = null, legacyLauncher = null} = {}) {
  const synthetic = process.env.NODE_ENV === 'test' && process.env.REMCP_TEST_PLATFORM === 'linux';
  const options = scope === 'user' ? ['--user'] : [];
  const query = args => {
    const result = runner('systemctl', [...options, ...args], {
      encoding:'utf8', timeout:5000, maxBuffer:256*1024,
    });
    if (result.status !== 0 || result.error || result.signal)
      throw new Error('Could not inspect ReMCP systemd overrides');
    return String(result.stdout || '');
  };
  const live = unitPaths === null && !synthetic && runner === spawnSync;
  let paths = unitPaths;
  if (live) {
    paths = query(['show','--property=UnitPath','--value']).trim().split(/\s+/);
    if (!paths.length || paths.some(dir => !path.isAbsolute(dir)))
      throw new Error('Could not establish systemd unit search paths');
    const effective = query(['show','--all','--no-pager','remcp-agent.service',
      ...['LoadState','FragmentPath','ExecStart','ExecCondition','ExecStartPre','ExecStartPost','ExecReload','ExecStop','ExecStopPost','ExecSearchPath']
        .map(key => '--property='+key)]);
    const properties = new Map(effective.split(/\r?\n/).filter(line=>line.includes('='))
      .map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
    const state = properties.get('LoadState'), fragment = properties.get('FragmentPath');
    if (!['loaded','not-found'].includes(state) || (state === 'loaded' && fragment !== file))
      throw new Error('Refusing an unexpected loaded ReMCP systemd unit');
    if ([...properties].some(([key,value])=>key.startsWith('Exec') && key !== 'ExecStart' && value.trim()))
      throw new Error('Refusing executable ReMCP systemd overrides in loaded unit');
    if (state === 'loaded') {
      const start = properties.get('ExecStart') || '';
      const owned = [linuxServiceLauncherFile,legacyLauncher].filter(Boolean).some(launcher => {
        const prefix = '{ path='+launcher+' ; argv[]='+launcher+' start --service ; ignore_errors=no ;';
        return start.startsWith(prefix) && !start.slice(prefix.length).includes('{ path=');
      });
      if (!owned) throw new Error('Refusing unexpected effective ReMCP systemd ExecStart');
    }
  }
  for (const root of new Set([path.dirname(file),...(paths || [])])) {
    for (const suffix of ['service.d','remcp-.service.d','remcp-agent.service.d']) {
      const dir = path.join(root,suffix);
      let entries;
      try { entries = fs.readdirSync(dir); }
      catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
      for (const name of entries.filter(name=>name.endsWith('.conf'))) {
        const override = path.join(dir,name);
        const stat = fs.lstatSync(override);
        // systemd supports masking an inherited drop-in with /dev/null.
        if (stat.isSymbolicLink() && fs.readlinkSync(override) === '/dev/null') continue;
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536)
          throw new Error('Refusing an unrecognized ReMCP systemd override');
        const fd = fs.openSync(override,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
        try {
          const opened = fs.fstatSync(fd);
          if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino ||
              opened.nlink !== 1 || opened.size > 65536)
            throw new Error('Refusing a changed ReMCP systemd override');
          const body=Buffer.alloc(opened.size);
          const bytes=fs.readSync(fd,body,0,body.length,0);
          const after=fs.fstatSync(fd),named=fs.lstatSync(override);
          if (bytes !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
              named.dev !== opened.dev || named.ino !== opened.ino)
            throw new Error('Refusing a changed ReMCP systemd override');
          for (const raw of body.toString('utf8').split(/\r?\n/)) {
            const line=raw.trim();
            if (!line || line.startsWith('#') || line.startsWith(';')) continue;
            if (/^Exec[A-Za-z]*\s*=/.test(line) || /^\.include(?:\s|$)/.test(line) || line.endsWith('\\'))
              throw new Error('Refusing executable or ambiguous ReMCP systemd override');
          }
        } finally { fs.closeSync(fd); }
      }
    }
  }
}

// Discover BOTH supervisors before uninstalling either. A PID-1 migration may
// leave a disabled historical user unit behind; removing only the active scope
// makes status incorrectly report an installed service after uninstall.
// Pin every Linux path component, then validate the opened unit descriptor.
// A check-before-open lstat or a symlinked parent could redirect a later read.
function readOwnedLinuxUnit(file, launcher, expected = null, transform = null, legacyLauncher = null) {
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
    fd = fs.openSync(source, (transform ? fs.constants.O_RDWR : fs.constants.O_RDONLY) |
      (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(fd);
    const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
    const limit = 64 * 1024;
    if (!opened.isFile() || opened.nlink !== 1 || (process.getuid && opened.uid !== process.getuid()) || opened.size > limit ||
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
        !(isManagedLinuxSystemUnit(body, launcher) || (legacyLauncher && isManagedLinuxSystemUnit(body, legacyLauncher)))) {
      throw new Error('Unrecognized or changed ReMCP systemd unit: ' + file);
    }
    const replacement = transform ? transform(body) : body;
    if (replacement !== body) {
      const data = Buffer.from(replacement, 'utf8');
      if (data.length > limit || !isManagedLinuxSystemUnit(replacement, launcher))
        throw new Error('Refusing invalid replacement ReMCP systemd unit');
      let offset = 0;
      while (offset < data.length) {
        const written = fs.writeSync(fd, data, offset, data.length - offset, offset);
        if (!written) throw new Error('Could not finish rewriting the systemd unit');
        offset += written;
      }
      fs.ftruncateSync(fd, data.length);
      fs.fsyncSync(fd);
    }
    return { dev: opened.dev, ino: opened.ino, changed:replacement !== body };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    for (const parent of pinnedDirs.reverse()) fs.closeSync(parent);
  }
}


// A missing unit is distinct from an unknown, symlinked or foreign unit.
export function assertOwnedLinuxUnit(file, launcher = linuxServiceLauncherFile, legacyLauncher = null) {
  try { fs.lstatSync(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  return readOwnedLinuxUnit(file, launcher, null, null, legacyLauncher);
}

export function linuxUserAgentOwned() {
  try { return Boolean(assertOwnedLinuxUnit(linuxServiceFile)); }
  catch { return false; }
}

// Existing files are checked and rewritten through the same pinned descriptor.
// Fresh creation is exclusive, never through a symlink or a redirected parent.
export function writeOwnedLinuxUnit(file, text, launcher = linuxServiceLauncherFile) {
  if (!isManagedLinuxSystemUnit(text, launcher)) throw new Error('Invalid ReMCP systemd unit');
  const existing = assertOwnedLinuxUnit(file, launcher);
  if (existing) return readOwnedLinuxUnit(file, launcher, existing, () => text);
  const dirs = [];
  try {
    let source = file;
    if (process.platform === 'linux') {
      const parts = path.resolve(file).split(path.sep).filter(Boolean);
      const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
      let parent = fs.openSync(path.parse(file).root, flags);
      dirs.push(parent);
      for (const part of parts.slice(0,-1)) {
        const next = '/proc/self/fd/' + parent + '/' + part;
        try { parent = fs.openSync(next, flags); }
        catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          try { fs.mkdirSync(next, {mode:0o755}); }
          catch (mkdirError) { if (mkdirError?.code !== 'EEXIST') throw mkdirError; }
          parent = fs.openSync(next, flags);
        }
        dirs.push(parent);
      }
      source = '/proc/self/fd/' + parent + '/' + parts.at(-1);
    } else fs.mkdirSync(path.dirname(file), {recursive:true});
    const fd = fs.openSync(source, fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o644);
    try { fs.writeFileSync(fd,text); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } finally { for (const dir of dirs.reverse()) fs.closeSync(dir); }
}

export function recordedLegacyLinuxLauncher(config) {
  const cli = config?.serviceCliPath;
  return config?.serviceInstalled === true && typeof cli === 'string' && path.isAbsolute(cli) &&
    path.normalize(cli) === cli && /\/bin\/remcp(?:\.mjs)?$/.test(cli) ? cli : null;
}

export function repairOwnedLinuxUnit(file, transform, legacyLauncher = null) {
  const existing = assertOwnedLinuxUnit(file, linuxServiceLauncherFile, legacyLauncher);
  if (!existing) return null;
  return readOwnedLinuxUnit(file, linuxServiceLauncherFile, existing, transform, legacyLauncher);
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
  for (const {scope,file} of units) assertNoLinuxExecDropIns(file,scope,{runner});
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
    // systemctl uses LSB status 3 for a unit that is not active.
    // Unknown unit, transport failure, timeout and signal termination
    // are not positive evidence that the managed service stopped.
    if (active.status !== 3 || active.error || active.signal) {
      throw new Error('Could not confirm ReMCP ' + scope + ' systemd service is inactive; refusing uninstall');
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
