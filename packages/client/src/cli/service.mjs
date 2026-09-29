// Installing, repairing and removing the background agent: one supervisor per platform, plus the
// write-access tweaks a fresh install needs. Nothing here is reachable from a model or an MCP tool.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { resolveNpm } from '../npm.mjs';
import { PACKAGE_NAME, VERSION } from '../version.mjs';

import { saveConfig } from './config.mjs';
import { configDir, home, linuxServiceFile, linuxServiceLauncherFile, macLogFile, macServiceFile, macServiceLabel, npm, windowsServiceLauncherFile, windowsTaskName } from './env.mjs';
import { output, run } from './shell.mjs';

export function servicePlatform() {
  return process.env.NODE_ENV === 'test' && process.env.REMCP_TEST_PLATFORM ? process.env.REMCP_TEST_PLATFORM : process.platform;
}

export function globalPrefix() {
  return output(npm.command, [...npm.args, 'prefix', '--global']);
}

export function globalCliPath() {
  const prefix = globalPrefix();
  return servicePlatform() === 'win32' ? path.join(prefix, 'remcp.cmd') : path.join(prefix, 'bin', 'remcp');
}

function npmGlobalInstallArgs(specs, { preferOnline = false } = {}) {
  return [
    'install',
    '--global',
    ...specs,
    ...(preferOnline ? ['--prefer-online'] : []),
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    '--loglevel=error',
  ];
}

export function npmGlobalInstall(...specs) {
  run(npm.command, [...npm.args, ...npmGlobalInstallArgs(specs)]);
}

function pathEntryExists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function globalPackagePath(prefix, packageName, platform = servicePlatform()) {
  const name = String(packageName || '').trim();
  const parts = name.split('/');
  const validUnscoped = parts.length === 1 && parts[0] && !parts[0].startsWith('@') && parts[0] !== '.' && parts[0] !== '..';
  const validScoped = parts.length === 2 && /^@[^/]+$/.test(parts[0]) && parts[1] && parts[1] !== '.' && parts[1] !== '..';
  if (!validUnscoped && !validScoped) throw new Error(`Invalid npm package name for update: ${name || '(empty)'}`);
  const modulesRoot = platform === 'win32'
    ? path.join(prefix, 'node_modules')
    : path.join(prefix, 'lib', 'node_modules');
  return path.join(modulesRoot, ...parts);
}

function managedWindowsRuntimePrefix() {
  return path.resolve(
    process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
    'ReMCP',
    'runtime',
  );
}

function isManagedWindowsRuntimePrefix(prefix) {
  const actual = path.resolve(String(prefix || ''));
  const expected = managedWindowsRuntimePrefix();
  return actual.toLowerCase() === expected.toLowerCase();
}

function transactionalMacGlobalInstall({ resolved, prefix, packageNames, specs, preferOnline = false }) {
  prefix = String(prefix || '').trim();
  if (!path.isAbsolute(prefix)) throw new Error(`npm global prefix must be absolute for a macOS update: ${prefix || '(empty)'}`);
  const backupRoot = path.join(prefix, `.remcp-update-backup-${process.pid}-${Date.now()}`);
  const moved = [];
  const moveAside = (source, label) => {
    if (!pathEntryExists(source)) return;
    const backup = path.join(backupRoot, label);
    fs.renameSync(source, backup);
    moved.push({ source, backup });
  };
  const restore = originalError => {
    let rollbackError = null;
    for (const item of [...moved].reverse()) {
      try {
        if (pathEntryExists(item.source)) fs.rmSync(item.source, { recursive:true, force:true });
        fs.mkdirSync(path.dirname(item.source), { recursive:true });
        fs.renameSync(item.backup, item.source);
      } catch (error) {
        rollbackError ??= error;
      }
    }
    try { fs.rmSync(backupRoot, { recursive:true, force:true }); } catch (error) { rollbackError ??= error; }
    if (rollbackError) {
      throw new Error(
        `ReMCP update failed and the previous macOS installation could not be fully restored: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause:originalError },
      );
    }
  };

  fs.mkdirSync(prefix, { recursive:true });
  fs.mkdirSync(backupRoot, { recursive:false, mode:0o700 });
  try {
    const uniqueNames = [...new Set(packageNames.map(name => String(name || '').trim()).filter(Boolean))];
    uniqueNames.forEach((name, index) => moveAside(globalPackagePath(prefix, name), `package-${index}`));
    if (uniqueNames.includes(PACKAGE_NAME)) moveAside(path.join(prefix, 'bin', 'remcp'), 'bin-remcp');

    run(resolved.command, [...resolved.args, ...npmGlobalInstallArgs(specs, { preferOnline })]);
  } catch (error) {
    restore(error);
    throw error;
  }

  try {
    fs.rmSync(backupRoot, { recursive:true, force:true });
  } catch (error) {
    console.error(`ReMCP update: could not remove macOS rollback backup ${backupRoot}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function transactionalWindowsGlobalInstall({ resolved, prefix, packageNames, specs, preferOnline = false }) {
  prefix = String(prefix || '').trim();
  if (!path.isAbsolute(prefix)) throw new Error(`npm global prefix must be absolute for a Windows update: ${prefix || '(empty)'}`);
  if (!isManagedWindowsRuntimePrefix(prefix)) {
    run(resolved.command, [...resolved.args, ...npmGlobalInstallArgs(specs, { preferOnline })]);
    return;
  }

  const backupRoot = path.join(prefix, `.remcp-update-backup-${process.pid}-${Date.now()}`);
  const moved = [];
  const moveAside = (source, label) => {
    if (!pathEntryExists(source)) return;
    const backup = path.join(backupRoot, label);
    fs.renameSync(source, backup);
    moved.push({ source, backup });
  };
  const restore = originalError => {
    let rollbackError = null;
    for (const item of [...moved].reverse()) {
      try {
        if (pathEntryExists(item.source)) fs.rmSync(item.source, { recursive:true, force:true });
        fs.mkdirSync(path.dirname(item.source), { recursive:true });
        fs.renameSync(item.backup, item.source);
      } catch (error) {
        rollbackError ??= error;
      }
    }
    try { fs.rmSync(backupRoot, { recursive:true, force:true }); } catch (error) { rollbackError ??= error; }
    if (rollbackError) {
      throw new Error(
        `ReMCP update failed and the previous Windows installation could not be fully restored: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause:originalError },
      );
    }
  };

  fs.mkdirSync(prefix, { recursive:true });
  fs.mkdirSync(backupRoot, { recursive:false, mode:0o700 });
  try {
    const uniqueNames = [...new Set(packageNames.map(name => String(name || '').trim()).filter(Boolean))];
    uniqueNames.forEach((name, index) => moveAside(globalPackagePath(prefix, name, 'win32'), `package-${index}`));
    if (uniqueNames.includes(PACKAGE_NAME)) {
      for (const shim of ['remcp', 'remcp.cmd', 'remcp.ps1']) moveAside(path.join(prefix, shim), `bin-${shim}`);
    }
    run(resolved.command, [...resolved.args, ...npmGlobalInstallArgs(specs, { preferOnline })]);
  } catch (error) {
    restore(error);
    throw error;
  }

  try {
    fs.rmSync(backupRoot, { recursive:true, force:true });
  } catch (error) {
    console.error(`ReMCP update: could not remove Windows rollback backup ${backupRoot}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Release updates use exact versions that may have been published only moments ago. npm can keep a
// cached pre-publication packument long enough to answer ETARGET after the registry already serves the
// version, so updates revalidate metadata while retaining npm's cache for package bytes.
export function npmGlobalUpdate(packageNames, ...specs) {
  const platform = servicePlatform();
  const prefix = globalPrefix();
  if (platform === 'darwin') {
    transactionalMacGlobalInstall({ resolved:npm, prefix, packageNames, specs, preferOnline:true });
    return;
  }
  if (platform === 'win32') {
    transactionalWindowsGlobalInstall({ resolved:npm, prefix, packageNames, specs, preferOnline:true });
    return;
  }
  run(npm.command, [...npm.args, ...npmGlobalInstallArgs(specs, { preferOnline:true })]);
}

export function npmGlobalUpdateForNode(nodePath, packageNames, ...specs) {
  const platform = servicePlatform();
  const resolved = resolveNpm({ nodePath, home, platform });
  const prefix = output(resolved.command, [...resolved.args, 'prefix', '--global']);
  if (platform === 'darwin') {
    transactionalMacGlobalInstall({ resolved, prefix, packageNames, specs, preferOnline:true });
    return;
  }
  if (platform === 'win32') {
    transactionalWindowsGlobalInstall({ resolved, prefix, packageNames, specs, preferOnline:true });
    return;
  }
  run(resolved.command, [...resolved.args, ...npmGlobalInstallArgs(specs, { preferOnline:true })]);
}

export function quoteSystemd(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function resolvedCliScript(cliPath) {
  return fs.existsSync(cliPath) ? fs.realpathSync(cliPath) : path.resolve(cliPath);
}

function writeLinuxServiceLauncher(cliPath = globalCliPath(), nodePath = process.execPath) {
  const cliScript = resolvedCliScript(cliPath);
  const launcher = `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(cliScript)} \"$@\"\n`;
  fs.mkdirSync(path.dirname(linuxServiceLauncherFile), { recursive: true, mode: 0o700 });
  const temporary = `${linuxServiceLauncherFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, launcher, { mode: 0o700 });
  fs.chmodSync(temporary, 0o700);
  fs.renameSync(temporary, linuxServiceLauncherFile);
  return linuxServiceLauncherFile;
}

export function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function installLinuxService(cliPath = globalCliPath(), nodePath = process.execPath) {
  const launcherFile = writeLinuxServiceLauncher(cliPath, nodePath);
  const unit = `[Unit]\nDescription=ReMCP device agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${quoteSystemd(launcherFile)} start --service\nRestart=always\nRestartSec=3\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`;
  fs.mkdirSync(path.dirname(linuxServiceFile), { recursive: true });
  fs.writeFileSync(linuxServiceFile, unit);
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', 'remcp-agent.service']);
}

export function macLaunchDomain() {
  if (typeof process.getuid !== 'function') throw new Error('Could not determine the current macOS user');
  return `gui/${process.getuid()}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

const remcpPathBlockStart = '# >>> ReMCP CLI PATH >>>';
const remcpPathBlockEnd = '# <<< ReMCP CLI PATH <<<';
const remcpCliShimMarker = '# ReMCP managed CLI shim';

function macCliShimPath() {
  return path.join(home, '.local', 'bin', 'remcp');
}

function interactiveShellProfile() {
  const shell = String(process.env.REMCP_TEST_SHELL || process.env.SHELL || os.userInfo().shell || '/bin/zsh');
  const name = path.basename(shell);
  if (name === 'zsh') return path.join(home, '.zshrc');
  if (name === 'bash') return path.join(home, '.bash_profile');
  return '';
}

function upsertManagedPathBlock(file) {
  if (!file) return false;
  const block = [
    remcpPathBlockStart,
    'case ":$PATH:" in',
    '  *":$HOME/.local/bin:"*) ;;',
    '  *) export PATH="$HOME/.local/bin:$PATH" ;;',
    'esac',
    remcpPathBlockEnd,
  ].join('\n');
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); } catch {}
  const start = current.indexOf(remcpPathBlockStart);
  const end = start >= 0 ? current.indexOf(remcpPathBlockEnd, start + remcpPathBlockStart.length) : -1;
  let next;
  if (start >= 0 && end >= 0) {
    next = current.slice(0, start) + block + current.slice(end + remcpPathBlockEnd.length);
  } else {
    const prefix = current && !current.endsWith('\n') ? current + '\n' : current;
    next = prefix + (prefix ? '\n' : '') + block + '\n';
  }
  if (next === current) return false;
  fs.writeFileSync(file, next, { mode:0o600 });
  return true;
}

function removeManagedPathBlock(file) {
  if (!file) return;
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); } catch { return; }
  const start = current.indexOf(remcpPathBlockStart);
  const end = start >= 0 ? current.indexOf(remcpPathBlockEnd, start + remcpPathBlockStart.length) : -1;
  if (start < 0 || end < 0) return;
  let before = current.slice(0, start);
  let after = current.slice(end + remcpPathBlockEnd.length);
  if (before.endsWith('\n') && after.startsWith('\n')) after = after.slice(1);
  const next = before + after;
  fs.writeFileSync(file, next, { mode:0o600 });
}

export function ensureMacCliCommand(config = {}, { cliPath = '', nodePath = '' } = {}) {
  if (servicePlatform() !== 'darwin') return null;
  const effectiveCli = cliPath || (persistentServiceExpected(config) ? canonicalServiceCliPath(config) : globalCliPath());
  const effectiveNode = nodePath || (persistentServiceExpected(config) ? canonicalServiceNodePath(config) : process.execPath);
  const cliScript = resolvedCliScript(effectiveCli);
  const shim = macCliShimPath();
  try {
    const existing = fs.readFileSync(shim, 'utf8');
    if (!existing.includes(remcpCliShimMarker)) {
      console.error(`ReMCP did not replace ${shim} because it is not a ReMCP-managed command.`);
      return null;
    }
  } catch (error) {
    if (error?.code && error.code !== 'ENOENT') {
      console.error(`ReMCP could not inspect ${shim}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
  const launcher = `#!/bin/sh\n${remcpCliShimMarker}\nexec ${shellQuote(effectiveNode)} ${shellQuote(cliScript)} "$@"\n`;
  fs.mkdirSync(path.dirname(shim), { recursive:true, mode:0o755 });
  const temporary = `${shim}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, launcher, { mode:0o755 });
  fs.chmodSync(temporary, 0o755);
  fs.renameSync(temporary, shim);
  upsertManagedPathBlock(interactiveShellProfile());
  return shim;
}

function removeMacCliCommand() {
  if (servicePlatform() !== 'darwin') return;
  const shim = macCliShimPath();
  try {
    const existing = fs.readFileSync(shim, 'utf8');
    if (existing.includes(remcpCliShimMarker)) fs.unlinkSync(shim);
  } catch {}
  removeManagedPathBlock(interactiveShellProfile());
}

function macServicePlist(cliPath, nodePath = process.execPath) {
  // launchd wants an absolute path; a symlinked prefix that npm has not materialised yet (or a path
  // that is about to be replaced by the next install) must not abort the repair — a stale plist is
  // exactly the loop this function exists to break.
  const cliScript = fs.existsSync(cliPath) ? fs.realpathSync(cliPath) : path.resolve(cliPath);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${macServiceLabel}</string>\n<key>ProgramArguments</key><array><string>${xmlEscape(nodePath)}</string><string>${xmlEscape(cliScript)}</string><string>start</string><string>--service</string></array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>ProcessType</key><string>Background</string>\n<key>StandardOutPath</key><string>${xmlEscape(macLogFile)}</string>\n<key>StandardErrorPath</key><string>${xmlEscape(macLogFile)}</string>\n</dict></plist>\n`;
}

function macJobLoaded(target) {
  return spawnSync('launchctl', ['print', target], { stdio: 'ignore' }).status === 0;
}

function submitMacHelper(kind, lines) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const nonce = `${process.pid}.${Date.now()}`;
  const helperFile = path.join(configDir, `launchd-${kind}-${nonce}.sh`);
  const helperLabel = `${macServiceLabel}.${kind}.${nonce}`;
  const script = [
    '#!/bin/sh',
    'sleep 1',
    'status=0',
    ...lines.map(line => `${line} || status=$?`),
    `if [ "$status" -ne 0 ]; then echo "ReMCP launchd ${kind} helper failed with status $status" >> ${shellQuote(macLogFile)}; fi`,
    `rm -f ${shellQuote(helperFile)}`,
    `launchctl remove ${shellQuote(helperLabel)} >/dev/null 2>&1 || true`,
    'exit 0',
    '',
  ].join('\n');
  fs.writeFileSync(helperFile, script, { mode: 0o700 });
  fs.chmodSync(helperFile, 0o700);
  run('launchctl', ['submit', '-l', helperLabel, '--', '/bin/sh', helperFile]);
  return helperLabel;
}

function scheduleMacServiceReload(domain, target) {
  return submitMacHelper('reload', [
    `launchctl bootout ${shellQuote(target)} >/dev/null 2>&1 || true`,
    `launchctl bootstrap ${shellQuote(domain)} ${shellQuote(macServiceFile)}`,
    `launchctl enable ${shellQuote(target)}`,
    `launchctl kickstart -k ${shellQuote(target)}`,
  ]);
}

function scheduleMacServiceRestart(target) {
  return submitMacHelper('restart', [
    `launchctl kickstart -k ${shellQuote(target)}`,
  ]);
}

export function installMacService(cliPath = globalCliPath(), { restart = true, nodePath = process.execPath } = {}) {
  const domain = macLaunchDomain();
  const target = `${domain}/${macServiceLabel}`;
  const plist = macServicePlist(cliPath, nodePath);
  let previous = '';
  try { previous = fs.readFileSync(macServiceFile, 'utf8'); } catch {}
  const loaded = macJobLoaded(target);

  fs.mkdirSync(path.dirname(macServiceFile), { recursive: true });
  fs.mkdirSync(path.dirname(macLogFile), { recursive: true });
  fs.writeFileSync(macServiceFile, plist, { mode: 0o600 });

  if (loaded && previous === plist) {
    run('launchctl', ['enable', target]);
    // Never boot out a healthy loaded job just to refresh an in-place npm install. The final
    // kickstart keeps launchd responsible for bringing the replacement agent back.
    if (restart) run('launchctl', ['kickstart', '-k', target]);
    return 'loaded';
  }

  if (loaded) {
    // A changed Node/npm prefix requires launchd to re-read ProgramArguments. A separate transient
    // launchd job survives booting out com.remcp.agent even when the updater was launched by it.
    scheduleMacServiceReload(domain, target);
    return 'reload-scheduled';
  }

  run('launchctl', ['bootstrap', domain, macServiceFile]);
  run('launchctl', ['enable', target]);
  if (restart) run('launchctl', ['kickstart', '-k', target]);
  return 'bootstrapped';
}

function windowsBatchValue(value) {
  return String(value).replaceAll('%', '%%');
}

export function writeWindowsServiceLauncher(cliPath = globalCliPath(), nodePath = process.execPath) {
  const prefix = path.dirname(cliPath);
  const nodeDir = path.dirname(nodePath);
  const launcher = [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `set "NPM_CONFIG_PREFIX=${windowsBatchValue(prefix)}"`,
    `set "PATH=${windowsBatchValue(nodeDir)};%PATH%"`,
    `call "${windowsBatchValue(cliPath)}" start --service`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
  fs.mkdirSync(configDir, { recursive:true, mode:0o700 });
  const temporary = `${windowsServiceLauncherFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, launcher, { mode:0o700 });
  fs.renameSync(temporary, windowsServiceLauncherFile);
  return windowsServiceLauncherFile;
}

export function installWindowsService(cliPath = globalCliPath(), { nodePath = process.execPath } = {}) {
  const launcherFile = writeWindowsServiceLauncher(cliPath, nodePath);
  const command = `"${launcherFile}"`;
  // Computer-use needs the signed-in interactive desktop. Create the task with /IT from the start
  // instead of changing it afterwards: schtasks /Change can request the account password even when
  // the task already belongs to the current user, which turns a one-command install into a prompt.
  run('schtasks.exe', ['/Create', '/TN', windowsTaskName, '/TR', command, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/IT', '/F']);
  run('schtasks.exe', ['/Run', '/TN', windowsTaskName]);
}

// `serviceInstalled` was added after background services already existed in the wild. Treat an
// explicit false as the user's opt-out, an explicit true as the current marker, and only infer the
// old intent from an OS service artifact when the marker is absent. This keeps legacy installs
// repairable without resurrecting a service that a newer client explicitly disabled.
export function persistentServiceExpected(config) {
  if (config?.serviceInstalled === false) return false;
  if (config?.serviceInstalled === true) return true;
  const platform = servicePlatform();
  if (platform === 'linux') return fs.existsSync(linuxServiceFile);
  if (platform === 'darwin') return fs.existsSync(macServiceFile);
  if (platform === 'win32') {
    return spawnSync('schtasks.exe', ['/Query', '/TN', windowsTaskName], { stdio: 'ignore' }).status === 0;
  }
  return false;
}

export function persistentServiceState(config) {
  const platform = servicePlatform();
  const expected = persistentServiceExpected(config);
  if (platform === 'linux') {
    const installed = fs.existsSync(linuxServiceFile);
    const active = installed && spawnSync('systemctl', ['--user', 'is-active', '--quiet', 'remcp-agent.service'], { stdio: 'ignore' }).status === 0;
    return { expected, installed, active, manager:'systemd-user', name:'remcp-agent.service' };
  }
  if (platform === 'darwin') {
    const installed = fs.existsSync(macServiceFile);
    const target = typeof process.getuid === 'function' ? 'gui/' + process.getuid() + '/' + macServiceLabel : macServiceLabel;
    const active = installed && spawnSync('launchctl', ['print', target], { stdio: 'ignore' }).status === 0;
    return { expected, installed, active, manager:'launchd', name:macServiceLabel };
  }
  if (platform === 'win32') {
    const query = spawnSync('schtasks.exe', ['/Query', '/TN', windowsTaskName, '/FO', 'LIST'], { encoding:'utf8' });
    const installed = query.status === 0;
    const outputText = String(query.stdout || '');
    const active = installed && /(?:Status|Состояние):\s*Running/i.test(outputText);
    return { expected, installed, active, manager:'schtasks', name:windowsTaskName };
  }
  return { expected:false, installed:false, active:false, manager:null, name:null };
}

function inferServiceIdentity() {
  const platform = servicePlatform();
  if (platform === 'linux' && fs.existsSync(linuxServiceLauncherFile)) {
    try {
      const body = fs.readFileSync(linuxServiceLauncherFile, 'utf8');
      const match = body.match(/^exec\s+'([^']+)'\s+'([^']+)'/m);
      if (match) return { nodePath:match[1], cliPath:match[2] };
    } catch {}
  }
  if (platform === 'darwin' && fs.existsSync(macServiceFile)) {
    try {
      const body = fs.readFileSync(macServiceFile, 'utf8');
      const args = [...body.matchAll(/<string>([^<]+)<\/string>/g)].map(match => match[1]);
      const startIndex = args.indexOf('start');
      if (startIndex >= 2) return { nodePath:args[startIndex - 2], cliPath:args[startIndex - 1] };
    } catch {}
  }
  return {};
}

function canonicalServiceCliPath(config) {
  const configured = String(config?.serviceCliPath || '').trim();
  if (configured && fs.existsSync(configured)) return configured;
  const inferred = inferServiceIdentity().cliPath;
  if (inferred && fs.existsSync(inferred)) return inferred;
  return globalCliPath();
}

function canonicalServiceNodePath(config) {
  const configured = String(config?.serviceNodePath || '').trim();
  if (configured && fs.existsSync(configured)) return configured;
  const inferred = inferServiceIdentity().nodePath;
  if (inferred && fs.existsSync(inferred)) return inferred;
  return process.execPath;
}

function versionFromPackageJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

function packageVersionBesideCli(cliPath, packageName) {
  if (!cliPath || !packageName) return null;
  const marker = path.sep + 'node_modules' + path.sep;
  const index = cliPath.lastIndexOf(marker);
  if (index < 0) return null;
  const nodeModules = cliPath.slice(0, index + (path.sep + 'node_modules').length);
  return versionFromPackageJson(path.join(nodeModules, ...String(packageName).split('/'), 'package.json'));
}

function packageVersionForCli(cliPath, packageName) {
  const beside = packageVersionBesideCli(cliPath, packageName);
  if (beside || servicePlatform() !== 'win32' || !cliPath || !packageName) return beside;
  // npm's Windows global executable is a .cmd shim in the prefix root, not a symlink into
  // node_modules. realpath() therefore cannot reveal the package directory like it does on Unix.
  // Resolve the package from the same prefix layout npm uses on Windows.
  if (path.basename(cliPath).toLowerCase() !== 'remcp.cmd') return null;
  const prefix = path.dirname(cliPath);
  return versionFromPackageJson(path.join(prefix, 'node_modules', ...String(packageName).split('/'), 'package.json'));
}

export function installationVersionsAtCliPath(cliPath, runtimePackageName) {
  if (!cliPath) return { cliVersion:null, runtimeVersion:null, cliPath:null };
  let resolvedCliPath = cliPath;
  try { if (fs.existsSync(cliPath)) resolvedCliPath = fs.realpathSync(cliPath); } catch {}
  return {
    cliVersion:packageVersionForCli(resolvedCliPath, PACKAGE_NAME),
    runtimeVersion:packageVersionForCli(resolvedCliPath, runtimePackageName),
    cliPath:resolvedCliPath,
  };
}

export function serviceInstallationInfo(config) {
  if (!persistentServiceExpected(config)) return { cliVersion:null, runtimeVersion:null, cliPath:null, nodePath:null };
  const cliPath = canonicalServiceCliPath(config);
  const nodePath = canonicalServiceNodePath(config);
  let resolvedCliPath = cliPath;
  try { if (cliPath && fs.existsSync(cliPath)) resolvedCliPath = fs.realpathSync(cliPath); } catch {}
  return {
    cliVersion:packageVersionForCli(resolvedCliPath, PACKAGE_NAME),
    runtimeVersion:packageVersionForCli(resolvedCliPath, config?.runtime?.packageName),
    cliPath:resolvedCliPath || cliPath,
    nodePath,
  };
}

export function currentInstallationInfo(config) {
  let cliPath = process.argv[1] || '';
  try { if (cliPath && fs.existsSync(cliPath)) cliPath = fs.realpathSync(cliPath); } catch {}
  return {
    cliVersion:VERSION,
    runtimeVersion:config?.runtime?.packageName ? packageVersionForCli(cliPath, config.runtime.packageName) : null,
    cliPath:cliPath || null,
    nodePath:process.execPath,
  };
}

export function rememberCurrentInstallation(config, { service = false } = {}) {
  if (!config || typeof config !== 'object') return config;
  const info = currentInstallationInfo(config);
  if (!info.cliPath || !info.nodePath) return config;
  const key = info.nodePath + '\u0000' + info.cliPath;
  const existing = Array.isArray(config.installations) ? config.installations.filter(item => item && typeof item === 'object') : [];
  const filtered = existing.filter(item => ((item.nodePath || '') + '\u0000' + (item.cliPath || '')) !== key);
  const record = {
    nodePath:info.nodePath,
    cliPath:info.cliPath,
    cliVersion:info.cliVersion,
    runtimeVersion:info.runtimeVersion,
    service:Boolean(service),
    lastSeenAt:new Date().toISOString(),
  };
  const installations = [...filtered, record].slice(-8);
  const next = {
    ...config,
    installations,
    ...(service ? { serviceInstalled:true, serviceCliPath:info.cliPath, serviceNodePath:info.nodePath } : {}),
  };
  saveConfig(next);
  return next;
}

export function syncKnownInstallations(config, ...specs) {
  const serviceInfo = serviceInstallationInfo(config);
  const current = currentInstallationInfo(config);
  const candidates = [
    ...(Array.isArray(config?.installations) ? config.installations : []),
    ...(serviceInfo.nodePath ? [{ nodePath:serviceInfo.nodePath, cliPath:serviceInfo.cliPath, service:true }] : []),
  ];
  const currentNode = (() => { try { return fs.realpathSync(current.nodePath); } catch { return current.nodePath; } })();
  const seen = new Set();
  const results = [];
  for (const candidate of candidates) {
    const nodePath = String(candidate?.nodePath || '').trim();
    if (!nodePath || !fs.existsSync(nodePath)) continue;
    let resolvedNode = nodePath;
    try { resolvedNode = fs.realpathSync(nodePath); } catch {}
    if (resolvedNode === currentNode || seen.has(resolvedNode)) continue;
    seen.add(resolvedNode);
    const required = Boolean(candidate?.service) || resolvedNode === serviceInfo.nodePath;
    try {
      npmGlobalUpdateForNode(resolvedNode, [PACKAGE_NAME, config.runtime.packageName], ...specs);
      results.push({ nodePath:resolvedNode, ok:true, required });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ nodePath:resolvedNode, ok:false, required, error:message });
      if (required) throw new Error('Could not update canonical ReMCP service installation at ' + resolvedNode + ': ' + message);
    }
  }
  return results;
}

export function configurePostInstallAccess() {
  const platform = servicePlatform();
  try {
    if (platform === 'darwin') configureMacWriteAccess();
    else if (platform === 'win32') configureWindowsWriteAccess();
    else configureLinuxWriteAccess();
  } catch (error) {
    console.error(`Could not configure write access: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function configureMacWriteAccess() {
  const appName = path.basename(process.execPath);
  const terminalApp = path.basename(process.env.SHELL || '/bin/zsh');
  const workspaceDir = path.join(home, 'Library', 'Application Support', 'ReMCP');
  try { fs.mkdirSync(workspaceDir, { recursive: true }); } catch {}
  try { run('chmod', ['-R', '755', workspaceDir]); } catch {}
  try {
    const script = `tell application "System Preferences" to activate\ndelay 1\ntell application "System Events" to click UI element "Privacy" of toolbar 1 of window "Security & Privacy" of process "System Preferences"\ndelay 1\ntell application "System Events" to click row 4 of table 1 of scroll area 1 of window "Privacy" of application process "System Preferences"\ndelay 1\n`;
    spawnSync('osascript', ['-e', script], { stdio: 'ignore' });
  } catch {}
  console.log('Note: For full Desktop/Documents access on macOS, go to System Settings → Privacy & Security → Full Disk Access and add ReMCP or your Terminal app.');
}

export function configureWindowsWriteAccess() {
  // installWindowsService already creates the task as HighestAvailable + InteractiveToken. Keep
  // post-install access setup non-interactive so a fresh install never asks for the Windows password.
  try {
    const workspaceDir = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ReMCP');
    fs.mkdirSync(workspaceDir, { recursive: true });
  } catch {}
  console.log('ReMCP configured with the highest available user privileges for interactive desktop access.');
}

export function configureLinuxWriteAccess() {
  const dirs = [path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads')];
  for (const dir of dirs) {
    try {
      if (fs.existsSync(dir)) run('chown', [`${os.userInfo().username}:${os.userInfo().gid}`, dir]);
    } catch {}
  }
  try {
    const workspaceDir = path.join(home, '.local', 'share', 'ReMCP');
    fs.mkdirSync(workspaceDir, { recursive: true });
  } catch {}
}

export function installPersistentAgent(config) {
  const platform = servicePlatform();
  if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error(`Automatic background service installation is not supported on ${platform}`);
  console.log(`Installing ReMCP ${VERSION}…`);
  npmGlobalInstall(`${PACKAGE_NAME}@${VERSION}`, config.runtime.packageSpec);
  const cliPath = globalCliPath();
  const cliScript = resolvedCliScript(cliPath);
  const nodePath = process.execPath;
  if (platform === 'linux') installLinuxService(cliPath, nodePath);
  else if (platform === 'darwin') {
    installMacService(cliPath, { nodePath });
    ensureMacCliCommand(config, { cliPath:cliScript, nodePath });
  } else installWindowsService(cliPath, { nodePath });
  configurePostInstallAccess();
  saveConfig({ ...config, serviceInstalled: true, serviceCliPath: cliScript, serviceNodePath: nodePath });
  console.log('ReMCP is installed as a background service. Future updates: remcp update');
}

// A machine that was installed as a service must still be one after an update: if the job is missing
// (a failed install, a cleaned LaunchAgents directory, a re-imaged user), the next update recreates
// it instead of leaving a hand-over to a process nobody supervises.
export function ensureServiceIfRecorded(config) {
  if (!persistentServiceExpected(config)) return null;
  try {
    const cliPath = canonicalServiceCliPath(config);
    const nodePath = canonicalServiceNodePath(config);
    const platform = servicePlatform();
    let restartScheduled = null;
    if (platform === 'linux') {
      // Read and repair the unit through one descriptor. This avoids a check/read/write race where
      // the path could be replaced between validation and mutation.
      let fd = null;
      try {
        fd = fs.openSync(linuxServiceFile, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (fd === null) {
        installLinuxService(cliPath, nodePath);
      } else {
        let reinstall = false;
        try {
          const launcherFile = writeLinuxServiceLauncher(cliPath, nodePath);
          const unit = fs.readFileSync(fd, 'utf8');
          const expected = `ExecStart=${quoteSystemd(launcherFile)} start --service`;
          if (!unit.includes(expected)) {
            const repaired = /^ExecStart=/m.test(unit) ? unit.replace(/^ExecStart=.*$/m, expected) : '';
            if (!repaired) {
              reinstall = true;
            } else {
              const data = Buffer.from(repaired, 'utf8');
              fs.ftruncateSync(fd, 0);
              let offset = 0;
              while (offset < data.length) {
                const written = fs.writeSync(fd, data, offset, data.length - offset, offset);
                if (!written) throw new Error('Could not finish rewriting the systemd unit');
                offset += written;
              }
              fs.ftruncateSync(fd, data.length);
              fs.fsyncSync(fd);
              run('systemctl', ['--user', 'daemon-reload']);
            }
          }
        } finally {
          fs.closeSync(fd);
        }
        if (reinstall) installLinuxService(cliPath, nodePath);
      }
    } else if (platform === 'darwin') {
      // launchd bakes the interpreter and CLI path into the plist. Repair the file first, but never
      // boot out a loaded agent inline: this updater may itself be a descendant of that LaunchAgent.
      // installMacService either leaves an unchanged loaded job alone, bootstraps an unloaded job, or
      // hands a changed launcher to an independent transient launchd helper.
      const state = installMacService(cliPath, { restart: false, nodePath });
      ensureMacCliCommand(config, { cliPath, nodePath });
      if (state === 'reload-scheduled') restartScheduled = macServiceLabel;
    } else if (platform === 'win32') installWindowsService(cliPath, { nodePath });
    // Upgrade the legacy inferred state only after the supervisor repair succeeded. A failed repair
    // must not turn a stale artifact into a permanent "managed service" declaration.
    const cliScript = resolvedCliScript(cliPath);
    if (config?.serviceInstalled !== true || config?.serviceCliPath !== cliScript || config?.serviceNodePath !== nodePath) {
      saveConfig({ ...config, serviceInstalled: true, serviceCliPath: cliScript, serviceNodePath: nodePath });
    }
    return restartScheduled;
  } catch (error) {
    console.error(`Could not ensure the background service: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function restartPersistentServiceIfInstalled(config) {
  if (!persistentServiceExpected(config)) return null;
  const platform = servicePlatform();
  if (platform === 'linux' && fs.existsSync(linuxServiceFile)) {
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'restart', 'remcp-agent.service']);
    return 'remcp-agent.service';
  }
  if (platform === 'darwin' && fs.existsSync(macServiceFile)) {
    const target = `${macLaunchDomain()}/${macServiceLabel}`;
    if (macJobLoaded(target)) {
      // Never kill a loaded LaunchAgent inline: the caller may itself be a child of that job.
      // A transient helper survives the handoff and performs the restart after this CLI returns.
      scheduleMacServiceRestart(target);
    } else {
      // A plist can survive while launchd has no loaded job (older installs, logout/login cleanup,
      // manual bootout, or a failed previous update). Re-register it directly.
      installMacService(canonicalServiceCliPath(config), { nodePath:canonicalServiceNodePath(config) });
    }
    return macServiceLabel;
  }
  if (platform === 'win32') {
    const result = spawnSync('schtasks.exe', ['/Query', '/TN', windowsTaskName], { stdio: 'ignore' });
    if (result.status === 0) {
      run('schtasks.exe', ['/Run', '/TN', windowsTaskName]);
      return windowsTaskName;
    }
  }
  return null;
}

export function uninstallPersistentService() {
  const platform = servicePlatform();
  if (platform === 'linux') {
    spawnSync('systemctl', ['--user', 'disable', '--now', 'remcp-agent.service'], { stdio: 'inherit' });
    try { fs.unlinkSync(linuxServiceFile); } catch {}
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  } else if (platform === 'darwin') {
    const domain = macLaunchDomain();
    spawnSync('launchctl', ['bootout', domain, macServiceFile], { stdio: 'ignore' });
    try { fs.unlinkSync(macServiceFile); } catch {}
    removeMacCliCommand();
  } else if (platform === 'win32') {
    spawnSync('schtasks.exe', ['/End', '/TN', windowsTaskName], { stdio: 'ignore' });
    spawnSync('schtasks.exe', ['/Delete', '/TN', windowsTaskName, '/F'], { stdio: 'ignore' });
    try { fs.unlinkSync(windowsServiceLauncherFile); } catch {}
  }
}
