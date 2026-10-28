import path from 'node:path';
import { runtimeConfig } from './config.mjs';
import { recordEvent } from './telemetry.mjs';
import { fail } from './util.mjs';

// Built-in hardening rules for catastrophic host-level commands. The default is `block`:
// fresh installations refuse these commands before execution. Operators can explicitly choose
// `warn` (run and report) or `allow` (disable this built-in guardrail); unrestricted/godmode
// also forces `allow` and remains a local-only opt-in.
//
// Rules are matched against the *command word* of each shell segment, so a read-only
// command that merely mentions a dangerous word (`grep -n format README.md`,
// `cat notes/shutdown.md`) is not refused.
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'nohup', 'command', 'builtin', 'time', 'nice', 'ionice', 'stdbuf', 'timeout', 'setsid', 'exec', 'busybox']);
const SHELL_WRAPPERS = /^(?:sh|bash|zsh|dash|ksh|fish|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)$/i;
const INTERPRETER_EXECUTION = /\b(?:os\.system|subprocess\.(?:run|call|check_call|check_output|Popen)|child_process|\bexec\s*\(|\beval\s*\(|\bspawn\s*\()/i;
const CATASTROPHIC_TEXT = /(?:mkfs(?:\.[a-z0-9]+)?\b|\b(?:fdisk|sfdisk|cfdisk|parted|diskpart|gdisk)\b|\bdd\b[^\n]*(?:\bof=\s*\/dev\/|\bof=\s*\\\\\.\\)|\b(?:shutdown|reboot|halt|poweroff|restart-computer|stop-computer)\b|\brm\b[^\n]*(?:--recursive|--force|-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)[^\n]*(?:\s|\s*\/\s*|\s*~\s*|\s*\$HOME\b|\s*\$\{HOME\})|\bpython[0-9.]*\b[^\n]*(?:os\.system|subprocess|rm\s+-[^\n]*r[^\n]*f))/i;

const DANGEROUS_RULES = [
  { id: 'filesystem-format', description: 'formats a filesystem', commands: /^mkfs(\.[a-z0-9]+)?$/i, args: () => true },
  { id: 'raw-disk-write', description: 'writes raw data to a block device', commands: /^dd$/i, args: segment => /\bof=\s*\/dev\//i.test(segment) || /\bof=\s*\\\\\.\\/i.test(segment) },
  { id: 'disk-partition', description: 'repartitions a disk', commands: /^(fdisk|sfdisk|cfdisk|parted|diskpart|gdisk)$/i, args: () => true },
  { id: 'redirect-to-device', description: 'redirects output into a block device', commands: null, anySegment: />>?\s*\/dev\/(sd|hd|vd|nvme|mmcblk|disk)/i },
  { id: 'host-power', description: 'powers off or reboots the machine', commands: /^(shutdown|reboot|halt|poweroff|restart-computer|stop-computer)$/i, args: () => true },
  { id: 'service-power', description: 'changes system power through a service manager', commands: /^systemctl$/i, args: segment => /\b(?:poweroff|reboot|halt|shutdown)\b/i.test(segment) },
  { id: 'init-runlevel', description: 'changes the init runlevel', commands: /^init$/i, args: segment => /\binit\s+[06]\b/i.test(segment) },
  { id: 'fork-bomb', description: 'starts a fork bomb', commands: null, anySegment: /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/ },
  {
    id: 'recursive-root-delete',
    description: 'recursively deletes a root or home path',
    commands: /^rm$/i,
    args: segment => {
      const recursive = /(^|\s)(?:--recursive|-[a-z]*r[a-z]*)(?=\s|$)/i.test(segment);
      const force = /(^|\s)(?:--force|-[a-z]*f[a-z]*)(?=\s|$)/i.test(segment);
      const rootTarget = /(\s)(\/|\/\*|~|~\/\*|\$HOME|\$\{HOME\})(\s|$)/i.test(segment);
      return recursive && force && rootTarget;
    },
  },
  { id: 'chmod-root', description: 'recursively rewrites permissions on a root path', commands: /^chmod$/i, args: segment => /(\s)(\/|\/\*)(\s|$)/.test(segment) },
  { id: 'chown-root', description: 'recursively rewrites ownership on a root path', commands: /^chown$/i, args: segment => /(\s)(\/|\/\*)(\s|$)/.test(segment) },
  { id: 'history-rewrite', description: 'clears shell history to hide activity', commands: /^(history|shred)$/i, args: segment => /history\s+-c/.test(segment) || /\.(bash_)?history/.test(segment) },
  { id: 'windows-destructive', description: 'destroys Windows system state', commands: /^(format|bcdedit|diskpart)$/i, args: () => true },
  { id: 'windows-cipher-wipe', description: 'wipes free space on a Windows volume', commands: /^cipher$/i, args: segment => /\/w\b/i.test(segment) },
];

function normalize(command) {
  return String(command).replace(/\s+/g, ' ').trim();
}

function matchingText(value) {
  return String(value).replace(/(["'])(.*?)\1/g, '$2').replace(/\\(["'\\$`])/g, '$1');
}

// Split on shell control operators so each simple command is judged on its own command
// word instead of on every word in the line.
function segments(command) {
  return normalize(command)
    .split(/&&|\|\||[;|\n]/)
    .map(part => part.trim())
    .filter(Boolean);
}

// A wrapper option may consume the following token. Dropping the option but
// not its value makes the guardrail examine "root"/"10" instead of "rm".
const WRAPPER_VALUE_FLAGS = Object.freeze({
  sudo: new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-R', '--chroot', '-T', '--command-timeout']),
  doas: new Set(['-u']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid']),
  stdbuf: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
});

function commandWord(segment) {
  const tokens = matchingText(segment).split(' ').filter(Boolean);
  while (tokens.length) {
    const token = tokens[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { tokens.shift(); continue; }
    const tokenName = path.basename(token).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
    if (!WRAPPERS.has(tokenName)) break;
    tokens.shift();
    const valueFlags = WRAPPER_VALUE_FLAGS[tokenName];
    while (tokens.length) {
      const option = tokens[0];
      if (option === '--') { tokens.shift(); break; }
      if (tokenName === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) {
        tokens.shift();
        continue;
      }
      // env -S/--split-string executes its argument as command words; never
      // discard that argument as an ordinary wrapper option value.
      if (tokenName === 'env' && (option === '-S' || option === '--split-string')) {
        tokens.shift();
        break;
      }
      if (tokenName === 'env' && (option.startsWith('--split-string=') || /^-S.+/.test(option))) {
        tokens[0] = option.startsWith('--split-string=') ? option.slice('--split-string='.length) : option.slice(2);
        break;
      }
      if (!option.startsWith('-') || option === '-') break;
      tokens.shift();
      if (valueFlags?.has(option) && tokens.length) tokens.shift();
    }
    if (tokenName === 'timeout' && tokens.length && /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[0])) tokens.shift();
  }
  const word = tokens[0] || '';
  return word.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '');
}

function nestedCommandValues(command) {
  const values = [];
  const normalized = String(command || '');
  const substitution = /\$\(([\s\S]*?)\)|`([^`]*)`/g;
  for (const match of normalized.matchAll(substitution)) values.push(match[1] || match[2] || '');
  const shellCommand = /(^|\s)(?:-c|--command|-e|--eval)\s+(?:"([\s\S]*?)"|'([\s\S]*?)'|([^\s;]+))/g;
  for (const match of normalized.matchAll(shellCommand)) values.push(match[2] || match[3] || match[4] || '');
  return values;
}

function nestedExecutionIsDangerous(command) {
  const normalized = String(command || '');
  const shell = normalized.split(/\s+/).some(token => SHELL_WRAPPERS.test(path.basename(token).replace(/\.(exe|cmd|bat)$/i, '')));
  return (shell || INTERPRETER_EXECUTION.test(normalized)) && CATASTROPHIC_TEXT.test(normalized);
}

export function checkCommand(command) {
  if (runtimeConfig.unrestricted) return { warned: false, mode: 'allow', unrestricted: true, findings: [] };
  const normalized = normalize(command);
  const nested = nestedCommandValues(normalized);
  const commands = [normalized, ...nested];
  const parts = commands.flatMap(segments);
  const findings = [];
  for (const blocked of runtimeConfig.blockedCommands) {
    if (normalized.toLowerCase().includes(blocked.toLowerCase())) findings.push({ id: 'policy', description: blocked, source: 'device-policy' });
  }
  if (runtimeConfig.dangerousCommands !== 'allow') {
    for (const part of parts) {
      const matchText = matchingText(part);
      const word = commandWord(part);
      for (const rule of DANGEROUS_RULES) {
        const matches = rule.anySegment ? rule.anySegment.test(matchText) : Boolean(word && rule.commands?.test(word) && rule.args(matchText));
        if (matches) findings.push({ id: rule.id, description: rule.description, source: 'builtin' });
      }
    }
    if (nestedExecutionIsDangerous(matchingText(normalized))) findings.push({ id: 'nested-catastrophic-command', description: 'executes a catastrophic command through a shell or interpreter', source: 'builtin' });
  }
  if (!findings.length) return { warned: false, mode: runtimeConfig.dangerousCommands };
  const unique = [...new Map(findings.map(item => [item.id + item.description, item])).values()];
  if (runtimeConfig.dangerousCommands === 'warn' && unique.every(item => item.source === 'builtin')) {
    return { warned: true, mode: 'warn', findings: unique };
  }
  return { blocked: true, mode: runtimeConfig.dangerousCommands, findings: unique };
}

export function assertAllowedCommand(command) {
  const verdict = checkCommand(command);
  if (verdict.blocked) {
    const detail = verdict.findings.map(item => item.description).join(', ');
    fail(`Command blocked by ReMCP device policy (${detail}). Set REMCP_RUNTIME_BLOCKED_COMMANDS to adjust the device list, or REMCP_RUNTIME_DANGEROUS_COMMANDS=allow to disable the built-in catastrophic-command guardrail.`);
  }
  if (verdict.warned) {
    const detail = verdict.findings.map(item => item.description).join(', ');
    recordEvent('policy_warning', { reason: verdict.findings[0]?.id || 'builtin', success: true });
    return { ...verdict, note: `Note: this command matches the optional destructive-command guardrail (${detail}). It was executed.` };
  }
  return verdict;
}

export const dangerousPatternIds = DANGEROUS_RULES.map(entry => entry.id);
