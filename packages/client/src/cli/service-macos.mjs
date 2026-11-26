// macOS launchd service and managed CLI shim; no Linux/Windows service side effects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { globalCliPath, servicePlatform } from './npm-global.mjs';
import { persistentServiceExpected, canonicalServiceCliPath, canonicalServiceNodePath } from './service-inventory.mjs';
import { configDir, home, macLogFile, macServiceFile, macServiceLabel } from './env.mjs';
import { run } from './shell.mjs';
import { replaceFileAtomically } from './atomic-file.mjs';
import { resolvedCliScript, shellQuote, xmlEscape } from './service-paths.mjs';

export function macLaunchDomain() {
  if (typeof process.getuid !== 'function') throw new Error('Could not determine the current macOS user');
  return `gui/${process.getuid()}`;
}

const remcpPathBlockStart = '# >>> ReMCP CLI PATH >>>';
const remcpPathBlockEnd = '# <<< ReMCP CLI PATH <<<';
const remcpCliShimMarker = '# ReMCP managed CLI shim';

function macCliShimPath() {
  return path.join(home, '.local', 'bin', 'remcp');
}

function interactiveShellProfile() {
  // Some isolated runner/SSH accounts have no passwd record. An unknown login shell
  // must never abort LaunchAgent repair after the reload handoff was scheduled.
  let shell = process.env.REMCP_TEST_SHELL || process.env.SHELL || '';
  if (!shell) {
    try { shell = os.userInfo().shell || ''; } catch {}
  }
  const name = path.basename(shell || '/bin/zsh');
  if (name === 'zsh') return path.join(home, '.zshrc');
  if (name === 'bash') return path.join(home, '.bash_profile');
  return '';
}

function upsertManagedPathBlock(file) {
  if (!file) return false;
  const block = [
    remcpPathBlockStart,
    'case ":$PATH:" in',
    '  *":$HOME/.local/bin:"*) ;;',
    '  *) export PATH="$HOME/.local/bin:$PATH" ;;',
    'esac',
    remcpPathBlockEnd,
  ].join('\n');
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const start = current.indexOf(remcpPathBlockStart);
  const end = start >= 0 ? current.indexOf(remcpPathBlockEnd, start + remcpPathBlockStart.length) : -1;
  let next;
  if (start >= 0 && end >= 0) {
    next = current.slice(0, start) + block + current.slice(end + remcpPathBlockEnd.length);
  } else {
    const prefix = current && !current.endsWith('\n') ? current + '\n' : current;
    next = prefix + (prefix ? '\n' : '') + block + '\n';
  }
  if (next === current) return false;
  replaceFileAtomically(file, next, { mode:0o600, preserveMode:true, followSymlink:true });
  return true;
}

function removeManagedPathBlock(file) {
  if (!file) return;
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); } catch { return; }
  const start = current.indexOf(remcpPathBlockStart);
  const end = start >= 0 ? current.indexOf(remcpPathBlockEnd, start + remcpPathBlockStart.length) : -1;
  if (start < 0 || end < 0) return;
  let before = current.slice(0, start);
  let after = current.slice(end + remcpPathBlockEnd.length);
  if (before.endsWith('\n') && after.startsWith('\n')) after = after.slice(1);
  const next = before + after;
  replaceFileAtomically(file, next, { mode:0o600, preserveMode:true, followSymlink:true });
}

export function ensureMacCliCommand(config = {}, { cliPath = '', nodePath = '' } = {}) {
  if (servicePlatform() !== 'darwin') return null;
  const effectiveCli = cliPath || (persistentServiceExpected(config) ? canonicalServiceCliPath(config) : globalCliPath());
  const effectiveNode = nodePath || (persistentServiceExpected(config) ? canonicalServiceNodePath(config) : process.execPath);
  const cliScript = resolvedCliScript(effectiveCli);
  const shim = macCliShimPath();
  try {
    const existing = fs.readFileSync(shim, 'utf8');
    if (!existing.includes(remcpCliShimMarker)) {
      console.error(`ReMCP did not replace ${shim} because it is not a ReMCP-managed command.`);
      return null;
    }
  } catch (error) {
    if (error?.code && error.code !== 'ENOENT') {
      console.error(`ReMCP could not inspect ${shim}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
  const launcher = `#!/bin/sh\n${remcpCliShimMarker}\nexec ${shellQuote(effectiveNode)} ${shellQuote(cliScript)} "$@"\n`;
  fs.mkdirSync(path.dirname(shim), { recursive:true, mode:0o755 });
  const temporary = `${shim}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, launcher, { mode:0o755 });
  fs.chmodSync(temporary, 0o755);
  fs.renameSync(temporary, shim);
  const profile = interactiveShellProfile();
  upsertManagedPathBlock(profile);
  if (profile === path.join(home, '.zshrc')) {
    upsertManagedPathBlock(path.join(home, '.zprofile'));
  }
  return shim;
}

export function removeMacCliCommand() {
  if (servicePlatform() !== 'darwin') return;
  const shim = macCliShimPath();
  try {
    const existing = fs.readFileSync(shim, 'utf8');
    if (existing.includes(remcpCliShimMarker)) fs.unlinkSync(shim);
  } catch {}
  const profile = interactiveShellProfile();
  removeManagedPathBlock(profile);
  if (profile === path.join(home, '.zshrc')) {
    removeManagedPathBlock(path.join(home, '.zprofile'));
  }
}

function macServicePlist(cliPath, nodePath = process.execPath) {
  // launchd wants an absolute path; a symlinked prefix that npm has not materialised yet (or a path
  // that is about to be replaced by the next install) must not abort the repair — a stale plist is
  // exactly the loop this function exists to break.
  const cliScript = resolvedCliScript(cliPath);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${macServiceLabel}</string>\n<key>ProgramArguments</key><array><string>${xmlEscape(nodePath)}</string><string>${xmlEscape(cliScript)}</string><string>start</string><string>--service</string></array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>ProcessType</key><string>Background</string>\n<key>StandardOutPath</key><string>${xmlEscape(macLogFile)}</string>\n<key>StandardErrorPath</key><string>${xmlEscape(macLogFile)}</string>\n</dict></plist>\n`;
}

export function macJobLoaded(target) {
  return spawnSync('launchctl', ['print', target], { stdio: 'ignore' }).status === 0;
}

function submitMacHelper(kind, lines) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const nonce = `${process.pid}.${Date.now()}`;
  const helperFile = path.join(configDir, `launchd-${kind}-${nonce}.sh`);
  const helperLabel = `${macServiceLabel}.${kind}.${nonce}`;
  const script = [
    '#!/bin/sh',
    'sleep 1',
    'status=0',
    // Never run enable/kickstart after an unconfirmed launchd re-registration.
    ...lines.map((line, index) => `if [ "$status" -eq 0 ]; then ${line} || { status=$?; echo "ReMCP launchd ${kind} step ${index + 1} failed with status $status" >> ${shellQuote(macLogFile)}; }; fi`),
    `if [ "$status" -ne 0 ]; then echo "ReMCP launchd ${kind} helper failed with status $status" >> ${shellQuote(macLogFile)}; fi`,
    `rm -f ${shellQuote(helperFile)}`,
    `launchctl remove ${shellQuote(helperLabel)} >/dev/null 2>&1 || true`,
    'exit 0',
    '',
  ].join('\n');
  fs.writeFileSync(helperFile, script, { mode: 0o700 });
  fs.chmodSync(helperFile, 0o700);
  run('launchctl', ['submit', '-l', helperLabel, '--', '/bin/sh', helperFile]);
  return helperLabel;
}

// launchctl can return 37 while the old job is still unloading. Retry
// only the same owner-scoped service, never another launchd target.
export function macReloadSteps(domain, target, file = macServiceFile) {
  const job = shellQuote(target);
  const scope = shellQuote(domain);
  const service = shellQuote(file);
  return [
    `launchctl bootout ${job} >/dev/null 2>&1 || true`,
    `n=0; while launchctl print ${job} >/dev/null 2>&1; do n=$((n+1)); [ "$n" -lt 12 ] || break; sleep 1; done; ! launchctl print ${job} >/dev/null 2>&1`,
    `n=0; until launchctl bootstrap ${scope} ${service} >/dev/null 2>&1; do n=$((n+1)); [ "$n" -lt 12 ] || break; sleep 1; done; launchctl print ${job} >/dev/null 2>&1`,
    `launchctl enable ${job}`,
    // RunAtLoad + KeepAlive already starts a newly bootstrapped job. Repeating
    // kickstart -k while it is starting races launchd (37/EALREADY) and can
    // terminate the process that just connected. Wait for the actual state;
    // issue at most one non-destructive kickstart if it never starts itself.
    `n=0; while ! launchctl print ${job} | grep -Eq '^[[:space:]]*state = running$'; do n=$((n+1)); [ "$n" -lt 12 ] || break; sleep 1; done; if ! launchctl print ${job} | grep -Eq '^[[:space:]]*state = running$'; then launchctl kickstart ${job} >/dev/null 2>&1 || true; n=0; while ! launchctl print ${job} | grep -Eq '^[[:space:]]*state = running$'; do n=$((n+1)); [ "$n" -lt 8 ] || break; sleep 1; done; fi; launchctl print ${job} | grep -Eq '^[[:space:]]*state = running$'`,
  ];
}

function scheduleMacServiceReload(domain, target) {
  return submitMacHelper('reload', macReloadSteps(domain, target));
}

export function scheduleMacServiceRestart(target) {
  return submitMacHelper('restart', [
    `launchctl kickstart -k ${shellQuote(target)}`,
  ]);
}

export function installMacService(cliPath = globalCliPath(), { restart = true, nodePath = process.execPath } = {}) {
  const domain = macLaunchDomain();
  const target = `${domain}/${macServiceLabel}`;
  const plist = macServicePlist(cliPath, nodePath);
  let previous = '';
  try { previous = fs.readFileSync(macServiceFile, 'utf8'); } catch {}
  const loaded = macJobLoaded(target);

  fs.mkdirSync(path.dirname(macServiceFile), { recursive: true });
  fs.mkdirSync(path.dirname(macLogFile), { recursive: true });
  replaceFileAtomically(macServiceFile, plist, { mode: 0o600 });

  if (loaded && previous === plist) {
    run('launchctl', ['enable', target]);
    // Never boot out a healthy loaded job just to refresh an in-place npm install. The final
    // kickstart keeps launchd responsible for bringing the replacement agent back.
    if (restart) run('launchctl', ['kickstart', '-k', target]);
    return 'loaded';
  }

  if (loaded) {
    // A changed Node/npm prefix requires launchd to re-read ProgramArguments. A separate transient
    // launchd job survives booting out com.remcp.agent even when the updater was launched by it.
    scheduleMacServiceReload(domain, target);
    return 'reload-scheduled';
  }

  run('launchctl', ['bootstrap', domain, macServiceFile]);
  run('launchctl', ['enable', target]);
  if (restart) run('launchctl', ['kickstart', '-k', target]);
  return 'bootstrapped';
}
