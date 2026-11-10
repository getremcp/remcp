import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { PACKAGE_NAME, VERSION } from '../version.mjs';
import { saveConfig } from './config.mjs';
import { linuxServiceFile, linuxServiceLauncherFile, macServiceFile, macServiceLabel, windowsStartupScriptFile, windowsTaskName } from './env.mjs';
import { linuxSystemAgentOwned } from './service-linux.mjs';
import { servicePlatform, globalCliPath, npmGlobalUpdateAtPrefix, npmGlobalUpdateForNode } from './npm-global.mjs';
import { windowsStartupScriptInstalled } from './windows-supervisor.mjs';
import { windowsSupervisorRequest } from './windows-user-supervisor.mjs';

export function persistentServiceExpected(config) {
  if (config?.serviceInstalled === false) return false;
  if (config?.serviceInstalled === true) return true;
  const platform = servicePlatform();
  if (platform === 'linux') return linuxSystemAgentOwned() || fs.existsSync(linuxServiceFile);
  if (platform === 'darwin') return fs.existsSync(macServiceFile);
  if (platform === 'win32') {
    return windowsStartupScriptInstalled(windowsStartupScriptFile) ||
      spawnSync('schtasks.exe', ['/Query', '/TN', windowsTaskName], { stdio: 'ignore', windowsHide: true }).status === 0;
  }
  return false;
}

export function persistentServiceState(config) {
  const platform = servicePlatform();
  const expected = persistentServiceExpected(config);
  if (platform === 'linux') {
    const system = linuxSystemAgentOwned();
    const installed = system || fs.existsSync(linuxServiceFile);
    const active = installed && spawnSync('systemctl', [...(system ? [] : ['--user']), 'is-active', '--quiet', 'remcp-agent.service'], { stdio: 'ignore' }).status === 0;
    return { expected, installed, active, manager:installed ? (system ? 'systemd-system' : 'systemd-user') : 'none', name:'remcp-agent.service' };
  }
  if (platform === 'darwin') {
    const installed = fs.existsSync(macServiceFile);
    const target = typeof process.getuid === 'function' ? 'gui/' + process.getuid() + '/' + macServiceLabel : macServiceLabel;
    const active = installed && spawnSync('launchctl', ['print', target], { stdio: 'ignore' }).status === 0;
    return { expected, installed, active, manager:'launchd', name:macServiceLabel };
  }
  if (platform === 'win32') {
    const query = spawnSync('schtasks.exe', ['/Query', '/TN', windowsTaskName, '/FO', 'LIST'], { encoding:'utf8', windowsHide:true });
    const installed = query.status === 0;
    const outputText = String(query.stdout || '');
    const active = installed && /(?:Status|Состояние):\s*Running/i.test(outputText);
    if (!installed && windowsStartupScriptInstalled(windowsStartupScriptFile)) {
      // Startup has no OS status query comparable to Task Scheduler; do not report a
      // running process without evidence. Device presence is tracked separately.
      return { expected, installed:true, active:null, manager:'startup-user', name:windowsTaskName };
    }
    return { expected, installed, active, manager:'schtasks', name:windowsTaskName };
  }
  return { expected:false, installed:false, active:false, manager:null, name:null };
}

// Startup-folder registration proves only that an agent SHOULD launch at logon.
// Query the existing authenticated supervisor to distinguish a live child from
// an offline/stalled installation. Never start or repair a service in status.
export async function persistentServiceStatus(config) {
  const state = persistentServiceState(config);
  if (servicePlatform() !== 'win32' || state.manager !== 'startup-user') return state;
  try {
    const reply = await windowsSupervisorRequest('status', { timeoutMs:1500 });
    if (typeof reply.running !== 'boolean') {
      return { ...state, statusSource:'authenticated_supervisor', statusReason:'invalid_supervisor_status' };
    }
    return { ...state, active:reply.running, statusSource:'authenticated_supervisor',
      restartPending:reply.restartPending === true };
  } catch (error) {
    const absent = ['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(error?.code);
    return { ...state, active:absent ? false : null, statusSource:'authenticated_supervisor',
      statusReason:absent ? 'supervisor_unavailable' : 'supervisor_probe_failed' };
  }
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

export function canonicalServiceCliPath(config) {
  const configured = String(config?.serviceCliPath || '').trim();
  if (servicePlatform() === 'win32' && configured) {
    // Saved serviceCliPath is the resolved npm package entry (remcp.mjs), not
    // the Windows executable shim. CMD `call remcp.mjs` opens the Windows
    // "Choose an app" dialog instead of starting Node, and dirname(entry) is
    // an invalid NPM_CONFIG_PREFIX. Recover the sibling npm global shim.
    const suffix = '/node_modules/@remcp/remcp/bin/remcp.mjs';
    if (configured.replaceAll('\\', '/').toLowerCase().endsWith(suffix)) {
      const prefix = configured.slice(0, -suffix.length);
      const shim = path.join(prefix, 'remcp.cmd');
      if (!fs.existsSync(shim)) throw new Error('Windows ReMCP npm shim is missing; refusing a .mjs Scheduled Task');
      return shim;
    }
  }
  if (configured && fs.existsSync(configured)) return configured;
  const inferred = inferServiceIdentity().cliPath;
  if (inferred && fs.existsSync(inferred)) return inferred;
  return globalCliPath();
}

export function canonicalServiceNodePath(config) {
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

function exactPackageSpecVersion(packageName, packageSpec) {
  const prefix = `${String(packageName || '')}@`;
  const spec = String(packageSpec || '');
  return prefix !== '@' && spec.startsWith(prefix) ? spec.slice(prefix.length) : '';
}

// A PowerShell bootstrap already installs the exact client/runtime pair before it starts pairing.
// Reusing that verified pair avoids a second registry mutation during `connect --install` while
// preserving the normal npm path for partial, stale, custom-runtime and non-bootstrap installs.
export function releasePairPresentAtCli(cliPath, config) {
  const runtimePackageName = String(config?.runtime?.packageName || '');
  const expectedRuntimeVersion = exactPackageSpecVersion(runtimePackageName, config?.runtime?.packageSpec);
  if (!cliPath || !runtimePackageName || !expectedRuntimeVersion) return false;
  return packageVersionForCli(cliPath, PACKAGE_NAME) === VERSION
    && packageVersionForCli(cliPath, runtimePackageName) === expectedRuntimeVersion;
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

// Derive the write destination from the launcher actually owned by the
// supervisor, NOT from the npm prefix of the Node executable. Both prefixes
// often use the same NVM/Homebrew Node binary.
export function serviceNpmPrefixFromCliPath(cliPath, platform = servicePlatform()) {
  const file = String(cliPath || '').trim().replaceAll('\\', '/');
  const packageSuffix = platform === 'win32'
    ? '/node_modules/@remcp/remcp/bin/remcp.mjs'
    : '/lib/node_modules/@remcp/remcp/bin/remcp.mjs';
  let prefix = file.endsWith(packageSuffix) ? file.slice(0, -packageSuffix.length) : '';
  if (!prefix && platform === 'win32' && /\/remcp\.cmd$/i.test(file)) {
    prefix = file.slice(0, -'/remcp.cmd'.length);
  }
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!prefix || !paths.isAbsolute(prefix) || paths.parse(prefix).root === prefix) {
    throw new Error('ReMCP update refused: cannot identify the canonical service npm prefix.');
  }
  return paths.normalize(prefix);
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
  if (!serviceInfo.nodePath) return [];
  const runtimePackageName = String(config?.runtime?.packageName || '');
  if (!runtimePackageName) throw new Error('ReMCP update refused: missing managed runtime package.');
  const expectedCli = exactPackageSpecVersion(PACKAGE_NAME, specs[0]);
  const expectedRuntime = exactPackageSpecVersion(runtimePackageName, specs[1]);
  // The first npm install may already have updated the canonical service prefix.
  // Compare the actual package pair, never just the Node executable (which can
  // be shared by an interactive NVM CLI and a separate managed-agent prefix).
  if (expectedCli && expectedRuntime && serviceInfo.cliVersion === expectedCli
    && serviceInfo.runtimeVersion === expectedRuntime) return [];
  // A legacy launcher with no npm packages recorded at its path is repaired
  // by ensureServiceIfRecorded() after the normal update. Never attempt an
  // npm write to an unrelated or unrecognizable launcher location.
  if (!serviceInfo.cliVersion && !serviceInfo.runtimeVersion) {
    try { serviceNpmPrefixFromCliPath(serviceInfo.cliPath); }
    catch { return []; }
  }
  const nodePath = String(serviceInfo.nodePath).trim();
  if (!nodePath || !fs.existsSync(nodePath)) {
    throw new Error('ReMCP update refused: managed service Node executable is missing.');
  }
  let resolvedNode = nodePath;
  try { resolvedNode = fs.realpathSync(nodePath); } catch {}
  // A legacy, manually requested @latest/custom runtime update does not give
  // us two exact versions to verify. Preserve its previous Node-manager sync
  // semantics rather than inventing a canonical package directory from a
  // mocked or pre-npm bin/remcp launcher. Automatic official updates always
  // provide BOTH exact versions and take the strict pinned-prefix path below.
  if (!expectedCli || !expectedRuntime) {
    const current = currentInstallationInfo(config);
    let currentNode = current.nodePath;
    try { currentNode = fs.realpathSync(currentNode); } catch {}
    if (resolvedNode === currentNode) return [];
    try {
      npmGlobalUpdateForNode(resolvedNode, [PACKAGE_NAME, runtimePackageName], ...specs);
      return [{ nodePath:resolvedNode, ok:true, required:true }];
    } catch (error) {
      throw new Error('Could not update legacy ReMCP service installation: ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  const prefix = serviceNpmPrefixFromCliPath(serviceInfo.cliPath);
  try {
    npmGlobalUpdateAtPrefix(resolvedNode, prefix, [PACKAGE_NAME, runtimePackageName], ...specs);
    const installed = serviceInstallationInfo(config);
    if ((expectedCli && installed.cliVersion !== expectedCli)
      || (expectedRuntime && installed.runtimeVersion !== expectedRuntime)) {
      throw new Error('npm reported success but the canonical service packages are still stale');
    }
    return [{ nodePath:resolvedNode, ok:true, required:true }];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error('Could not update canonical ReMCP service installation at ' + prefix + ': ' + message);
  }
}
