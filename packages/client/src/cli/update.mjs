// `remcp update`: install the release pair advertised by the paired server, then let whoever
// supervises the agent restart it. Only exact versions of the configured first-party packages are
// installable, so a server cannot point this machine at a different package or a git/URL/tag spec.
import fs from 'node:fs';
import process from 'node:process';

import { supervisorRestart } from '../agent.mjs';
import { isRuntimeSpecFor, normalizeRuntime } from '../runtime.mjs';
import { PACKAGE_NAME, VERSION } from '../version.mjs';

import { loadConfig, saveConfig } from './config.mjs';
import { assertSecureServerUrl } from './connect.mjs';
import { installedVersion } from './doctor.mjs';
import { linuxServiceFile, macServiceFile, officialOrigin } from './env.mjs';
import { currentInstallationInfo, ensureMacCliCommand, ensureServiceIfRecorded, npmGlobalUpdate, persistentServiceExpected, rememberCurrentInstallation, restartPersistentServiceIfInstalled, servicePlatform, serviceInstallationInfo, syncKnownInstallations } from './service.mjs';

const UPDATE_DISCOVERY_TIMEOUT_MS = 5000;

function runtimeTrustAllowed(cfg, flags, env = process.env) {
  return cfg.trustRuntime === true
    || Boolean(flags['trust-runtime'])
    || env.REMCP_TRUST_RUNTIME === '1'
    // A configuration written before the field existed paired with the official server, which is
    // trusted by definition; refusing it would silently stop every existing device updating.
    || new URL(cfg.serverUrl).origin === officialOrigin;
}

function exactClientSpec(value) {
  const spec = String(value || '').trim();
  return isRuntimeSpecFor(PACKAGE_NAME, spec) ? spec : '';
}

function specVersion(packageName, spec) {
  const value = String(spec || '');
  return isRuntimeSpecFor(packageName, value) ? value.slice(`${packageName}@`.length) : '';
}

function releasePairMatches(clientSpec, runtimePackageName, runtimeSpec) {
  if (!isRuntimeSpecFor(PACKAGE_NAME, clientSpec) || !isRuntimeSpecFor(runtimePackageName, runtimeSpec)) return false;
  // First-party client/runtime releases are one contract and intentionally share a version. Custom
  // runtimes can version independently because their package is controlled by the operator.
  if (runtimePackageName !== '@remcp/runtime') return true;
  return specVersion(PACKAGE_NAME, clientSpec) === specVersion(runtimePackageName, runtimeSpec);
}

export async function resolveUpdateTargets({
  cfg,
  flags = {},
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  const validatedServerUrl = assertSecureServerUrl(cfg.serverUrl, {
    allowInsecure: cfg.allowInsecureTransport === true || flags['allow-insecure-transport'] === true || env.REMCP_ALLOW_INSECURE_TRANSPORT === 'true',
  });
  const validatedCfg = { ...cfg, serverUrl: validatedServerUrl };
  const requestedRuntime = typeof flags.runtime === 'string' ? flags.runtime.trim() : '';
  const requestedClient = typeof flags.client === 'string' ? flags.client.trim() : '';
  const latestClient = `${PACKAGE_NAME}@latest`;
  const currentClient = `${PACKAGE_NAME}@${VERSION}`;
  const trusted = runtimeTrustAllowed(validatedCfg, flags, env);

  let clientSpec = latestClient;
  if (requestedClient) {
    clientSpec = exactClientSpec(requestedClient);
    if (!clientSpec) throw new Error(`--client must be ${PACKAGE_NAME}@<version>`);
  }

  if (requestedRuntime) {
    // Only `<configured package>@<semver>` is installable: an alias, a git/URL/file spec, a tag or
    // a range would run code the user never agreed to.
    if (!isRuntimeSpecFor(validatedCfg.runtime.packageName, requestedRuntime)) {
      throw new Error(`--runtime must be ${validatedCfg.runtime.packageName}@<version>`);
    }
    if (!trusted) {
      throw new Error(`This machine was paired without trusting ${validatedCfg.serverUrl} to choose a runtime version. Re-run with --trust-runtime if you trust that server.`);
    }
    const runtimeSpec = normalizeRuntime({
      kind: 'npm',
      packageName: validatedCfg.runtime.packageName,
      packageSpec: requestedRuntime,
      entry: validatedCfg.runtime.entry,
    }).packageSpec;
    if (requestedClient && !releasePairMatches(clientSpec, validatedCfg.runtime.packageName, runtimeSpec)) {
      throw new Error('The client and first-party runtime must use the same exact release version.');
    }
    if (!requestedClient && validatedCfg.runtime.packageName === '@remcp/runtime' && specVersion(validatedCfg.runtime.packageName, runtimeSpec) !== VERSION) {
      throw new Error(`--runtime without --client must match the running client version ${VERSION}`);
    }
    return {
      clientSpec: requestedClient ? clientSpec : currentClient,
      runtimeSpec,
      persistRuntime: runtimeSpec !== validatedCfg.runtime.packageSpec,
      installable: true,
      source: requestedClient ? 'explicit-pair' : 'explicit-runtime',
      warning: '',
    };
  }

  // A manual `remcp update` has to move the client and the first-party runtime in lockstep too.
  // Older versions reused the runtime pin stored at pairing time, so a manual client update could
  // install a newer client while deliberately reinstalling an older runtime. Resolve the exact
  // release pair from the same public endpoint the running agent already trusts. During a public-
  // first rollout this also prevents `@latest` from getting ahead of the version production
  // actually advertises.
  if (!trusted) {
    return {
      clientSpec,
      runtimeSpec: validatedCfg.runtime.packageSpec,
      persistRuntime: false,
      installable: true,
      source: 'configured',
      warning: '',
    };
  }

  try {
    const versionUrl = new URL('/api/agent/version', validatedCfg.serverUrl).toString();
    const response = await fetchImpl(versionUrl, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(UPDATE_DISCOVERY_TIMEOUT_MS),
    });
    if (!response?.ok) {
      return {
        clientSpec: currentClient,
        runtimeSpec: validatedCfg.runtime.packageSpec,
        persistRuntime: false,
        installable: false,
        source: 'configured',
        warning: `Could not resolve the server release pair (HTTP ${response?.status ?? 'unknown'}); refusing a partial update.`,
      };
    }

    const advertised = await response.json();
    const runtimeCandidate = String(advertised?.runtime || '').trim();
    const advertisedClient = exactClientSpec(advertised?.cli);
    const clientCandidate = requestedClient || advertisedClient;
    if (!advertisedClient
      || !releasePairMatches(advertisedClient, validatedCfg.runtime.packageName, runtimeCandidate)
      || (requestedClient && requestedClient !== advertisedClient)) {
      return {
        clientSpec: currentClient,
        runtimeSpec: validatedCfg.runtime.packageSpec,
        persistRuntime: false,
        installable: false,
        source: 'configured',
        warning: 'Could not resolve a valid server release pair; refusing a partial update.',
      };
    }

    const runtimeSpec = normalizeRuntime({
      kind: 'npm',
      packageName: validatedCfg.runtime.packageName,
      packageSpec: runtimeCandidate,
      entry: validatedCfg.runtime.entry,
    }).packageSpec;
    return {
      clientSpec: clientCandidate,
      runtimeSpec,
      persistRuntime: runtimeSpec !== validatedCfg.runtime.packageSpec,
      installable: true,
      source: 'server',
      warning: '',
    };
  } catch (error) {
    return {
      clientSpec: currentClient,
      runtimeSpec: validatedCfg.runtime.packageSpec,
      persistRuntime: false,
      installable: false,
      source: 'configured',
      warning: `Could not resolve the server release pair (${error instanceof Error ? error.message : String(error)}); refusing a partial update.`,
    };
  }
}

export function updateAlreadyCurrent({ cfg, targets, currentInstall, serviceInstall, serviceExpected }) {
  const targetClientVersion = specVersion(PACKAGE_NAME, targets?.clientSpec);
  const targetRuntimeVersion = specVersion(cfg?.runtime?.packageName, targets?.runtimeSpec);
  if (!targetClientVersion || !targetRuntimeVersion) return false;

  const currentClientVersion = String(currentInstall?.cliVersion || '').trim();
  const currentRuntimeVersion = String(currentInstall?.runtimeVersion || '').trim();
  if (currentClientVersion !== targetClientVersion || currentRuntimeVersion !== targetRuntimeVersion) return false;

  if (serviceExpected) {
    if (String(serviceInstall?.cliVersion || '').trim() !== targetClientVersion) return false;
    if (String(serviceInstall?.runtimeVersion || '').trim() !== targetRuntimeVersion) return false;
  }

  // Historic secondary installations may belong to other Node managers and applications.
  // Never let one stale record force an automatic update of the active, healthy service.
  return true;
}

export function verifyManagedServiceReleasePair(serviceInstall, clientSpec, runtimePackageName, runtimeSpec) {
  const expectedClient = specVersion(PACKAGE_NAME, clientSpec);
  const expectedRuntime = specVersion(runtimePackageName, runtimeSpec);
  if (!expectedClient || !expectedRuntime || serviceInstall?.cliVersion !== expectedClient || serviceInstall?.runtimeVersion !== expectedRuntime) {
    throw new Error(`ReMCP update refused to restart: managed service still runs client ${serviceInstall?.cliVersion || 'missing'} / runtime ${serviceInstall?.runtimeVersion || 'missing'}; expected ${expectedClient || 'invalid'} / ${expectedRuntime || 'invalid'}. Repair npm prefix and retry.`);
  }
}

// A pinned automatic update can be a no-op on disk while an older Windows agent
// still owns the Scheduled Task. Keep manual unpinned no-ops side-effect free.
export function shouldApplyAlreadyInstalledWindowsRelease({ platform, serviceExpected, flags }) {
  return platform === 'win32' && serviceExpected === true &&
    typeof flags?.client === 'string' && Boolean(flags.client.trim()) &&
    typeof flags?.runtime === 'string' && Boolean(flags.runtime.trim());
}

export async function updateCommand(flags) {
  let cfg = rememberCurrentInstallation(loadConfig());
  const targets = await resolveUpdateTargets({ cfg, flags });
  if (targets.warning) console.error(`ReMCP update: ${targets.warning}`);

  const currentInstall = currentInstallationInfo(cfg);
  if (!currentInstall.runtimeVersion) currentInstall.runtimeVersion = installedVersion(cfg.runtime.packageName);
  const serviceExpected = persistentServiceExpected(cfg);
  const serviceInstall = serviceInstallationInfo(cfg);
  const alreadyCurrent = targets.installable && updateAlreadyCurrent({
    cfg,
    targets,
    currentInstall,
    serviceInstall,
    serviceExpected,
  });

  if (flags.check) {
    console.log(JSON.stringify({
      current: VERSION,
      installedRuntime: currentInstall.runtimeVersion,
      clientSpec: targets.clientSpec,
      runtimeSpec: targets.runtimeSpec,
      updateSource: targets.source,
      installable: targets.installable,
      upToDate: alreadyCurrent,
      managedService: fs.existsSync(linuxServiceFile) || fs.existsSync(macServiceFile),
      supervisor: supervisorRestart() ?? 'none',
    }, null, 2));
    return;
  }

  if (!targets.installable) {
    throw new Error(targets.warning || 'Could not resolve a complete client/runtime release pair.');
  }

  if (alreadyCurrent) {
    // `npx @remcp/remcp@latest update` is the recovery path when a Node-manager prefix was never
    // exported into the user's shell. Even with no package delta, repair the stable macOS command.
    ensureMacCliCommand(cfg);
    if (targets.persistRuntime) {
      saveConfig({ ...cfg, runtime:{ ...cfg.runtime, packageSpec:targets.runtimeSpec } });
    }
    const currentRuntimeVersion = String(currentInstall.runtimeVersion || specVersion(cfg.runtime.packageName, targets.runtimeSpec) || '?');
    console.log(`ReMCP is already up to date (client ${currentInstall.cliVersion || VERSION}, runtime ${currentRuntimeVersion}).`);
    if (shouldApplyAlreadyInstalledWindowsRelease({ platform: servicePlatform(), serviceExpected, flags })) {
      // This CLI may be newer than its still-running parent agent. The canonical
      // service files are correct, but the existing Windows task must hand over.
      const restarted = restartPersistentServiceIfInstalled(cfg, { deferWindows: true });
      if (!restarted) throw new Error('ReMCP Windows task could not schedule a restart for the installed release');
      console.log(`ReMCP installed release will be applied: ${restarted}.`);
    }
    return;
  }

  const before = { cli: VERSION, runtime: installedVersion(cfg.runtime.packageName) };
  console.log(`Updating ReMCP to ${targets.clientSpec} with ${targets.runtimeSpec}…`);
  npmGlobalUpdate([PACKAGE_NAME, cfg.runtime.packageName], targets.clientSpec, targets.runtimeSpec);

  // Converge only the canonical service installation. Never update secondary nvm/Hermes/
  // Homebrew installations implicitly: they may be managed by other applications.
  const synced = syncKnownInstallations(cfg, targets.clientSpec, targets.runtimeSpec);
  for (const item of synced) {
    if (!item.ok) console.error(`ReMCP update: could not sync secondary installation at ${item.nodePath}: ${item.error}`);
  }

  // npm can report a successful install into a wrong global prefix. Before touching
  // systemd/launchd, verify the exact release pair at the canonical service CLI path.
  // Otherwise a stale launcher repeatedly restarts the old agent and loses device RPCs.
  // Exact server-advertised or explicit release pairs must match the service on disk.
  // A legacy manual `remcp update` against an untrusted/custom server may use @latest,
  // for which no exact version is known until npm resolves it. Keep that manual path
  // compatible; the automatic agent always supplies an exact version.
  if (serviceExpected && specVersion(PACKAGE_NAME, targets.clientSpec)
      && specVersion(cfg.runtime.packageName, targets.runtimeSpec)) {
    verifyManagedServiceReleasePair(serviceInstallationInfo(cfg), targets.clientSpec, cfg.runtime.packageName, targets.runtimeSpec);
  }

  // Persist the validated runtime pair before repairing the supervisor so a repair cannot be
  // overwritten by an older in-memory config object.
  if (targets.persistRuntime) {
    saveConfig({ ...cfg, runtime:{ ...cfg.runtime, packageSpec:targets.runtimeSpec } });
    cfg = loadConfig();
  }
  const restartAlreadyScheduled = ensureServiceIfRecorded(cfg);
  cfg = loadConfig();
  const after = { cli: installedVersion(PACKAGE_NAME), runtime: installedVersion(cfg.runtime.packageName) };
  // A changed macOS plist is reloaded by an independent launchd helper. Do not schedule a second
  // helper against the same job: two one-second handoffs can race bootout/bootstrap with kickstart
  // and leave the device offline even though npm installed the new release successfully.
  // On Windows the updater may be a descendant of the task being restarted.
  // An inline /End kills the updater before its /Run can execute, leaving an
  // older process connected after the new release was installed on disk.
  // Use the already-tested independent handoff helper for every update.
  const restarted = restartAlreadyScheduled ||
    restartPersistentServiceIfInstalled(cfg, { deferWindows: true });
  if (restarted) {
    console.log(`ReMCP updated and ${restarted} restarted (client ${before.cli} → ${after.cli ?? '?'}, runtime ${before.runtime ?? '?'} → ${after.runtime ?? '?'}).`);
    return;
  }
  // This process is the updater, not the agent: exiting here would restart nothing. The agent sees
  // the exit status, verifies the installed version, and restarts itself.
  console.log(`ReMCP updated (client ${before.cli} → ${after.cli ?? '?'}, runtime ${before.runtime ?? '?'} → ${after.runtime ?? '?'}). The running agent restarts itself to apply it.`);
  if (after.cli === before.cli && after.runtime === before.runtime) {
    console.log('Nothing changed: the installed versions already match the requested ones.');
  }
  return;
}
