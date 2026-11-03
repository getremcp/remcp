import process from 'node:process';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Read-only capability evidence. God Mode does not change operating-system identity.
// Never execute sudo or attempt privilege escalation while gathering diagnostics.
export function privilegeBoundary({
  platform = process.platform,
  effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : null,
  procStatus,
  windowsGroupOutput,
} = {}) {
  if (platform === 'win32') {
    let output = windowsGroupOutput;
    if (output === undefined) {
      try {
        const result = spawnSync('whoami.exe', ['/groups'], {
          encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024,
        });
        output = result.status === 0 && !result.error ? result.stdout : '';
      } catch { output = ''; }
    }
    const sid = String(output).match(/S-1-16-(?:4096|8192|12288|16384|20480)\b/g)?.at(-1) || null;
    const integrityLevel = sid === 'S-1-16-16384' ? 'system'
      : sid === 'S-1-16-12288' ? 'high'
        : sid === 'S-1-16-8192' ? 'medium'
          : sid === 'S-1-16-4096' ? 'low'
            : sid === 'S-1-16-20480' ? 'protected_process' : 'unknown';
    return {
      platform,
      integrityLevel,
      elevation: integrityLevel === 'high' || integrityLevel === 'system'
        ? 'elevated_token' : integrityLevel === 'unknown' ? 'unknown' : 'not_elevated',
      note: 'Windows integrity is read from the running token, not inferred from scheduled-task settings. A high-integrity token is not proof of unrestricted OS access. UAC and ACLs still apply.',
    };
  }
  if (platform === 'darwin') {
    return { platform, effectiveUid, elevation: effectiveUid === 0 ? 'already_root' : 'requires_os_authorization', note: 'macOS sudo, Full Disk Access, Accessibility and Automation are separate OS permissions.' };
  }
  if (platform !== 'linux') return { platform, elevation: 'unknown' };
  let status = procStatus;
  if (status === undefined) {
    try { status = readFileSync('/proc/self/status', 'utf8'); } catch { status = ''; }
  }
  const match = /^NoNewPrivs:[ \t]*([01])[ \t]*$/m.exec(status);
  const noNewPrivileges = match ? match[1] === '1' : null;
  const elevation = effectiveUid === 0 ? 'already_root'
    : noNewPrivileges === true ? 'blocked_by_no_new_privileges'
      : noNewPrivileges === false ? 'requires_os_authorization' : 'unknown';
  return {
    platform,
    effectiveUid,
    noNewPrivileges,
    elevation,
    note: elevation === 'blocked_by_no_new_privileges'
      ? 'The service process cannot gain privileges through sudo/setuid until restarted with an appropriate OS policy. God Mode does not override this.'
      : 'The OS still controls sudo/polkit and privilege grants. God Mode alone does not grant root.',
  };
}
