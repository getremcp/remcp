import { servicePlatform, globalPrefix, globalCliPath, npmGlobalInstall, npmGlobalUpdate, npmGlobalUpdateForNode } from './npm-global.mjs';
import { persistentServiceExpected, persistentServiceState, persistentServiceStatus, releasePairPresentAtCli, installationVersionsAtCliPath, serviceInstallationInfo, currentInstallationInfo, rememberCurrentInstallation, syncKnownInstallations, canonicalServiceCliPath, canonicalServiceNodePath } from './service-inventory.mjs';
export { servicePlatform, globalPrefix, globalCliPath, npmGlobalInstall, npmGlobalUpdate, npmGlobalUpdateForNode };
export { persistentServiceExpected, persistentServiceState, persistentServiceStatus, releasePairPresentAtCli, installationVersionsAtCliPath, serviceInstallationInfo, currentInstallationInfo, rememberCurrentInstallation, syncKnownInstallations };
// Installing, repairing and removing the background agent: one supervisor per platform, plus the
// write-access tweaks a fresh install needs. Service maintenance follows local OS permissions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { resolvedCliScript, shellQuote } from './service-paths.mjs';
import { macLaunchDomain, ensureMacCliCommand, installMacService, macJobLoaded, scheduleMacServiceRestart, removeMacCliCommand } from './service-macos.mjs';
export { xmlEscape } from './service-paths.mjs';
export { macLaunchDomain, ensureMacCliCommand, installMacService } from './service-macos.mjs';
import { PACKAGE_NAME, VERSION } from '../version.mjs';

import { saveConfig } from './config.mjs';
import { configDir, home, linuxServiceFile, linuxServiceLauncherFile, macServiceFile, macServiceLabel, windowsServiceLauncherFile, windowsStartupScriptFile, windowsTaskName } from './env.mjs';
import { run } from './shell.mjs';
import { linuxActiveServiceFile, linuxServiceScope, linuxSystemAgentOwned, linuxSystemServiceFile, ensureLinuxLinger, ensureLinuxCliCommand, uninstallOwnedLinuxUnits } from './service-linux.mjs';
import { windowsServiceLauncherText, windowsTaskAbsenceCommand, windowsStartupScriptText, windowsStartupScriptInstalled } from './windows-supervisor.mjs';
import { ensureWindowsSupervisorKey, windowsSupervisorCommand } from './windows-user-supervisor.mjs';

export function quoteSystemd(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

// A systemd user's PATH may resolve system npm even when the CLI lives under nvm.
// Pin the npm installation target to the CLI's own existing global prefix.
export function linuxServiceLauncherText(cliPath, nodePath) {
  if (!path.isAbsolute(cliPath) || !path.isAbsolute(nodePath) || path.basename(path.dirname(cliPath)) !== 'bin') {
    throw new Error('Linux service needs absolute CLI and Node paths in a global bin directory');
  }
  const cliScript = resolvedCliScript(cliPath);
  // A saved service CLI is often the resolved package entry rather than the global bin shim.
  // Using dirname(dirname(cliPath)) for that case targets the package itself as npm prefix,
  // nesting each update under @remcp/remcp/lib/node_modules while leaving the agent stale.
  const packageEntrySuffix = path.join('lib', 'node_modules', ...PACKAGE_NAME.split('/'), 'bin', 'remcp.mjs');
  const prefix = cliScript.endsWith(`${path.sep}${packageEntrySuffix}`)
    ? cliScript.slice(0, -(packageEntrySuffix.length + 1)) || path.sep
    : path.dirname(path.dirname(cliPath));
  const lines = [
    '#!/bin/sh',
    'NPM_CONFIG_PREFIX=' + shellQuote(prefix),
    'export NPM_CONFIG_PREFIX',
    'PATH=' + shellQuote(path.dirname(nodePath)) + ':"$PATH"',
    'export PATH',
    'exec ' + shellQuote(nodePath) + ' ' + shellQuote(cliScript) + ' "$@"',
    '',
  ];
  return lines.join('\n');
}

function writeLinuxServiceLauncher(cliPath = globalCliPath(), nodePath = process.execPath) {
  const launcher = linuxServiceLauncherText(cliPath, nodePath);
  fs.mkdirSync(path.dirname(linuxServiceLauncherFile), { recursive: true, mode: 0o700 });
  const temporary = `${linuxServiceLauncherFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, launcher, { mode: 0o700 });
  fs.chmodSync(temporary, 0o700);
  fs.renameSync(temporary, linuxServiceLauncherFile);
  return linuxServiceLauncherFile;
}

export function installLinuxService(cliPath = globalCliPath(), nodePath = process.execPath) {
  const launcherFile = writeLinuxServiceLauncher(cliPath, nodePath);
  // Fresh root installs are boot services owned by PID 1. Legacy per-user units are
  // left under their existing supervisor, but must have linger enabled.
  const syntheticLinuxFixture = process.env.NODE_ENV === 'test' && process.env.REMCP_TEST_PLATFORM === 'linux';
  const privileged = !syntheticLinuxFixture && process.getuid?.() === 0
    && path.resolve(home) === path.resolve(os.userInfo().homedir);
  if (privileged && fs.existsSync(linuxSystemServiceFile) && !linuxSystemAgentOwned()) {
    throw new Error('Refusing to replace an unmanaged systemd remcp-agent.service');
  }
  const system = privileged && (linuxSystemAgentOwned() || !fs.existsSync(linuxServiceFile));
  if (system) {
    if (fs.existsSync(linuxSystemServiceFile) && !linuxSystemAgentOwned()) {
      throw new Error('Refusing to replace an unmanaged systemd remcp-agent.service');
    }
    const unit = `[Unit]\nDescription=ReMCP headless device agent (system service)\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=root\nWorkingDirectory=/root\nEnvironment=HOME=/root\nUMask=0077\nExecStart=${quoteSystemd(launcherFile)} start --service\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n`;
    fs.writeFileSync(linuxSystemServiceFile, unit, { mode:0o644 });
    run('systemctl', ['daemon-reload']);
    run('systemctl', ['enable', '--now', 'remcp-agent.service']);
  } else {
    ensureLinuxLinger();
    const unit = `[Unit]\nDescription=ReMCP device agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${quoteSystemd(launcherFile)} start --service\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`;
    fs.mkdirSync(path.dirname(linuxServiceFile), { recursive: true });
    fs.writeFileSync(linuxServiceFile, unit);
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', 'remcp-agent.service']);
  }
  ensureLinuxCliCommand(cliPath, nodePath);
}

export function writeWindowsServiceLauncher(cliPath = globalCliPath(), nodePath = process.execPath) {
  const launcher = windowsServiceLauncherText(cliPath, nodePath);
  fs.mkdirSync(configDir, { recursive:true, mode:0o700 });
  const temporary = `${windowsServiceLauncherFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, launcher, { mode:0o700 });
  fs.renameSync(temporary, windowsServiceLauncherFile);
  return windowsServiceLauncherFile;
}

function installWindowsUserStartup(cliPath, nodePath) {
  const existed = fs.existsSync(windowsStartupScriptFile);
  if (existed && !windowsStartupScriptInstalled(windowsStartupScriptFile)) {
    throw new Error('The ReMCP Startup entry is not owned by ReMCP; refusing to overwrite it');
  }
  // Windows npm exposes a .cmd shim; the child must execute the actual Node ESM entry.
  const cliEntry = path.join(path.dirname(cliPath), 'node_modules', '@remcp', 'remcp', 'bin', 'remcp.mjs');
  const supervisorEntry = path.resolve(path.dirname(cliEntry), '../src/cli/windows-user-supervisor.mjs');
  if (!fs.existsSync(cliEntry)) throw new Error('Windows ReMCP Node entry is missing');
  if (!fs.existsSync(supervisorEntry)) throw new Error('Windows supervisor entry is missing from the installed ReMCP package');
  ensureWindowsSupervisorKey();
  const script = windowsStartupScriptText(nodePath, supervisorEntry, cliEntry);
  fs.mkdirSync(path.dirname(windowsStartupScriptFile), { recursive:true });
  const temporary = `${windowsStartupScriptFile}.${process.pid}.tmp`;
  try {
    // WSH requires a Unicode BOM to preserve non-ASCII Windows account names.
    fs.writeFileSync(temporary, '\uFEFF' + script, { flag:'wx', mode:0o600, encoding:'utf16le' });
    fs.renameSync(temporary, windowsStartupScriptFile);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
  const startAndVerify = () => {
    run('wscript.exe', ['//B', '//Nologo', windowsStartupScriptFile]);
    const state = windowsSupervisorCommand('wait');
    if (!state.running) throw new Error('Windows Startup agent did not launch');
  };
  // Reuse a running singleton. A missing OS-held pipe means the old supervisor
  // exited: relaunch the same verified entry without touching device credentials.
  if (existed) {
    try {
      const state = windowsSupervisorCommand('status');
      if (!state.running) throw new Error('The existing Windows Startup agent is not running');
    } catch (error) {
      const reason = String(error.message || '');
      if (!reason.includes('ENOENT') && !reason.includes('ECONNREFUSED')) throw error;
      startAndVerify();
    }
  } else {
    try { startAndVerify(); }
    catch (error) {
      // A launched supervisor can be alive when readiness fails. Stop it before cleanup.
      try { windowsSupervisorCommand('stop'); } catch {}
      try { fs.unlinkSync(windowsStartupScriptFile); } catch {}
      throw error;
    }
  }
  console.log('ReMCP uses this Windows account\'s Startup folder (no administrator rights required).');
}

function windowsScheduledTaskPresence() {
  // Never interpret schtasks.exe failure as absence: it also reports access-denied.
  // COM returns locale-independent PRESENT/ABSENT or throws on an uncertain result.
  const query = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive',
    '-Command', windowsTaskAbsenceCommand(windowsTaskName)],
    { encoding:'utf8', windowsHide:true, timeout:30000, maxBuffer:4096, input:'' });
  const state = String(query.stdout || '').trim();
  if (query.error || query.status !== 0 || !['ABSENT', 'PRESENT'].includes(state)) {
    throw new Error('Could not verify the legacy ReMCP Scheduled Task; refusing an unsafe lifecycle change');
  }
  return state;
}

function requireWindowsScheduledTaskAbsent() {
  if (windowsScheduledTaskPresence() !== 'ABSENT') {
    throw new Error('A legacy ReMCP Scheduled Task exists; its child process tree cannot be safely stopped or migrated automatically');
  }
}

// Called before any npm install/update so a legacy task cannot be partially
// replaced while its WScript/CMD/Node descendants are still running.
export function assertWindowsUpdateLifecycleSafe() {
  if (servicePlatform() === 'win32') requireWindowsScheduledTaskAbsent();
}

export function installWindowsService(cliPath = globalCliPath(), { nodePath = process.execPath } = {}) {
  // The old Task Scheduler launcher (WScript -> CMD -> Node) can orphan its
  // descendants after /End. Do not create or touch it on new installations.
  // An existing task must be migrated with verified process ownership first.
  requireWindowsScheduledTaskAbsent();
  installWindowsUserStartup(cliPath, nodePath);
}

// `serviceInstalled` was added after background services already existed in the wild. Treat an
// explicit false as the user's opt-out, an explicit true as the current marker, and only infer the
// old intent from an OS service artifact when the marker is absent. This keeps legacy installs
// repairable without resurrecting a service that a newer client explicitly disabled.
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
  // The interactive task runs at LIMITED privilege, or the current-user Startup folder
  // provides a non-elevated fallback. Neither installation requires a Windows password.
  try {
    const workspaceDir = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ReMCP');
    fs.mkdirSync(workspaceDir, { recursive: true });
  } catch {}
  console.log('ReMCP uses this account\'s interactive desktop privileges.');
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
  // A config can legitimately predate runtime metadata (for example a
  // preferences-only document or a repair after an old unpack). It can also
  // carry a first-party runtime pin from an older release. A local repair must
  // converge to the exact client/runtime pair it is running; custom third-party
  // runtimes from the pairing server are preserved.
  const configuredRuntime = config?.runtime;
  const firstPartyRuntime = !configuredRuntime || configuredRuntime.packageName === '@remcp/runtime';
  const runtime = firstPartyRuntime
    ? {
        kind: 'npm', packageName: '@remcp/runtime',
        packageSpec: `@remcp/runtime@${VERSION}`,
        entry: String(configuredRuntime?.entry || 'src/index.mjs'),
      }
    : configuredRuntime;
  const effectiveConfig = { ...config, runtime };
  const runningCli = process.argv[1] || '';
  if (!releasePairPresentAtCli(runningCli, effectiveConfig)) {
    npmGlobalInstall(`${PACKAGE_NAME}@${VERSION}`, runtime.packageSpec);
  }
  const cliPath = globalCliPath();
  const cliScript = resolvedCliScript(cliPath);
  const nodePath = process.execPath;
  if (platform === 'linux') installLinuxService(cliPath, nodePath);
  else if (platform === 'darwin') {
    installMacService(cliPath, { nodePath });
    ensureMacCliCommand(effectiveConfig, { cliPath:cliScript, nodePath });
  } else installWindowsService(cliPath, { nodePath });
  configurePostInstallAccess();
  saveConfig({ ...effectiveConfig, serviceInstalled: true, serviceCliPath: cliScript, serviceNodePath: nodePath });
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
      const scope = linuxServiceScope();
      if (scope === 'user') ensureLinuxLinger();
      // Read and repair the active unit through one descriptor. Never create a
      // second user agent when a PID-1 system service already owns this pairing.
      let fd = null;
      try {
        fd = fs.openSync(linuxActiveServiceFile(), fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
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
          // Legacy versions added NoNewPrivileges=true to the user agent unit.
          // Drop that line when repairing so ordinary OS-authenticated sudo/polkit
          // can work for the owner's session. ReMCP never becomes root by itself.
          // Do not modify unrelated systemd services or owner-managed drop-ins.
          let repaired = unit.replace(/^NoNewPrivileges=true\r?\n/gm, '');
          if (!repaired.includes(expected)) {
            repaired = /^ExecStart=/m.test(repaired)
              ? repaired.replace(/^ExecStart=.*$/m, expected) : '';
          }
          if (!repaired) {
            reinstall = true;
          } else if (repaired !== unit) {
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
            run('systemctl', [...(scope === 'user' ? ['--user'] : []), 'daemon-reload']);
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

export function deferredLinuxAgentRestartArgs(pid, scope = 'user') {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process identifier');
  if (scope !== 'user' && scope !== 'system') throw new Error('Invalid Linux service scope');
  const option = scope === 'user' ? ['--user'] : [];
  return [...option, '--on-active=3s', `--unit=remcp-agent-settings-${pid}`,
    'systemctl', ...option, 'restart', 'remcp-agent.service'];
}

export function restartPersistentServiceIfInstalled(config, { deferLinux = false, deferWindows = false } = {}) {
  if (!persistentServiceExpected(config)) return null;
  const platform = servicePlatform();
  if (platform === 'linux' && fs.existsSync(linuxActiveServiceFile())) {
    const scope = linuxServiceScope();
    const option = scope === 'user' ? ['--user'] : [];
    // Only owner-confirmed remote policy changes defer their restart. Ordinary
    // installs and updates preserve their existing synchronous supervisor contract.
    if (deferLinux) {
      run('systemd-run', deferredLinuxAgentRestartArgs(process.pid, scope));
      return 'remcp-agent.service (restart scheduled)';
    }
    run('systemctl', [...option, 'daemon-reload']);
    run('systemctl', [...option, 'restart', 'remcp-agent.service']);
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
    // /End can leave Node descendants running after a legacy CMD task ends.
    // Do not report a successful credential restart when ownership is unknown.
    requireWindowsScheduledTaskAbsent();
    if (windowsStartupScriptInstalled(windowsStartupScriptFile)) {
      const state = windowsSupervisorCommand('restart');
      if (state.restartScheduled !== true) throw new Error('Windows user supervisor did not schedule a restart');
      return 'ReMCP user startup supervisor (restart scheduled)';
    }
  }
  return null;
}

export function uninstallPersistentService({ removeCli = false } = {}) {
  const platform = servicePlatform();
  if (platform === 'linux') {
    uninstallOwnedLinuxUnits();
  } else if (platform === 'darwin') {
    const domain = macLaunchDomain();
    spawnSync('launchctl', ['bootout', domain, macServiceFile], { stdio: 'ignore' });
    try { fs.unlinkSync(macServiceFile); } catch {}
    // Ordinary uninstall keeps the CLI/runtime/pairing so `remcp install`
    // remains available. Only --purge removes the managed command.
    if (removeCli) removeMacCliCommand();
  } else if (platform === 'win32') {
    // Refuse before touching any artifact. Scheduler /End and /Delete cannot
    // prove that its detached CMD/Node descendants exited.
    requireWindowsScheduledTaskAbsent();
    if (fs.existsSync(windowsStartupScriptFile) &&
        !windowsStartupScriptInstalled(windowsStartupScriptFile)) {
      throw new Error('The ReMCP Startup entry is not owned by ReMCP; refusing to remove it');
    }
    if (windowsStartupScriptInstalled(windowsStartupScriptFile)) {
      // Removing Startup alone leaves the already spawned agent alive. Stop the
      // exact child owned by the authenticated singleton, then remove registration.
      try {
        const result = windowsSupervisorCommand('stop');
        if (!result.stopped) throw new Error('Windows user agent could not be stopped');
      } catch (error) {
        // An already-exited supervisor has no listening pipe. That is the one safe
        // case where removal may proceed without an acknowledged stop. Never ignore
        // a bad MAC, access denied, timeout, or a failed owned-child termination.
        if (!/\bconnect (?:ENOENT|ECONNREFUSED)\b/.test(String(error?.message || ''))) throw error;
      }
      fs.unlinkSync(windowsStartupScriptFile);
    }
    // Retain legacy launch files. Their presence alone is not proof of ownership,
    // and an absent task provides no safe justification for deleting them.
  }
}
