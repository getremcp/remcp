import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLIENT_PACKAGE = '@remcp/remcp';
const MAX_HISTORY = 32;

function isExplicitCliAlias(cliPath) {
  // A symlink in an ancestor directory (e.g. macOS /var -> /private/var)
  // changes realpath but does not make the final CLI entry itself an alias.
  // lstat checks the final path component without following that entry.
  try { return fs.lstatSync(cliPath).isSymbolicLink(); }
  catch { return false; } // A concurrently removed entry cannot be trusted.
}

// Only inspect the known owner paths and a bounded, literal NVM version directory.
// This detects dormant CLI copies even when old NVM bin symlinks were replaced.
// It never crawls arbitrary npm caches or treats package copies as running agents.
function nvmPackageEntries(homeDir) {
  const versionDir = path.join(homeDir, '.nvm', 'versions', 'node');
  let versions;
  try { versions = fs.readdirSync(versionDir, { withFileTypes:true }); }
  catch { return []; }
  return versions
    .filter(item => item.isDirectory() && /^v\d+\.\d+\.\d+$/.test(item.name))
    .slice(0, 32)
    .map(item => ({ path:path.join(versionDir, item.name, 'lib', 'node_modules',
      '@remcp', 'remcp', 'bin', 'remcp.mjs'), source:'nvm_version' }));
}

export function knownInstallationVersionHealth(audit, { clientVersion, runtimeVersion } = {}) {
  // An npx cache is not an installed shell command. Keep it visible to doctor,
  // but do not allow its lifetime to turn a healthy installation into an incident.
  const installed = (audit?.copies || []).filter(copy => copy.kind !== 'npx_cache');
  const outdated = installed.filter(copy => copy.version !== clientVersion
    || (runtimeVersion && copy.runtimeVersion && copy.runtimeVersion !== runtimeVersion));
  return {
    consistent: outdated.length === 0,
    outdatedPackageCopies: outdated.length,
    // Do not include local filesystem paths in the concise status response.
    outdatedVersions: [...new Set(outdated.map(copy => copy.version))],
  };
}

export function summarizeUpdateInstallations(audit, {
  clientVersion, runtimeVersion, serviceCliVersion, serviceRuntimeVersion, firstParty,
} = {}) {
  const known = knownInstallationVersionHealth(audit, {
    clientVersion, runtimeVersion:firstParty ? clientVersion : null,
  });
  const cli = [clientVersion, serviceCliVersion].filter(Boolean);
  const runtime = [runtimeVersion, serviceRuntimeVersion].filter(Boolean);
  const activeVersionConsistent = firstParty
    ? new Set([...cli, ...runtime]).size <= 1
    : new Set(cli).size <= 1 && new Set(runtime).size <= 1;
  return {
    activeVersionConsistent,
    knownInstallationsConsistent:known.consistent,
    versionConsistent:activeVersionConsistent && known.consistent,
    outdatedKnownPackageCopies:known.outdatedPackageCopies,
    outdatedKnownVersions:known.outdatedVersions,
  };
}

function installedPackageAt(cliPath) {
  if (typeof cliPath !== 'string' || !cliPath.trim() || !fs.existsSync(cliPath)) return null;
  let resolved;
  try { resolved = fs.realpathSync(cliPath); } catch { return null; }
  const normalized = resolved.replaceAll('\\', '/');
  const marker = '/node_modules/@remcp/remcp/';
  const markerAt = normalized.lastIndexOf(marker);
  let root = markerAt < 0 ? null : resolved.slice(0, markerAt + marker.length - 1);
  // npm on Windows uses a .cmd shim in the global prefix instead of a link.
  if (!root && path.basename(resolved).toLowerCase() === 'remcp.cmd') {
    root = path.join(path.dirname(resolved), 'node_modules', '@remcp', 'remcp');
  }
  if (!root) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (manifest.name !== CLIENT_PACKAGE || typeof manifest.version !== 'string') return null;
    let runtimeVersion = null;
    try {
      const runtime = JSON.parse(fs.readFileSync(path.join(root, '..', 'runtime', 'package.json'), 'utf8'));
      if (runtime.name === '@remcp/runtime' && typeof runtime.version === 'string') runtimeVersion = runtime.version;
    } catch {}
    return { root:fs.realpathSync(root), resolved, version:manifest.version, runtimeVersion };
  } catch { return null; }
}

export function auditKnownInstallations(config, {
  currentCliPath, serviceCliPath, scanNvm = false, nvmHome = process.env.HOME || os.homedir(),
} = {}) {
  const history = Array.isArray(config?.installations) ? config.installations.slice(-MAX_HISTORY) : [];
  const candidates = [
    { path:currentCliPath, source:'invoked_cli' },
    { path:serviceCliPath, source:'managed_service' },
    ...history.map(item => ({ path:item?.cliPath, source:'saved_history' })),
    ...(scanNvm ? nvmPackageEntries(nvmHome) : []),
  ];
  const packages = new Map();
  const aliases = [];
  let ignoredUnverified = 0;
  for (const candidate of candidates) {
    if (typeof candidate.path !== 'string' || !candidate.path.trim() || !fs.existsSync(candidate.path)) continue;
    const installed = installedPackageAt(candidate.path);
    if (!installed) { ignoredUnverified++; continue; }
    let copy = packages.get(installed.root);
    if (!copy) {
      copy = { packageRoot:installed.root, version:installed.version, runtimeVersion:installed.runtimeVersion, sources:new Set(), cliPaths:new Set() };
      packages.set(installed.root, copy);
    }
    copy.sources.add(candidate.source);
    copy.cliPaths.add(candidate.path);
    if (isExplicitCliAlias(candidate.path) && !aliases.some(a => a.path === candidate.path)) {
      aliases.push({ path:candidate.path, resolvesTo:installed.resolved });
    }
  }
  const copies = [...packages.values()].map(item => ({
    packageRoot:item.packageRoot,
    version:item.version,
    runtimeVersion:item.runtimeVersion,
    sources:[...item.sources],
    kind:item.packageRoot.replaceAll('\\', '/').includes('/_npx/') ? 'npx_cache' : 'npm_package',
    isInvoked:item.sources.has('invoked_cli'),
    isManagedService:item.sources.has('managed_service'),
    cliPaths:[...item.cliPaths],
  }));
  return {
    scope:'recorded_paths_and_bounded_nvm',
    processConcurrency:'not_measured',
    packageCopyCount:copies.length,
    otherCopyCount:copies.filter(item => !item.isInvoked && !item.isManagedService).length,
    ignoredUnverifiedPathCount:ignoredUnverified,
    aliases,
    copies,
    removal:'disabled; explicit owner review and process/dependency audit required',
  };
}
