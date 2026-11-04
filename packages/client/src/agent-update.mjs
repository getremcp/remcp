import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveNpm } from './npm.mjs';
import { isRuntimeSpecFor, normalizeRuntime } from './runtime.mjs';
import { PACKAGE_NAME, VERSION } from './version.mjs';

const npm = resolveNpm();
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_CLI_ENTRY = path.join(PACKAGE_ROOT, 'bin', 'remcp.mjs');
const PACKAGE_MANIFEST = path.join(PACKAGE_ROOT, 'package.json');

function packageLocalNodeModules() {
  const marker = `${path.sep}node_modules${path.sep}`;
  const index = PACKAGE_ROOT.lastIndexOf(marker);
  if (index < 0) return null;
  return PACKAGE_ROOT.slice(0, index + `${path.sep}node_modules`.length);
}

// How long a handing-over agent waits for its replacement to take the device over before it keeps
// running itself. Long enough for a fresh process to connect and be registered.
const REPLACEMENT_HANDOVER_TIMEOUT_MS = 20_000;

function globalNodeModules() {
  const result = spawnSync(npm.command, [...npm.args, 'root', '--global'], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Could not locate the global npm modules directory');
  return String(result.stdout || '').trim();
}

function resolveRuntimeEntry(base, runtime) {
  const packageRoot = path.resolve(base, ...runtime.packageName.split('/'));
  const candidate = path.resolve(packageRoot, ...runtime.entry.split(/[\\/]+/));
  const relative = path.relative(packageRoot, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Runtime entry resolves outside its package');
  if (!existsSync(candidate)) return null;
  const realPackageRoot = realpathSync(packageRoot);
  const realCandidate = realpathSync(candidate);
  const realRelative = path.relative(realPackageRoot, realCandidate);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative) || !lstatSync(realCandidate).isFile()) throw new Error('Runtime entry is not a regular package file');
  return realCandidate;
}

export function localRuntimeEntry(runtimeValue) {
  const runtime = normalizeRuntime(runtimeValue);
  const localModules = packageLocalNodeModules();
  if (localModules) {
    const sibling = resolveRuntimeEntry(localModules, runtime);
    if (sibling) return sibling;
  }
  const candidate = resolveRuntimeEntry(globalNodeModules(), runtime);
  if (!candidate) throw new Error('ReMCP local runtime is not installed. Run `remcp install`.');
  return candidate;
}

function parseVersion(value) {
  // Prerelease and build metadata are kept, because comparing only the numeric core made
  // 1.0.0 look newer than 1.0.0-beta.2 and left a machine stuck on the prerelease forever.
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  return match ? { parts: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] || '' } : null;
}

export function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] > b.parts[index]) return true;
    if (a.parts[index] < b.parts[index]) return false;
  }
  // Same numeric core: a release is newer than a prerelease, and two prereleases compare by
  // identifier (numeric identifiers order numerically, as semver requires).
  if (!a.prerelease && b.prerelease) return true;
  if (a.prerelease && !b.prerelease) return false;
  if (!a.prerelease && !b.prerelease) return false;
  const left = a.prerelease.split('.');
  const right = b.prerelease.split('.');
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const one = left[index];
    const two = right[index];
    if (one === undefined) return false;
    if (two === undefined) return true;
    if (one === two) continue;
    const oneNumeric = /^\d+$/.test(one);
    const twoNumeric = /^\d+$/.test(two);
    if (oneNumeric && twoNumeric) return Number(one) > Number(two);
    if (oneNumeric !== twoNumeric) return oneNumeric;
    return one > two;
  }
  return false;
}

export function updateInvocationArgs({ target, runtime }, trustRuntime = false) {
  return [
    'update',
    ...(trustRuntime ? ['--trust-runtime'] : []),
    ...(target ? ['--client', target] : []),
    ...(runtime ? ['--runtime', runtime] : []),
  ];
}

// What the agent should install, if anything. The client version alone is not enough: a machine
// that already runs the newest client but an older local runtime would otherwise never catch up,
// because its runtime is what executes the tools.
export function updateDecision({ advertised, cliVersion, runtimeVersion, runtimePackageName, runtimeDown = false }) {
  const advertisedCli = String(advertised?.cli || '');
  const advertisedRuntime = String(advertised?.runtime || '');
  // Only exact versions of the first-party client and the configured runtime package may cross
  // from server metadata into the updater. Invalid specs are ignored instead of being handed to npm.
  const cliSpec = advertisedCli && isRuntimeSpecFor(PACKAGE_NAME, advertisedCli) ? advertisedCli : '';
  const runtimeSpec = runtimePackageName && advertisedRuntime && isRuntimeSpecFor(runtimePackageName, advertisedRuntime)
    ? advertisedRuntime
    : '';
  const installedRuntime = String(runtimeVersion || '');
  const runtimeKnown = Boolean(installedRuntime) && !/^unknown$/i.test(installedRuntime);
  if (isNewer(cliSpec, cliVersion)) return { needed: true, target: cliSpec, runtime: runtimeSpec, reason: 'client' };
  if (runtimeSpec && runtimeKnown && isNewer(runtimeSpec, installedRuntime)) {
    return { needed: true, target: cliSpec || `@remcp/remcp@${cliVersion}`, runtime: runtimeSpec, reason: 'runtime' };
  }
  // A runtime that never reported a version cannot be compared, so a device whose runtime is down
  // (or was never installed) would never repair itself. The cooldown in checkForUpdate keeps this
  // from becoming an install loop.
  if (runtimeSpec && !runtimeKnown && runtimeDown) {
    return { needed: true, target: cliSpec || `@remcp/remcp@${cliVersion}`, runtime: runtimeSpec, reason: 'runtime-repair' };
  }
  return { needed: false, target: cliSpec, runtime: runtimeSpec, reason: 'current' };
}

// Applies a freshly installed version. Exiting is what a supervisor needs; without one the new CLI is
// started in this process' place. Either way the agent stops holding a stale runtime, which is what
// makes an update actually take effect on a machine that no service manager watches.
export async function restartToApplyUpdate(cli, stopAgent, markStopping, onRuntimeRepaired, isStopping) {
  try {
    const installed = globalInstalledVersion();
    if (installed && !isNewer(installed, VERSION)) {
      // The client is current, so the update was a runtime repair: restart the runtime rather than
      // the whole agent, or a device with no usable runtime would stay broken.
      console.log(`ReMCP ${VERSION} is already the installed version; restarting the local runtime.`);
      await onRuntimeRepaired?.();
      return;
    }
    // Handing over to a version that cannot start would take the machine offline with nobody left to
    // retry. The new CLI has to answer `--version` before this process steps aside.
    const probe = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    const reported = String(probe.stdout || '').trim();
    if (probe.error || probe.status !== 0 || !/^\d+\.\d+\.\d+/.test(reported)) {
      console.error(`The installed ReMCP ${installed || 'update'} did not run (${probe.error?.message || `exit ${probe.status}`}${reported ? `: ${reported}` : ''}). Keeping ${VERSION} running; retry with: remcp update`);
      return;
    }
    console.log(`ReMCP ${installed || 'a newer version'} installed and verified (${reported}); restarting to apply it.`);
    if (!supervisorRestart()) {
      spawn(process.execPath, [cli, 'start'], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env } }).unref();
      // Stepping aside is only safe once the replacement really holds the device: the relay closes
      // this socket with 1012 ('replaced') the moment another agent takes the machine over, and that
      // close is what stops this process. Without the wait, a replacement that cannot start left the
      // machine connected in `/health` and offline everywhere else, with nobody left to retry.
      await new Promise(resolve => setTimeout(resolve, REPLACEMENT_HANDOVER_TIMEOUT_MS));
      if (!isStopping()) {
        console.error(`The replacement agent did not take over within ${Math.round(REPLACEMENT_HANDOVER_TIMEOUT_MS / 1000)}s; keeping ${VERSION} running. Retry with: remcp update`);
        return;
      }
    }
    markStopping();
    await stopAgent().catch(() => {});
    setTimeout(() => process.exit(0), 100);
  } catch (error) {
    console.error(`Could not restart after the update: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// The version of the globally installed client, read from the package the CLI resolves to.
export function globalInstalledVersion() {
  try {
    try {
      const local = JSON.parse(readFileSync(PACKAGE_MANIFEST, 'utf8')).version;
      if (local) return local;
    } catch {}
    const cli = globalCliEntry({ packageLocal:false });
    if (!cli) return null;
    const base = path.dirname(cli);
    const candidates = [
      path.join(base, '..', 'lib', 'node_modules', '@remcp', 'remcp', 'package.json'),
      path.join(base, '..', 'node_modules', '@remcp', 'remcp', 'package.json'),
    ];
    for (const manifest of candidates) {
      try { return JSON.parse(readFileSync(manifest, 'utf8')).version || null; } catch {}
    }
    return null;
  } catch {
    return null;
  }
}

// True when this process is the one a service manager owns: launchd and systemd's system manager run
// a unit's main process as a child of PID 1, and `systemd --user` runs it as a child of the user
// manager. Anything else — a terminal, a shell inside another unit, a CI runner job — has nobody
// waiting to start the agent again.
function parentIsServiceManager() {
  if (process.ppid === 1) return true;
  if (process.platform === 'win32') return false;
  try { return readFileSync(`/proc/${process.ppid}/comm`, 'utf8').trim() === 'systemd'; } catch { return false; }
}

// What starts the agent again after it exits to apply an update, or null when it has to start its own
// replacement. systemd sets INVOCATION_ID and JOURNAL_STREAM for a unit and every child of that unit
// inherits them, so a `remcp start` run from a shell inside a service (a CI runner, a systemd-run
// scope, another agent) believed a supervisor would bring it back: the update exited into nothing and
// the workspace showed the machine offline until someone started the agent by hand. Only the unit's
// own main process is restarted, so that is what the check requires.
//
// Injectable for tests: the verdict must not depend on the machine that runs them.
export function supervisorRestart({ platform = process.platform, dockerenv = existsSync('/.dockerenv'), parentOurs = parentIsServiceManager() } = {}) {
  if (parentOurs) return platform === 'darwin' ? 'launchd' : 'systemd';
  if (dockerenv) return 'docker';
  return null;
}

export function globalCliEntry({ packageLocal = true } = {}) {
  // The running agent already knows exactly which @remcp/remcp package owns it. Prefer the sibling
  // CLI entry and avoid asking npm which global prefix happens to be active in a minimal service
  // environment (FNM/NVM/Hermes/Homebrew can all disagree with the shell).
  if (packageLocal && existsSync(PACKAGE_CLI_ENTRY)) return PACKAGE_CLI_ENTRY;
  const prefix = spawnSync(npm.command, [...npm.args, 'prefix', '--global'], { encoding:'utf8', windowsHide:true });
  if (prefix.error || prefix.status !== 0) return null;
  const base = String(prefix.stdout || '').trim();
  return process.platform === 'win32'
    ? path.join(base, 'remcp.cmd')
    : path.join(base, 'bin', 'remcp');
}
