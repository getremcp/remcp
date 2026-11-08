// Linux headless agents may be supervised by PID 1. Never mistake a system unit for
// a session-owned user unit during status checks, repairs or auto-updates.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { home, linuxServiceFile, linuxServiceLauncherFile } from './env.mjs';
import { resolvedCliScript, shellQuote } from './service-paths.mjs';

export const linuxSystemServiceFile = '/etc/systemd/system/remcp-agent.service';

export function isManagedLinuxSystemUnit(text, launcher = linuxServiceLauncherFile) {
  if (typeof text !== 'string') return false;
  const expected = new Set([
    'ExecStart="' + launcher.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '" start --service',
    'ExecStart=' + launcher + ' start --service',
  ]);
  return text.split(/\r?\n/).some(line => expected.has(line.trim()));
}

export function linuxSystemAgentOwned() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return false;
  try {
    return isManagedLinuxSystemUnit(fs.readFileSync(linuxSystemServiceFile, 'utf8'));
  } catch {
    return false;
  }
}

export function linuxServiceScope() {
  return linuxSystemAgentOwned() ? 'system' : 'user';
}

export function linuxActiveServiceFile() {
  return linuxServiceScope() === 'system' ? linuxSystemServiceFile : linuxServiceFile;
}

// Without linger, logind terminates user@UID.service at the final logout,
// even if systemctl --user enable --now reported success.
export function ensureLinuxLinger() {
  if (process.platform !== 'linux') return;
  // Test-only synthetic HOME has no logind account and must never mutate the host.
  // Guard before os.userInfo(): an isolated CI UID may not have a passwd entry.
  if (process.env.NODE_ENV === 'test' && process.env.REMCP_TEST_PLATFORM === 'linux') return;
  let account;
  try { account = os.userInfo(); }
  catch { throw new Error('ReMCP cannot resolve the current Linux account for persistent systemd supervision.'); }
  if (path.resolve(home) !== path.resolve(account.homedir)) {
    throw new Error('Refusing a persistent Linux service with HOME different from the account home directory.');
  }
  const username = account.username;
  const query = () => spawnSync('loginctl', ['show-user', username, '-p', 'Linger', '--value'],
    { encoding:'utf8', timeout:10000 });
  let state = query();
  if (state.status === 0 && state.stdout.trim() === 'yes') return;
  const enabled = spawnSync('loginctl', ['enable-linger', username],
    { encoding:'utf8', timeout:10000 });
  if (enabled.status !== 0) {
    throw new Error('ReMCP cannot guarantee background operation after logout: '
      + 'loginctl enable-linger failed. Ask an administrator to enable lingering for this account.');
  }
  state = query();
  if (state.status !== 0 || state.stdout.trim() !== 'yes') {
    throw new Error('ReMCP cannot verify systemd lingering; refusing to claim persistent installation.');
  }
}

// The vetted bootstrap may install npm under ~/.local/share/remcp/npm and Node
// under ~/.local/share/remcp/bootstrap; neither bin is necessarily on login PATH.
export function linuxCliShimText(cliPath, nodePath) {
  const entry = resolvedCliScript(cliPath);
  const suffix = path.join('lib', 'node_modules', '@remcp', 'remcp', 'bin', 'remcp.mjs');
  const prefix = entry.endsWith(path.sep + suffix)
    ? entry.slice(0, -(suffix.length + 1)) : path.dirname(path.dirname(cliPath));
  return '#!/bin/sh\n# ReMCP managed CLI shim\nNPM_CONFIG_PREFIX=' + shellQuote(prefix)
    + '\nexport NPM_CONFIG_PREFIX\nPATH=' + shellQuote(path.dirname(nodePath)) + ':$PATH'
    + '\nexport PATH\nexec ' + shellQuote(nodePath) + ' ' + shellQuote(entry) + ' "$@"\n';
}

export function ensureLinuxCliCommand(cliPath, nodePath) {
  if (process.platform !== 'linux') return;
  const destination = process.getuid?.() === 0
    ? '/usr/local/bin/remcp' : path.join(home, '.local', 'bin', 'remcp');
  fs.mkdirSync(path.dirname(destination), { recursive:true, mode:0o755 });
  const marker = '# ReMCP managed CLI shim';
  if (fs.existsSync(destination)) {
    const current = fs.readFileSync(destination, 'utf8');
    if (!current.includes(marker)) return; // Never overwrite an unrelated executable.
  }
  const content = linuxCliShimText(cliPath, nodePath);
  const temp = destination + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, content, { mode:0o755 });
  fs.renameSync(temp, destination);
}
