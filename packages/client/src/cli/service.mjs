import { servicePlatform, globalPrefix, globalCliPath, npmGlobalInstall, npmGlobalUpdate, npmGlobalUpdateForNode } from './npm-global.mjs';
import { persistentServiceExpected, persistentServiceState, releasePairPresentAtCli, installationVersionsAtCliPath, serviceInstallationInfo, currentInstallationInfo, rememberCurrentInstallation, syncKnownInstallations, canonicalServiceCliPath, canonicalServiceNodePath } from './service-inventory.mjs';
export { servicePlatform, globalPrefix, globalCliPath, npmGlobalInstall, npmGlobalUpdate, npmGlobalUpdateForNode };
export { persistentServiceExpected, persistentServiceState, releasePairPresentAtCli, installationVersionsAtCliPath, serviceInstallationInfo, currentInstallationInfo, rememberCurrentInstallation, syncKnownInstallations };
// Installing, repairing and removing the background agent: one supervisor per platform, plus the
// write-access tweaks a fresh install needs. Nothing here is reachable from a model or an MCP tool.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { resolvedCliScript, shellQuote } from './service-paths.mjs';
import { macLaunchDomain, ensureMacCliCommand, installMacService, macJobLoaded, scheduleMacServiceRestart, removeMacCliCommand } from './service-macos.mjs';
export { xmlEscape } from './service-paths.mjs';
export { macLaunchDomain, ensureMacCliCommand, installMacService } from './service-macos.mjs';
import { PACKAGE_NAME, VERSION } from '../version.mjs';

import { saveConfig } from './config.mjs';
import { configDir, home, linuxServiceFile, linuxServiceLauncherFile, macServiceFile, macServiceLabel, windowsServiceLauncherFile, windowsTaskName } from './env.mjs';
import { run } from './shell.mjs';
import { windowsServiceLauncherText, windowsTaskReliabilityCommand } from './windows-supervisor.mjs';

export function quoteSystemd(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
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

export function installLinuxService(cliPath = globalCliPath(), nodePath = process.execPath) {
  const launcherFile = writeLinuxServiceLauncher(cliPath, nodePath);
  const unit = `[Unit]\nDescription=ReMCP device agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${quoteSystemd(launcherFile)} start --service\nRestart=always\nRestartSec=3\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`;
  fs.mkdirSync(path.dirname(linuxServiceFile), { recursive: true });
  fs.writeFileSync(linuxServiceFile, unit);
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', 'remcp-agent.service']);
}

export function writeWindowsServiceLauncher(cliPath = globalCliPath(), nodePath = process.execPath) {
  const launcher = windowsServiceLauncherText(cliPath, nodePath);
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
  // The default Windows task policy expires long-running tasks and stops them on battery.
  // Apply guarded failure recovery without changing the interactive-user principal/session.
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsTaskReliabilityCommand(windowsTaskName)]);
  run('schtasks.exe', ['/Run', '/TN', windowsTaskName]);
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
  const runningCli = process.argv[1] || '';
  if (!releasePairPresentAtCli(runningCli, config)) {
    npmGlobalInstall(`${PACKAGE_NAME}@${VERSION}`, config.runtime.packageSpec);
  }
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
