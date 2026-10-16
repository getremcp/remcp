import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { PACKAGE_NAME, VERSION } from '../version.mjs';
import { saveConfig } from './config.mjs';
import { linuxServiceFile, linuxServiceLauncherFile, macServiceFile, macServiceLabel, windowsTaskName } from './env.mjs';
import { servicePlatform, globalCliPath, npmGlobalUpdateForNode } from './npm-global.mjs';

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

export function canonicalServiceCliPath(config) {
  const configured = String(config?.serviceCliPath || '').trim();
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
