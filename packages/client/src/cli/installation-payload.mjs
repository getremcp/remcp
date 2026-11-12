import fs from 'node:fs';
import path from 'node:path';
import { assertWindowsInteropPayload } from './windows-interop-payload.mjs';

// Manifests survive quarantine. Check executable payloads independently of versions.
// This is a local presence check, not an antivirus verdict or a signature check.
function ordinaryFile(file, packageRoot) {
  try {
    const relative = path.relative(packageRoot, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    let current = packageRoot;
    if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()) return false;
    const components = relative.split(path.sep);
    for (const component of components) {
      current = path.join(current, component);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return false;
    }
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.size > 0;
  } catch { return false; }
}

export function assertWindowsPackagePayload(prefix, names) {
  const entries = { '@remcp/remcp':'bin/remcp.mjs', '@remcp/runtime':'src/index.mjs' };
  for (const name of names) {
    if (!Object.hasOwn(entries, name)) continue; // custom runtimes define their own entry contract
    const root = path.join(prefix, 'node_modules', ...name.split('/'));
    assertWindowsInteropPayload(root, name);
    if (!ordinaryFile(path.join(root, entries[name]), root)) {
      throw new Error('REMCP_WINDOWS_PAYLOAD_BLOCKED: Windows package payload missing or unsafe: ' + name +
        '. Check antivirus reports; keep protection enabled. No restart was authorized.');
    }
  }
}

export function installationPayloadAtCliPath(cliPath, runtime = {}) {
  const missing = { payloadReady:false, clientEntryExists:false, runtimeEntryExists:false };
  if (!cliPath || !path.isAbsolute(cliPath)) return { ...missing, payloadReady:null };
  const marker = path.sep + 'node_modules' + path.sep;
  const index = cliPath.lastIndexOf(marker);
  const modules = index >= 0 ? cliPath.slice(0, index + marker.length - 1)
    : path.basename(cliPath).toLowerCase() === 'remcp.cmd'
      ? path.join(path.dirname(cliPath), 'node_modules') : '';
  const name = String(runtime.packageName || '');
  if (!modules) return { ...missing, payloadReady:null };
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) return missing;
  const entry = String(runtime.entry || 'src/index.mjs');
  if (path.isAbsolute(entry) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(entry)) return missing;
  const clientRoot = path.join(modules, '@remcp', 'remcp');
  const runtimeRoot = path.join(modules, ...name.split('/'));
  const clientEntryExists = ordinaryFile(path.join(clientRoot, 'bin', 'remcp.mjs'), clientRoot);
  const runtimeEntryExists = ordinaryFile(path.resolve(runtimeRoot, entry), runtimeRoot);
  return { payloadReady:clientEntryExists && runtimeEntryExists, clientEntryExists, runtimeEntryExists };
}
