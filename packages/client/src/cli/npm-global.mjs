import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { resolveNpm } from '../npm.mjs';
import { PACKAGE_NAME } from '../version.mjs';
import { home, npm } from './env.mjs';
import { output, run } from './shell.mjs';

export function servicePlatform() {
  return process.env.NODE_ENV === 'test' && process.env.REMCP_TEST_PLATFORM ? process.env.REMCP_TEST_PLATFORM : process.platform;
}

export function globalPrefix() {
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
  run(npm.command, [...npm.args, ...npmGlobalInstallArgs(specs)]);
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

function transactionalWindowsGlobalInstall({ resolved, prefix, packageNames, specs, preferOnline = false }) {
  prefix = String(prefix || '').trim();
  if (!path.isAbsolute(prefix)) throw new Error(`npm global prefix must be absolute for a Windows update: ${prefix || '(empty)'}`);
  if (!isManagedWindowsRuntimePrefix(prefix)) {
    run(resolved.command, [...resolved.args, ...npmGlobalInstallArgs(specs, { preferOnline })]);
    return;
  }

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
        `ReMCP update failed and the previous Windows installation could not be fully restored: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause:originalError },
      );
    }
  };

  fs.mkdirSync(prefix, { recursive:true });
  fs.mkdirSync(backupRoot, { recursive:false, mode:0o700 });
  try {
    const uniqueNames = [...new Set(packageNames.map(name => String(name || '').trim()).filter(Boolean))];
    uniqueNames.forEach((name, index) => moveAside(globalPackagePath(prefix, name, 'win32'), `package-${index}`));
    if (uniqueNames.includes(PACKAGE_NAME)) {
      for (const shim of ['remcp', 'remcp.cmd', 'remcp.ps1']) moveAside(path.join(prefix, shim), `bin-${shim}`);
    }
    run(resolved.command, [...resolved.args, ...npmGlobalInstallArgs(specs, { preferOnline })]);
  } catch (error) {
    restore(error);
    throw error;
  }

  try {
    fs.rmSync(backupRoot, { recursive:true, force:true });
  } catch (error) {
    console.error(`ReMCP update: could not remove Windows rollback backup ${backupRoot}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Release updates use exact versions that may have been published only moments ago. npm can keep a
// cached pre-publication packument long enough to answer ETARGET after the registry already serves the
// version, so updates revalidate metadata while retaining npm's cache for package bytes.
export function npmGlobalUpdate(packageNames, ...specs) {
  const platform = servicePlatform();
  const prefix = globalPrefix();
  if (platform === 'darwin') {
    transactionalMacGlobalInstall({ resolved:npm, prefix, packageNames, specs, preferOnline:true });
    return;
  }
  if (platform === 'win32') {
    transactionalWindowsGlobalInstall({ resolved:npm, prefix, packageNames, specs, preferOnline:true });
    return;
  }
  run(npm.command, [...npm.args, ...npmGlobalInstallArgs(specs, { preferOnline:true })]);
}

export function npmGlobalUpdateForNode(nodePath, packageNames, ...specs) {
  const platform = servicePlatform();
  const resolved = resolveNpm({ nodePath, home, platform });
  const prefix = output(resolved.command, [...resolved.args, 'prefix', '--global']);
  if (platform === 'darwin') {
    transactionalMacGlobalInstall({ resolved, prefix, packageNames, specs, preferOnline:true });
    return;
  }
  if (platform === 'win32') {
    transactionalWindowsGlobalInstall({ resolved, prefix, packageNames, specs, preferOnline:true });
    return;
  }
  run(resolved.command, [...resolved.args, ...npmGlobalInstallArgs(specs, { preferOnline:true })]);
}
