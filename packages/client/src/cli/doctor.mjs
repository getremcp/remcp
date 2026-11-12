// What remcp doctor answers: whether this machine can really run a tool, and where the runtime is
// allowed to write. The checks install nothing and report the exact failing step.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { localRuntimeEntry } from '../agent.mjs';
import { npmVersion, resolveNpm } from '../npm.mjs';
import { PACKAGE_NAME, VERSION } from '../version.mjs';

import { npm, runtimeConfigFile } from './env.mjs';
import { servicePlatform } from './npm-global.mjs';

// when it really owns this process: a terminal gets an explicit instruction instead of a silent exit
// that would take the device offline.
// One real handshake with the local runtime, plus everything needed to explain a failure: where the
// entry resolved, whether the package is installed, the node that would run it, and the exact error.
// A stuck local MCP transport must not hold remcp doctor indefinitely.
export async function doctorDeadline(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Runtime diagnostic timed out after ' + timeoutMs + 'ms')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Missing files may have been quarantined. Do not recommend a blind update on
// Windows before the operator has checked the security product's event history.
export function missingRuntimeHint(platform = process.platform) {
  const repair = `npx --yes ${PACKAGE_NAME}@latest update`;
  if (platform !== 'win32') return `Reinstall with: ${repair}`;
  return 'Windows runtime missing: first inspect antivirus quarantine and package integrity. ' +
    'Keep protection enabled; do not restore flagged files or add broad exclusions. ' +
    `After the cause is verified and an approved release is available, repair with: ${repair} --repair --no-restart. Run remcp doctor before starting the bridge.`;
}

export async function diagnoseLocalRuntime(cfg) {
  const packageName = cfg.runtime?.packageName || '';
  const diagnosis = {
    platform: `${process.platform} ${process.arch}`,
    node: process.execPath,
    nodeVersion: process.versions.node,
    packageName,
    packageSpec: cfg.runtime?.packageSpec || '',
    installedRuntime: installedVersion(packageName),
    installedClient: installedVersion(PACKAGE_NAME),
  };
  const resolved = resolveNpm();
  const npmInfo = npmVersion(resolved);
  diagnosis.npm = npmInfo ? { version: npmInfo.version, source: npmInfo.source } : { error: `npm could not be executed (tried ${resolved.source})` };
  let entry = '';
  try {
    entry = localRuntimeEntry(cfg.runtime);
    diagnosis.entry = entry;
    diagnosis.entryExists = fs.existsSync(entry);
  } catch (error) {
    diagnosis.entry = null;
    diagnosis.entryExists = false;
    diagnosis.verdict = 'runtime-not-installed';
    diagnosis.error = error instanceof Error ? error.message : String(error);
    diagnosis.hint = missingRuntimeHint();
    return diagnosis;
  }
  if (!diagnosis.entryExists) {
    diagnosis.verdict = 'runtime-entry-missing';
    diagnosis.hint = missingRuntimeHint();
    return diagnosis;
  }
  try {
    const { Client } = await import('@modelcontextprotocol/client');
    const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
    const client = new Client(
      { name: 'remcp-doctor', version: VERSION },
      { versionNegotiation:{ mode:'auto' } },
    );
    // Keep runtime stderr off the inherited CLI pipe: it must not block a
    // parent test runner when a diagnostic child remains active.
    const stdio = new StdioClientTransport({
      command: process.execPath, args: [entry], env: { ...process.env },
      stderr: 'pipe', maxBufferSize: 4 * 1024 * 1024,
    });
    stdio.stderr?.on('data', () => {}); // drain; do not log potentially sensitive output
    try {
      await doctorDeadline(client.connect(stdio), 20_000);
      diagnosis.runtimeVersion = client.getServerVersion()?.version || 'unknown';
      const tools = await doctorDeadline(client.listTools(undefined, { timeout: 20_000 }), 25_000);
      diagnosis.tools = tools.tools.length;
      diagnosis.verdict = 'ok';
      return diagnosis;
    } finally {
      // Clean up even on a failed handshake. Never let close hang the doctor.
      await doctorDeadline(client.close(), 6_000).catch(() => {});
    }
  } catch (error) {
    diagnosis.verdict = 'runtime-handshake-failed';
    diagnosis.error = error instanceof Error ? error.message : String(error);
    diagnosis.hint = 'Run the entry above by hand to see its output, then reinstall with: npx --yes @remcp/remcp@latest update';
    return diagnosis;
  }
}

// Reads the version a freshly installed global package reports, so an update that installed
// nothing (wrong prefix, npm cache, permissions) is reported instead of assumed successful.
// The roots the runtime is allowed to work in, as the person configured them. An empty list means
// "the whole file system", so the doctor probes the home directory instead of guessing a root.
export function runtimeAllowedRoots() {
  try {
    const configured = JSON.parse(fs.readFileSync(runtimeConfigFile, 'utf8')).allowedRoots;
    if (Array.isArray(configured) && configured.length) return configured.map(root => String(root).replace(/^~/, os.homedir()));
  } catch {}
  return [os.homedir()];
}

// Windows global npm installs packages directly under prefix/node_modules.
// Unix global installs use prefix/lib/node_modules. Read only the selected
// package manifest; never trust a non-package name to escape the npm prefix.
export function globalPackageVersionAtPrefix(packageName, prefix, platform = servicePlatform()) {
  const name = String(packageName || '').trim();
  const parts = name.split('/');
  const valid = (parts.length === 1 && /^[a-z0-9][a-z0-9._-]*$/i.test(parts[0]))
    || (parts.length === 2 && /^@[a-z0-9][a-z0-9._-]*$/i.test(parts[0])
      && /^[a-z0-9][a-z0-9._-]*$/i.test(parts[1]));
  if (!valid || !path.isAbsolute(String(prefix || ''))) return null;
  const modules = platform === 'win32' ? ['node_modules'] : ['lib', 'node_modules'];
  const manifest = path.join(prefix, ...modules, ...parts, 'package.json');
  try {
    const version = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
    return typeof version === 'string' && version.trim() ? version : null;
  } catch { return null; }
}

export function installedVersion(packageName) {
  const prefix = spawnSync(npm.command, [...npm.args, 'prefix', '--global'], { encoding:'utf8',
    windowsHide:true, timeout:15000, maxBuffer:4096 });
  if (prefix.error || prefix.status !== 0) return null;
  return globalPackageVersionAtPrefix(packageName, String(prefix.stdout || '').trim());
}
