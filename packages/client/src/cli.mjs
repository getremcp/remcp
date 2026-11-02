import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { runAgent } from './agent.mjs';
import { isNewer } from './agent-update.mjs';
import { normalizeRuntime } from './runtime.mjs';
import { PACKAGE_NAME, VERSION } from './version.mjs';
import { probeFilesystemAccess } from './fs-access.mjs';

import { autoUpdateEnabled, ensureMachineId, loadConfig, readJsonFile, saveConfig, setTelemetry, telemetryState, writeJsonFile } from './cli/config.mjs';
import { assertRuntimeTrust, assertSecureServerUrl, pairWithDeviceCode } from './cli/connect.mjs';
import { diagnoseLocalRuntime, installedVersion, runtimeAllowedRoots } from './cli/doctor.mjs';
import { configFile, npm, officialOrigin, runtimeConfigFile } from './cli/env.mjs';
import { currentInstallationInfo, ensureMacCliCommand, installPersistentAgent, persistentServiceState, servicePlatform, rememberCurrentInstallation, restartPersistentServiceIfInstalled, serviceInstallationInfo, uninstallPersistentService } from './cli/service.mjs';
import { auditKnownInstallations } from './cli/installation-audit.mjs';
import { scheduleMacTemperatureRepair } from './cli/mac-native-temperature.mjs';
import { repairMacTemperatureAfterStart } from './cli/npm-global.mjs';
import { run } from './cli/shell.mjs';
import { updateCommand } from './cli/update.mjs';
function fetchConfiguredServer(url, options) {
  // The URL comes from the locally paired ReMCP config and is used only as the destination;
  // status checks do not upload local file contents.
  // codeql[js/file-access-to-http]
  return fetch(url, options);
}

function parse(argv) {
  const [command = 'help', ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) { positional.push(rest[i]); continue; }
    const key = rest[i].slice(2);
    flags[key] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  }
  return { command, flags, positional };
}

function printHelp() {
  console.log(`ReMCP ${VERSION}\n\nCommands:\n  remcp connect [--no-qr]\n  remcp start\n  remcp status\n  remcp doctor\n  remcp update\n  remcp auto-update [status|on|off]\n  remcp install\n  remcp uninstall\n  remcp uninstall --purge\n  remcp telemetry [status|on|off]\n  remcp godmode [status|on|off]\n  remcp --version\n\nPairing commands are generated in the ReMCP workspace.\n\nUsage metrics are opt-out (tool names, timings, outcomes only, sent to your own ReMCP\naccount through the paired agent). Disable them at any time with: remcp telemetry off\n\nUnrestricted mode (remcp godmode on) lifts the access roots and the command guardrails for this\ncomputer only. The MCP configuration tool cannot enable it; protect remote terminal access.`);
}

// The running agent snapshots update policy at startup. A saved toggle alone does not
// change its six-hour polling loop, so reload a managed service after a policy change.
// Defer Linux handoff to avoid terminating a remote command before it returns.
export function applyAutoUpdatePreference(cfg, enabled, {
  persist = saveConfig,
  restart = restartPersistentServiceIfInstalled,
} = {}) {
  const changed = autoUpdateEnabled(cfg) !== enabled;
  const updated = { ...cfg, autoUpdate: enabled };
  persist(updated);
  return changed ? restart(updated, { deferLinux:true }) : null;
}

export async function main(argv = process.argv.slice(2)) {
  const { command, flags, positional } = parse(argv);

  // Help must be side-effect free even for mutating subcommands. Older agents
  // incorrectly treated `remcp update --help` as an update and ran npm.
  if (command === '--help' || command === '-h' || flags.help === true || flags.h === true) {
    printHelp();
    return;
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(VERSION);
    return;
  }

  if (command === 'connect') {
    // Like the desktop-app flow this mirrors: with no flags the command talks to the official
    // server, prints a code, opens the browser to approve it, and pairs. `--code` keeps working for
    // the workspace-generated command and for CI, and `--server` for self-hosted deployments.
    const previous = loadConfig(false);
    const alreadyPaired = Boolean(previous?.deviceId && previous?.deviceToken);
    // The official Windows bootstrap may be rerun after approval succeeded but OS service
    // registration failed. Repair the existing credential in place, never initiate another
    // device-authorization flow or replace an already owned computer.
    if (alreadyPaired && flags['repair-if-paired'] === true &&
        flags['re-pair'] !== true && !flags.code && flags.install !== false) {
      installPersistentAgent(previous);
      return;
    }
    if (alreadyPaired && flags['re-pair'] !== true) {
      throw new Error('This computer is already paired. Use `remcp doctor` or `remcp install` to repair it without changing credentials. To intentionally replace the pairing (possibly moving it to another account), add --re-pair.');
    }
    const server = assertSecureServerUrl(flags.server || officialOrigin, { allowInsecure: flags['allow-insecure-transport'] === true });
    const code = String(flags.code || '').replace(/\s+/g, '').toUpperCase();
    assertRuntimeTrust(server, flags);

    let paired;
    let deviceInitiated = false;
    if (code) {
      const response = await fetch(`${server}/api/pair/claim`, {
        method: 'POST',
        redirect: 'error',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({ code, machineId: ensureMachineId(), name: String(flags.name || os.hostname()), hostname: os.hostname(), platform: process.platform, arch: process.arch, rePair: flags['re-pair'] === true }),

      });
      if (!response.ok) throw new Error(`Pairing failed (${response.status}): ${await response.text()}`);
      paired = await response.json();
    } else {
      deviceInitiated = true;
      paired = await pairWithDeviceCode(server, flags);
    }
    if (paired.moved_from_another_account) {
      console.log('This computer was paired to another ReMCP account. That device was revoked and this machine now belongs to the account you approved.');
    } else if (paired.movedFromUid) {
      console.log('This computer was paired to another ReMCP account. That device was revoked and this machine now belongs to the account you approved.');
    }
    const config = {
      ...(previous || {}),
      serverUrl: server,
      deviceId: paired.deviceId || paired.device_id,
      deviceToken: paired.deviceToken || paired.device_token,
      deviceName: String(flags.name || os.hostname()),
      runtime: normalizeRuntime(paired.runtime),
      machineId: ensureMachineId(),
      // Remember whether this machine's owner trusted the server to name a runtime version. The
      // auto-updater must not widen that decision on its own later.
      trustRuntime: Boolean(flags['trust-runtime']) || new URL(server).origin === officialOrigin,
      allowInsecureTransport: flags['allow-insecure-transport'] === true,

    };
    saveConfig(config);
    const accountEmail = String(paired.account?.email || '');
    console.log(`Paired ${os.hostname()} with ${server}${accountEmail ? ` as ${accountEmail}` : ''}`);
    // Credential rotation must reload the managed agent; a normal install of an already
    // running systemd service does not restart it, and Windows /Run may keep the old task.
    const managedBefore = alreadyPaired &&
      (previous.serviceInstalled === true ||
        (previous.serviceInstalled === undefined && persistentServiceState(previous).active));
    if (flags.install) {
      installPersistentAgent(config);
      if (alreadyPaired && servicePlatform() !== 'darwin') {
        restartPersistentServiceIfInstalled(config, { deferLinux: true });
      }
      return;
    }
    if (managedBefore) {
      const restarted = restartPersistentServiceIfInstalled(config, { deferLinux: true });
      if (!restarted) installPersistentAgent(config);
      return;
    }
    if (alreadyPaired) {
      console.log('Pairing credentials replaced. Restart any manually managed ReMCP agent to use the new token.');
      return;
    }
    // Only the command that asked for its own code keeps running: someone who ran `remcp connect` on
    // a fresh machine expects the connection to be live when the command finishes. A workspace code
    // keeps its old meaning (pair, then `remcp start` or `--install`).
    if (!deviceInitiated) return;
    // The machine survives a reboot afterwards. Nothing about the credential
    // changes: the same revocable token is used either way.
    installPersistentAgent(config);
    return;
  }

  if (command === 'start') {
    const supervised = flags.service === true
      || Boolean(process.env.INVOCATION_ID)
      || String(process.env.XPC_SERVICE_NAME || '').includes('com.remcp.agent');
    const cfg = rememberCurrentInstallation(loadConfig(), { service:supervised });
    // A service can start from an absolute fnm/nvm Node path even when an interactive macOS shell
    // cannot resolve the npm-global `remcp` binary. Refresh the stable user shim on every start so
    // an auto-update repairs the next Terminal session without requiring a manual PATH edit.
    ensureMacCliCommand(cfg);
    const service = persistentServiceState(cfg);
    if (!supervised && service.active) {
      console.log(`ReMCP is already running as a background service (${service.name}). Use \`remcp status\` to inspect it or \`remcp doctor\` to diagnose it.`);
      return;
    }
    // Older updaters can leave the optional native binary absent. Repair via
    // a separate, fixed-purpose process without delaying the relay connection.
    scheduleMacTemperatureRepair({ runtimePackageName: cfg.runtime?.packageName });
    const telemetry = telemetryState();
    const agent = await runAgent({
      ...cfg,
      autoUpdate: autoUpdateEnabled(cfg),
      trustRuntime: cfg.trustRuntime === true
        || process.env.REMCP_TRUST_RUNTIME === '1'
        || new URL(cfg.serverUrl).origin === officialOrigin,
      telemetryEnabled: telemetry.enabled,
      installReported: telemetry.installReported,
      installSpec: `${PACKAGE_NAME}@${VERSION}`,
      persistState: patch => saveConfig({ ...cfg, ...patch }),
    });
    // The per-user Windows supervisor owns this child through a private Node IPC
    // handle. If the supervisor dies, the agent must close its runtime rather than
    // remain orphaned and create duplicates at the next interactive logon.
    if (supervised && process.env.REMCP_USER_STARTUP_SUPERVISOR === '1') {
      const closeOrphan = () => void agent.stop().finally(() => process.exit(0));
      process.once('disconnect', closeOrphan);
      if (!process.connected) closeOrphan();
    }
    return;
  }

  if (command === '__repair-macos-temperature') {
    // Only the pinned first-party sensor is eligible; no external script input.
    if (servicePlatform() !== 'darwin') return;
    const cfg = loadConfig(false);
    if (repairMacTemperatureAfterStart(cfg?.runtime?.packageName)) {
      console.log('ReMCP: vetted macOS temperature sensor is ready.');
    }
    return;
  }

  if (command === 'auto-update') {
    const action = String(positional[0] || 'status').toLowerCase();
    const cfg = loadConfig(false) || {};
    if (action === 'status') {
      console.log(JSON.stringify({ autoUpdate: autoUpdateEnabled(cfg), checkIntervalHours: 6 }, null, 2));
      return;
    }
    if (['on', 'enable', 'off', 'disable'].includes(action)) {
      const enabled = action === 'on' || action === 'enable';
      const changed = autoUpdateEnabled(cfg) !== enabled;
      const restarted = applyAutoUpdatePreference(cfg, enabled);
      console.log(enabled ? 'Auto-update enabled.' : 'Auto-update disabled. Run `remcp update` yourself when you want a new version.');
      if (restarted) console.log(`ReMCP agent ${restarted} to apply the update policy.`);
      else if (changed) console.log('Restart any manually managed ReMCP agent to apply the update policy.');
      return;
    }
    throw new Error('Usage: remcp auto-update [status|on|off]');
  }

  if (command === 'telemetry') {
    const action = String(positional[0] || 'status').toLowerCase();
    if (action === 'status') {
      console.log(JSON.stringify(telemetryState(), null, 2));
      return;
    }
    if (action === 'on' || action === 'enable') {
      console.log(JSON.stringify(setTelemetry(true), null, 2));
      const restarted = restartPersistentServiceIfInstalled(loadConfig(false),
        { deferLinux: flags['defer-restart'] === true, deferWindows: flags['defer-restart'] === true });
      console.log(restarted ? 'Usage telemetry enabled; agent reload requested.' : 'Usage telemetry enabled for the next agent start.');
      return;
    }
    if (action === 'off' || action === 'disable') {
      console.log(JSON.stringify(setTelemetry(false), null, 2));
      const restarted = restartPersistentServiceIfInstalled(loadConfig(false),
        { deferLinux: flags['defer-restart'] === true, deferWindows: flags['defer-restart'] === true });
      console.log(restarted ? 'Usage telemetry disabled; agent reload requested.' : 'Usage telemetry disabled for the next agent start.');
      return;
    }
    throw new Error('Usage: remcp telemetry [status|on|off]');
  }

  // The switch that lifts every guardrail: no access roots, no command blocklist, no catastrophic
  // command protection. The runtime refuses to set it through MCP's configuration
  // tool; the device owner can deliberately change it through the CLI or the
  // authenticated Workspace with explicit confirmation. Remote shell access
  // remains powerful and must be protected by the account and OS permissions.
  if (command === 'godmode' || command === 'unrestricted') {
    const action = String(positional[0] || 'status').toLowerCase();
    if (action === 'status') {
      const runtimeFile = readJsonFile(runtimeConfigFile);
      const state = runtimeFile.unrestricted === true || process.env.REMCP_RUNTIME_UNRESTRICTED === '1';
      console.log(JSON.stringify({
        unrestricted: state,
        source: runtimeFile.unrestricted === true ? runtimeConfigFile : process.env.REMCP_RUNTIME_UNRESTRICTED === '1' ? 'REMCP_RUNTIME_UNRESTRICTED' : 'default',
        meaning: state
          ? 'Every path and every command is allowed. Commands run as the user the agent runs as, so sudo still needs your own sudoers rules; nothing here grants root by itself.'
          : 'The runtime confines file access to its allowed roots and applies its command guardrails.',
      }, null, 2));
      return;
    }
    if (!['on', 'off', 'enable', 'disable'].includes(action)) throw new Error('Usage: remcp godmode [status|on|off]');
    const enabled = action === 'on' || action === 'enable';
    writeJsonFile(runtimeConfigFile, { ...readJsonFile(runtimeConfigFile), unrestricted: enabled });
    // The authenticated Workspace supplies this explicit flag so the remote
    // command can acknowledge a policy change before Linux/Windows kills its
    // own agent session. Local CLI operations retain synchronous semantics.
    const restarted = restartPersistentServiceIfInstalled(loadConfig(false),
      { deferLinux: flags['defer-restart'] === true,
        deferWindows: flags['defer-restart'] === true });
    if (enabled) {
      console.error('Unrestricted mode is ON for this computer: every path and every command is allowed, including sudo. Anything the model is asked to do -- and anything a prompt injection asks it to do -- can now change this machine. Turn it off with `remcp godmode off` when you are done.');
    } else {
      console.log('Unrestricted mode is off: the runtime is back to its allowed roots and command guardrails.');
    }
    console.log(JSON.stringify({ unrestricted: enabled, configFile: runtimeConfigFile, restarted }, null, 2));
    return;
  }

  if (command === 'status' || command === 'doctor') {
    const cfg = rememberCurrentInstallation(loadConfig());
    const server = assertSecureServerUrl(cfg.serverUrl, { allowInsecure: cfg.allowInsecureTransport === true || process.env.REMCP_ALLOW_INSECURE_TRANSPORT === 'true' });
    const [health, advertised] = await Promise.all([
      fetchConfiguredServer(`${server}/health?fresh=${Date.now()}`, { cache:'no-store', redirect:'error' })
        .then(async response => ({ reachable:response.ok && (await response.json().catch(() => null))?.ok === true }))
        .catch(error => ({ reachable:false, error:error.message })),
      fetchConfiguredServer(`${server}/api/agent/version?fresh=${Date.now()}`, { cache:'no-store', redirect:'error' })
        .then(response => response.ok ? response.json() : null)
        .catch(() => null),
    ]);
    const telemetry = telemetryState();
    const service = persistentServiceState(cfg);
    const currentInstall = currentInstallationInfo(cfg);
    const serviceInstall = serviceInstallationInfo(cfg);
    // Prefer the runtime installed beside this CLI. npm may resolve a different
    // global prefix when a shell launches this entry with another Node version.
    const installedRuntime = currentInstall.runtimeVersion || installedVersion(cfg.runtime.packageName);
    const targetClient = String(advertised?.cliVersion || '').trim() || null;
    const targetRuntime = String(advertised?.runtime || '').trim() || null;
    const configuredRuntime = String(cfg.runtime.packageSpec || '');
    // Count verified physical ReMCP package roots, not merely surviving paths or
    // shell aliases. This is NOT a concurrent-agent/process count.
    const installationAudit = auditKnownInstallations(cfg, {
      currentCliPath:currentInstall.cliPath,
      serviceCliPath:service.installed ? serviceInstall.cliPath : null,
    });
    const multipleInstallations = installationAudit.packageCopyCount > 1;
    const knownCliVersions = [VERSION, serviceInstall.cliVersion].filter(Boolean);
    const knownRuntimeVersions = [installedRuntime, serviceInstall.runtimeVersion].filter(Boolean);
    const versionConsistent = cfg.runtime.packageName === '@remcp/runtime'
      ? new Set([...knownCliVersions, ...knownRuntimeVersions]).size <= 1
      : new Set(knownCliVersions).size <= 1 && new Set(knownRuntimeVersions).size <= 1;
    const clientMeetsTarget = Boolean(targetClient && !isNewer(targetClient, VERSION));
    const configuredRuntimeMeetsTarget = Boolean(!targetRuntime || (configuredRuntime && !isNewer(targetRuntime, configuredRuntime)));
    const runtimeMeetsTarget = Boolean(!targetRuntime || (installedRuntime && !isNewer(targetRuntime, installedRuntime)));
    const serviceClientMeetsTarget = !service.installed
      || Boolean(targetClient && serviceInstall.cliVersion && !isNewer(targetClient, serviceInstall.cliVersion));
    const serviceRuntimeMeetsTarget = !service.installed
      || Boolean(!targetRuntime || (serviceInstall.runtimeVersion && !isNewer(targetRuntime, serviceInstall.runtimeVersion)));
    const upToDate = Boolean(
      targetClient
      && clientMeetsTarget
      && configuredRuntimeMeetsTarget
      && runtimeMeetsTarget
      && serviceClientMeetsTarget
      && serviceRuntimeMeetsTarget
    );
    const updateState = !targetClient
      ? 'unknown'
      : !upToDate
        ? 'update_available'
        : versionConsistent
          ? (isNewer(VERSION, targetClient) ? 'ahead' : 'current')
          : 'mixed_current';
    const report = {
      configured:true,
      device:{ id:cfg.deviceId, name:cfg.deviceName },
      client:{ version:VERSION },
      runtime:{
        packageName:cfg.runtime.packageName,
        configured:configuredRuntime,
        installed:installedRuntime,
      },
      agent:{
        mode:service.installed ? 'service' : 'manual',
        running:service.active,
        manager:service.manager,
        serviceCliVersion:serviceInstall.cliVersion,
        serviceRuntimeVersion:serviceInstall.runtimeVersion,
      },
      server:{
        url:cfg.serverUrl,
        reachable:health.reachable === true,
        ...(health.error ? { error:health.error } : {}),
      },
      update:{
        auto:autoUpdateEnabled(cfg),
        targetClient,
        targetRuntime,
        multipleInstallations,
        knownPackageCopies:installationAudit.packageCopyCount,
        additionalKnownPackageCopies:installationAudit.otherCopyCount,
        installationCountScope:'verified_physical_packages_not_running_agents',
        versionConsistent,
        state:updateState,
        upToDate,
      },
      telemetry:{ enabled:telemetry.enabled },
    };
    if (command === 'doctor') {
      report.diagnosis = await diagnoseLocalRuntime(cfg);
      report.diagnosis.filesystem = await probeFilesystemAccess({ roots:runtimeAllowedRoots() });
      report.diagnostic = {
        serviceExpected:service.expected,
        serviceInstalled:service.installed,
        runtimeEntry:cfg.runtime.entry,
        npmManaged:true,
        installations:installationAudit,
      };
    }
    console.log(JSON.stringify(report, null, 2));
    if (command === 'doctor' && report.diagnosis.verdict !== 'ok') process.exitCode = 1;
    return;
  }

  if (command === 'install') {
    installPersistentAgent(loadConfig());
    return;
  }

  if (command === 'update') {
    await updateCommand(flags);
    return;
  }

  if (command === 'uninstall') {
    const cfg = loadConfig(false);
    uninstallPersistentService();
    // Keep the pairing unless --purge was requested, but remember that the owner explicitly removed
    // the supervisor. Future updates must not infer an old service artifact and recreate it.
    if (cfg) saveConfig({ ...cfg, serviceInstalled: false });
    if (flags.purge) {
      const specs = [PACKAGE_NAME, ...(cfg?.runtime?.packageName ? [cfg.runtime.packageName] : [])];
      run(npm.command, [...npm.args, 'uninstall', '--global', ...specs, '--no-audit', '--no-fund', '--loglevel=error']);
    }
    return;
  }

  printHelp();
}
