import fs from 'node:fs';
import path from 'node:path';

const CLIENT_PACKAGE = '@remcp/remcp';
const MAX_HISTORY = 32;

// Inventory only paths previously recorded by this owner and the two current CLI
// entrypoints. Never crawl npm/node directories or infer running processes.
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

export function auditKnownInstallations(config, { currentCliPath, serviceCliPath } = {}) {
  const history = Array.isArray(config?.installations) ? config.installations.slice(-MAX_HISTORY) : [];
  const candidates = [
    { path:currentCliPath, source:'invoked_cli' },
    { path:serviceCliPath, source:'managed_service' },
    ...history.map(item => ({ path:item?.cliPath, source:'saved_history' })),
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
    if (candidate.path !== installed.resolved && !aliases.some(a => a.path === candidate.path)) {
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
    scope:'recorded_paths_only',
    processConcurrency:'not_measured',
    packageCopyCount:copies.length,
    otherCopyCount:copies.filter(item => !item.isInvoked && !item.isManagedService).length,
    ignoredUnverifiedPathCount:ignoredUnverified,
    aliases,
    copies,
    removal:'disabled; explicit owner review and process/dependency audit required',
  };
}
