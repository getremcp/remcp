import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { resolveNpm } from '../npm.mjs';
import { PACKAGE_NAME } from '../version.mjs';
import { assertWindowsPackagePayload } from './installation-payload.mjs';
import { home, npm } from './env.mjs';
import { buildVettedMacTemperatureAddon } from './mac-native-temperature.mjs';
import { output, run } from './shell.mjs';
import { withWindowsUpdateLock } from './windows-update-lock.mjs';
import { assertWindowsNpmPowerShellShimOwned, preferWindowsCmdShim } from './windows-cli-shim.mjs';

export function servicePlatform() {
  return process.env.NODE_ENV === 'test' && process.env.REMCP_TEST_PLATFORM ? process.env.REMCP_TEST_PLATFORM : process.platform;
}

export function assertSafeReMcpNpmPrefix(value) {
  const prefix = String(value || '').trim();
  if (!path.isAbsolute(prefix)) throw new Error('ReMCP update refused: npm global prefix must be an absolute directory.');
  const normalized = path.resolve(prefix);
  const parts = normalized.split(path.sep).filter(Boolean);
  // An inherited NPM_CONFIG_PREFIX aimed inside an already-installed package creates a
  // second copy in its lib/node_modules. npm then reports success but systemd still starts
  // the old agent, causing endless replacement attempts and offline device flapping.
  for (let index = 0; index < parts.length - 2; index += 1) {
    if (parts[index] === 'node_modules' && parts[index + 1] === '@remcp'
      && (parts[index + 2] === 'remcp' || parts[index + 2] === 'runtime')) {
      throw new Error('ReMCP update refused: npm prefix points inside a ReMCP package. Repair the service launcher before retrying.');
    }
  }
  return normalized;
}

export function globalPrefix() {
  // Read-only diagnostics must work even when a legacy launcher exports a broken prefix.
  // Validate only at installation/update write boundaries, not while discovering paths.
  return output(npm.command, [...npm.args, 'prefix', '--global']);
}

export function globalCliPath() {
  const prefix = globalPrefix();
  return servicePlatform() === 'win32' ? path.join(prefix, 'remcp.cmd') : path.join(prefix, 'bin', 'remcp');
}

function npmGlobalInstallArgs(specs, { preferOnline = false } = {}) {
  return [
    'install',
    '--global',
    ...specs,
    ...(preferOnline ? ['--prefer-online'] : []),
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    '--loglevel=error',
  ];
}

export function npmGlobalInstall(...specs) {
  const prefix = assertSafeReMcpNpmPrefix(globalPrefix()); // Reject an unsafe prefix before npm writes anything.
  const install = () => {
    const updatingClient = servicePlatform() === 'win32' && isManagedWindowsRuntimePrefix(prefix)
      && specs.some(spec => /^@remcp\/remcp@/.test(spec));
    // A custom remcp.ps1 must be refused BEFORE npm overwrites its contents.
    if (updatingClient) assertWindowsNpmPowerShellShimOwned(prefix);
    run(npm.command, [...npm.args, ...npmGlobalInstallArgs(specs)]);
    if (updatingClient) preferWindowsCmdShim(prefix);
  };
  if (servicePlatform() === 'win32') withWindowsUpdateLock(prefix, install);
  else install();
  if (servicePlatform() === 'darwin' && specs.some(spec => /^@remcp\/runtime@[0-9]/.test(spec))) {
    try {
      buildVettedMacTemperatureAddon({
        runtimeRoot:globalPackagePath(globalPrefix(), '@remcp/runtime'), resolved:npm, runCommand:run,
      });
    } catch {
      // Native temperature is optional; a second prefix lookup cannot undo a successful CLI install.
      console.error('ReMCP: optional macOS temperature sensor unavailable; other tools remain functional.');
    }
  }
}

// Called only by the post-start macOS helper: an older updater may have
// installed this version while leaving the optional native binary missing.
// The same version-pinned, path-checked installer is reused; no npm install
// or arbitrary dependency lifecycle scripts are permitted.
export function repairMacTemperatureAfterStart(runtimePackageName) {
  if (servicePlatform() !== 'darwin' || runtimePackageName !== '@remcp/runtime') return false;
  try {
    return buildVettedMacTemperatureAddon({
      runtimeRoot:globalPackagePath(assertSafeReMcpNpmPrefix(globalPrefix()), '@remcp/runtime'),
      resolved:npm, runCommand:run,
    });
  } catch {
    console.error('ReMCP: optional macOS temperature sensor unavailable; other tools remain functional.');
    return false;
  }
}

function pathEntryExists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function globalPackagePath(prefix, packageName, platform = servicePlatform()) {
  const name = String(packageName || '').trim();
  const parts = name.split('/');
  const validUnscoped = parts.length === 1 && parts[0] && !parts[0].startsWith('@') && parts[0] !== '.' && parts[0] !== '..';
  const validScoped = parts.length === 2 && /^@[^/]+$/.test(parts[0]) && parts[1] && parts[1] !== '.' && parts[1] !== '..';
  if (!validUnscoped && !validScoped) throw new Error(`Invalid npm package name for update: ${name || '(empty)'}`);
  const modulesRoot = platform === 'win32'
    ? path.join(prefix, 'node_modules')
    : path.join(prefix, 'lib', 'node_modules');
  return path.join(modulesRoot, ...parts);
}

function managedWindowsRuntimePrefix() {
  return path.resolve(
    process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
    'ReMCP',
    'runtime',
  );
}

function isManagedWindowsRuntimePrefix(prefix) {
  const actual = path.resolve(String(prefix || ''));
  const expected = managedWindowsRuntimePrefix();
  return actual.toLowerCase() === expected.toLowerCase();
}

function transactionalMacGlobalInstall({ resolved, prefix, packageNames, specs, preferOnline = false }) {
  prefix = String(prefix || '').trim();
  if (!path.isAbsolute(prefix)) throw new Error(`npm global prefix must be absolute for a macOS update: ${prefix || '(empty)'}`);
  const backupRoot = path.join(prefix, `.remcp-update-backup-${process.pid}-${Date.now()}`);
  const moved = [];
  const moveAside = (source, label) => {
    if (!pathEntryExists(source)) return;
    const backup = path.join(backupRoot, label);
    fs.renameSync(source, backup);
    moved.push({ source, backup });
  };
  const restore = originalError => {
    let rollbackError = null;
    for (const item of [...moved].reverse()) {
      try {
        if (pathEntryExists(item.source)) fs.rmSync(item.source, { recursive:true, force:true });
        fs.mkdirSync(path.dirname(item.source), { recursive:true });
        fs.renameSync(item.backup, item.source);
      } catch (error) {
        rollbackError ??= error;
      }
    }
    try { fs.rmSync(backupRoot, { recursive:true, force:true }); } catch (error) { rollbackError ??= error; }
    if (rollbackError) {
      throw new Error(
        `ReMCP update failed and the previous macOS installation could not be fully restored: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause:originalError },
      );
    }
  };

  fs.mkdirSync(prefix, { recursive:true });
  fs.mkdirSync(backupRoot, { recursive:false, mode:0o700 });
  try {
    const uniqueNames = [...new Set(packageNames.map(name => String(name || '').trim()).filter(Boolean))];
    uniqueNames.forEach((name, index) => moveAside(globalPackagePath(prefix, name), `package-${index}`));
    if (uniqueNames.includes(PACKAGE_NAME)) moveAside(path.join(prefix, 'bin', 'remcp'), 'bin-remcp');

    run(resolved.command, [...resolved.args, ...npmGlobalInstallArgs(specs, { preferOnline })]);
    if (uniqueNames.includes('@remcp/runtime')) buildVettedMacTemperatureAddon({
      runtimeRoot:globalPackagePath(prefix, '@remcp/runtime'), resolved, runCommand:run,
    });
  } catch (error) {
    restore(error);
    throw error;
  }

  try {
    fs.rmSync(backupRoot, { recursive:true, force:true });
  } catch (error) {
    console.error(`ReMCP update: could not remove macOS rollback backup ${backupRoot}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Fetch and validate a complete release in a private npm prefix before touching
// live Windows shims/packages. Crash during a registry download must not leave
// remcp.cmd and the live agent missing.
function stageWindowsGlobalInstall({ resolved, prefix, packageNames, specs, preferOnline }) {
  const root = path.join(prefix, `.remcp-update-stage-${process.pid}-${Date.now()}`);
  fs.mkdirSync(root, { recursive:false, mode:0o700 });
  try {
    // This explicit final --prefix overrides an inherited NPM_CONFIG_PREFIX and
    // a service-pinned --prefix argument without changing their configurations.
    run(resolved.command, [...resolved.args, '--prefix', root,
      ...npmGlobalInstallArgs(specs, { preferOnline })]);
    const names = [...new Set(packageNames)];
    for (const name of names) {
      const directory = globalPackagePath(root, name, 'win32');
      const metadata = fs.lstatSync(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error('Windows staged update package is not an ordinary directory: ' + name);
      }
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      const exact = specs.find(spec => String(spec).startsWith(name + '@'))?.slice(name.length + 1);
      if (manifest.name !== name || typeof manifest.version !== 'string' ||
        !manifest.version || (exact && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(exact) && manifest.version !== exact)) {
        throw new Error('Windows staged update package identity or version mismatch: ' + name);
      }
    }

    assertWindowsPackagePayload(root, names);

    // npm hoists global dependencies. Refuse a promotion that would require
    // silently replacing unrelated packages, npm itself, or shared dependencies.
    // A release with dependency changes needs a separately reviewed migration.
    const stageModules = path.join(root, 'node_modules');
    const liveModules = path.join(prefix, 'node_modules');
    const checkShared = relative => {
      const named = relative.split(path.sep).join('/');
      if (names.includes(named)) return;
      const staged = JSON.parse(fs.readFileSync(path.join(stageModules, relative, 'package.json'), 'utf8'));
      const live = JSON.parse(fs.readFileSync(path.join(liveModules, relative, 'package.json'), 'utf8'));
      if (staged.name !== live.name || staged.version !== live.version) {
        throw new Error('Windows staged release changes a shared npm dependency: ' + named);
      }
    };
    for (const entry of fs.readdirSync(stageModules, { withFileTypes:true })) {
      if (entry.name.startsWith('.') || entry.name === '.bin') continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unexpected staged npm entry');
      if (entry.name.startsWith('@')) {
        for (const scoped of fs.readdirSync(path.join(stageModules, entry.name), { withFileTypes:true })) {
          if (!scoped.isDirectory() || scoped.isSymbolicLink()) throw new Error('Unexpected staged scoped package');
          checkShared(path.join(entry.name, scoped.name));
        }
      } else checkShared(entry.name);
    }
    if (names.includes(PACKAGE_NAME)) {
      const cmd = path.join(root, 'remcp.cmd');
      const metadata = fs.lstatSync(cmd);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Windows staged remcp.cmd is missing');
      // Any generated PowerShell shim must be npm-owned, not a custom script.
      assertWindowsNpmPowerShellShimOwned(root);
    }
    return root;
  } catch (error) {
    try { fs.rmSync(root, { recursive:true, force:true }); }
    catch (cleanupError) { console.error('ReMCP staged npm cleanup failed:', cleanupError?.message); }
    throw error;
  }
}

function transactionalWindowsGlobalInstall({ resolved, prefix, packageNames, specs, preferOnline = false }) {
  prefix = String(prefix || '').trim();
  if (!path.isAbsolute(prefix)) throw new Error(`npm global prefix must be absolute for a Windows update: ${prefix || '(empty)'}`);
  if (!isManagedWindowsRuntimePrefix(prefix)) {
    run(resolved.command, [...resolved.args, ...npmGlobalInstallArgs(specs, { preferOnline })]);
    return;
  }

  // Do not remove the live package or shims during network downloads.
  // The complete replacement must pass local verification before promotion.
  if (packageNames.includes(PACKAGE_NAME)) assertWindowsNpmPowerShellShimOwned(prefix);
  fs.mkdirSync(prefix, { recursive:true });
  const uniqueNames = [...new Set(packageNames.map(name => String(name || '').trim()).filter(Boolean))];
  const stagedRoot = stageWindowsGlobalInstall({ resolved, prefix, packageNames:uniqueNames, specs, preferOnline });
  const backupRoot = path.join(prefix, `.remcp-update-backup-${process.pid}-${Date.now()}`);
  const moved = [];
  const promoted = [];
  const moveAside = (source, label) => {
    if (!pathEntryExists(source)) return;
    const backup = path.join(backupRoot, label);
    fs.renameSync(source, backup);
    moved.push({ source, backup });
  };
  const promote = (source, target) => {
    if (!pathEntryExists(source)) return;
    if (pathEntryExists(target)) throw new Error('Windows update refused to overwrite an unexpected npm entry');
    fs.mkdirSync(path.dirname(target), { recursive:true });
    fs.renameSync(source, target);
    promoted.push(target);
  };
  const rollback = originalError => {
    let rollbackError = null;
    for (const target of [...promoted].reverse()) {
      try { if (pathEntryExists(target)) fs.rmSync(target, { recursive:true, force:true }); }
      catch (error) { rollbackError ??= error; }
    }
    for (const item of [...moved].reverse()) {
      try {
        if (pathEntryExists(item.source)) throw new Error('Unexpected replacement in Windows rollback destination');
        fs.mkdirSync(path.dirname(item.source), { recursive:true });
        fs.renameSync(item.backup, item.source);
      } catch (error) { rollbackError ??= error; }
    }
    if (rollbackError) {
      // On any rollback error retain the only copies of the original files.
      throw new Error(
        `ReMCP Windows update requires manual recovery; original backup preserved at ${backupRoot}: ${rollbackError.message}`,
        { cause:originalError },
      );
    }
    try { fs.rmSync(backupRoot, { recursive:true, force:true }); }
    catch (error) { console.error('Could not remove restored Windows backup:', error?.message); }
  };

  try {
    fs.mkdirSync(backupRoot, { recursive:false, mode:0o700 });
    uniqueNames.forEach((name, index) => moveAside(globalPackagePath(prefix, name, 'win32'), `package-${index}`));
    if (uniqueNames.includes(PACKAGE_NAME)) {
      for (const shim of ['remcp', 'remcp.cmd', 'remcp.ps1']) {
        moveAside(path.join(prefix, shim), `bin-${shim}`);
      }
    }
    for (const name of uniqueNames) {
      promote(globalPackagePath(stagedRoot, name, 'win32'), globalPackagePath(prefix, name, 'win32'));
    }
    if (uniqueNames.includes(PACKAGE_NAME)) {
      for (const shim of ['remcp', 'remcp.cmd', 'remcp.ps1']) {
        promote(path.join(stagedRoot, shim), path.join(prefix, shim));
      }
      preferWindowsCmdShim(prefix);
    }
    // Real-time protection may remove a file between staging and promotion.
    // Reject before discarding the previous installation or restarting a service.
    assertWindowsPackagePayload(prefix, uniqueNames);
  } catch (error) {
    if (moved.length || promoted.length) rollback(error);
    else if (pathEntryExists(backupRoot)) {
      try { fs.rmSync(backupRoot, { recursive:true, force:true }); }
      catch (cleanupError) { console.error('Windows empty backup cleanup failed:', cleanupError?.message); }
    }
    throw error;
  } finally {
    try { fs.rmSync(stagedRoot, { recursive:true, force:true }); }
    catch (cleanupError) { console.error('Windows staged npm cleanup failed:', cleanupError?.message); }
  }
  try { fs.rmSync(backupRoot, { recursive:true, force:true }); }
  catch (error) { console.error('ReMCP Windows backup cleanup failed:', error?.message); }
}

// Release updates use exact versions that may have been published only moments ago. npm can keep a
// cached pre-publication packument long enough to answer ETARGET after the registry already serves the
// version, so updates revalidate metadata while retaining npm's cache for package bytes.
export function npmGlobalUpdate(packageNames, ...specs) {
  const platform = servicePlatform();
  const prefix = assertSafeReMcpNpmPrefix(globalPrefix());
  if (platform === 'darwin') {
    transactionalMacGlobalInstall({ resolved:npm, prefix, packageNames, specs, preferOnline:true });
    return;
  }
  if (platform === 'win32') {
    withWindowsUpdateLock(prefix, () => transactionalWindowsGlobalInstall({ resolved:npm, prefix, packageNames, specs, preferOnline:true }));
    return;
  }
  run(npm.command, [...npm.args, ...npmGlobalInstallArgs(specs, { preferOnline:true })]);
}

// The service launcher may use the SAME Node executable as the interactive CLI,
// yet install into a different npm prefix (e.g. NVM vs managed-agent). Pin the
// destination explicitly, rather than asking that Node's default npm prefix.
export function npmGlobalUpdateAtPrefix(nodePath, servicePrefix, packageNames, ...specs) {
  const platform = servicePlatform();
  const prefix = assertSafeReMcpNpmPrefix(servicePrefix);
  const resolved = resolveNpm({ nodePath, home, platform });
  const pinned = { ...resolved, args:[...resolved.args, '--prefix', prefix] };
  if (platform === 'darwin') {
    transactionalMacGlobalInstall({ resolved:pinned, prefix, packageNames, specs, preferOnline:true });
    return;
  }
  if (platform === 'win32') {
    withWindowsUpdateLock(prefix, () => transactionalWindowsGlobalInstall({ resolved:pinned, prefix, packageNames, specs, preferOnline:true }));
    return;
  }
  run(pinned.command, [...pinned.args, ...npmGlobalInstallArgs(specs, { preferOnline:true })]);
}

export function npmGlobalUpdateForNode(nodePath, packageNames, ...specs) {
  const platform = servicePlatform();
  const resolved = resolveNpm({ nodePath, home, platform });
  const prefix = assertSafeReMcpNpmPrefix(output(resolved.command, [...resolved.args, 'prefix', '--global']));
  if (platform === 'darwin') {
    transactionalMacGlobalInstall({ resolved, prefix, packageNames, specs, preferOnline:true });
    return;
  }
  if (platform === 'win32') {
    withWindowsUpdateLock(prefix, () => transactionalWindowsGlobalInstall({ resolved, prefix, packageNames, specs, preferOnline:true }));
    return;
  }
  run(resolved.command, [...resolved.args, ...npmGlobalInstallArgs(specs, { preferOnline:true })]);
}
