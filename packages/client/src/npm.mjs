import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

// A background service does not inherit the PATH a terminal has: a launchd agent, a systemd unit and
// a Windows scheduled task all start with a minimal environment where `npm` is often not on PATH at
// all. That is how auto-update silently stopped working on macOS — the agent looked for `npm`, did
// not find it, and told the user to run the command by hand.
//
// npm is a JavaScript entry point, so the reliable answer is to run it with the same node that is
// already executing us, and only fall back to a PATH lookup. The resolver also accepts an explicit
// override (REMCP_NPM) for unusual installations.
const NPM_CLI_RELATIVE = ['lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'];

export function npmCandidates({ nodePath = process.execPath, home = os.homedir(), platform = process.platform } = {}) {
  const nodeDir = path.dirname(nodePath);
  const cli = [];
  // nvm, n, the official installer and the Docker image all place npm beside node like this.
  cli.push(path.join(nodeDir, '..', NPM_CLI_RELATIVE.join(path.sep)));
  cli.push(path.join(nodeDir, NPM_CLI_RELATIVE.join(path.sep)));
  if (platform === 'darwin') {
    cli.push(path.join('/opt/homebrew', NPM_CLI_RELATIVE.join(path.sep)));
    cli.push(path.join('/usr/local', NPM_CLI_RELATIVE.join(path.sep)));
  } else if (platform === 'win32') {
    cli.push(path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  } else {
    cli.push(path.join('/usr', NPM_CLI_RELATIVE.join(path.sep)));
    cli.push(path.join('/usr/local', NPM_CLI_RELATIVE.join(path.sep)));
  }
  cli.push(path.join(home, '.local', NPM_CLI_RELATIVE.join(path.sep)));
  const binaries = [
    path.join(nodeDir, platform === 'win32' ? 'npm.cmd' : 'npm'),
    path.join(nodeDir, '..', 'bin', platform === 'win32' ? 'npm.cmd' : 'npm'),
    platform === 'darwin' ? '/opt/homebrew/bin/npm' : '',
    platform === 'win32' ? '' : '/usr/local/bin/npm',
    platform === 'win32' ? '' : '/usr/bin/npm',
    platform === 'win32' ? '' : path.join(home, '.local', 'bin', 'npm'),
  ].filter(Boolean);
  return { cli: [...new Set(cli)], binaries: [...new Set(binaries)] };
}

// Resolves how to run npm. `source` is reported by `remcp doctor` and logged at agent startup so a
// machine where npm cannot be found is obvious before an update is needed.
//
// `exists` is injectable so a test can describe a machine with no npm at all instead of asking the
// machine running the test: the Linux candidate list carries fixed prefixes (/usr, /usr/local) that
// a CI runner or a developer laptop usually does have, which made that case untestable there.
export function resolveNpm({ nodePath = process.execPath, home = os.homedir(), platform = process.platform, exists = existsSync } = {}) {
  const override = String(process.env.REMCP_NPM || '').trim();
  if (override) return { command: override, args: [], source: `REMCP_NPM=${override}` };
  const { cli, binaries } = npmCandidates({ nodePath, home, platform });
  for (const candidate of cli) {
    if (exists(candidate)) return { command: nodePath, args: [candidate], source: `node ${candidate}` };
  }
  for (const candidate of binaries) {
    if (exists(candidate)) return { command: candidate, args: [], source: candidate };
  }
  return { command: platform === 'win32' ? 'npm.cmd' : 'npm', args: [], source: 'PATH' };
}

// The version npm itself reports, or null when it cannot be executed at all.
export function npmVersion(resolved = resolveNpm()) {
  const result = spawnSync(resolved.command, [...resolved.args, '--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (result.error || result.status !== 0) {
    // A login shell may still find npm (nvm and Homebrew write their PATH into the profile).
    const shell = process.platform === 'win32' ? null : spawnSync('/bin/sh', ['-lc', 'command -v npm'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const found = String(shell?.stdout || '').trim().split('\n').pop();
    if (found && existsSync(found)) {
      const retry = spawnSync(found, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      if (!retry.error && retry.status === 0) return { version: String(retry.stdout).trim(), source: found };
    }
    return null;
  }
  return { version: String(result.stdout).trim(), source: resolved.source };
}

// Runs npm with the resolved command, so callers never depend on PATH.
export function npmRun(args, { encoding = 'utf8', stdio = 'inherit' } = {}) {
  const resolved = resolveNpm();
  return spawnSync(resolved.command, [...resolved.args, ...args], { encoding, stdio, windowsHide: true });
}
