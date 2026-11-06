// Windows native UI runs in a user's interactive session, never in Session 0.
// This only examines the current probe process; it does not enumerate users,
// request a login, open the secure desktop or change Windows permissions.
import { runPowerShell } from './common.mjs';

export const WINDOWS_DESKTOP_PROBE = String.raw`
$ErrorActionPreference='Stop'
$p=[System.Diagnostics.Process]::GetCurrentProcess()
[pscustomobject]@{
  sessionId=$p.SessionId
  userInteractive=[Environment]::UserInteractive
} | ConvertTo-Json -Compress
`;

export function classifyWindowsDesktopSession(value) {
  const sessionId = value?.sessionId;
  const interactive = value?.userInteractive;
  if (!Number.isSafeInteger(sessionId) || sessionId < 0 || typeof interactive !== 'boolean') {
    return { status:'unknown', available:null, reason:'invalid_session_probe' };
  }
  if (sessionId === 0 || !interactive) {
    return {
      status:'unavailable',
      available:false,
      reason:sessionId === 0 ? 'windows_session_0' : 'noninteractive_process',
      next_step:'sign_in_to_interactive_desktop',
    };
  }
  return { status:'available', available:true };
}

export async function windowsDesktopSessionStatus({ runPowerShellFn = runPowerShell } = {}) {
  try {
    const result = await runPowerShellFn(WINDOWS_DESKTOP_PROBE, {
      label:'Windows interactive desktop readiness',
      timeout:6000,
    });
    return classifyWindowsDesktopSession(JSON.parse(String(result?.stdout || '').trim()));
  } catch {
    // A failed OS query is not proof that no user is signed in.
    return { status:'unknown', available:null, reason:'session_probe_failed' };
  }
}

// Tool discovery can request the same session status several times per second.
// Cache only advertised capabilities; native actions always use a fresh probe.
export function createWindowsDesktopSessionCache({
  probe = windowsDesktopSessionStatus,
  ttlMs = 2500,
  nowFn = Date.now,
} = {}) {
  let cached = null;
  let expiresAt = 0;
  let inFlight = null;
  return async () => {
    if (cached && nowFn() < expiresAt) return cached;
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(probe).catch(() => ({
      status:'unknown', available:null, reason:'session_probe_failed',
    })).then(result => {
      cached = result && typeof result.available === 'boolean'
        ? result
        : { status:'unknown', available:null, reason:'session_probe_failed' };
      expiresAt = nowFn() + Math.max(0, ttlMs);
      return cached;
    }).finally(() => { inFlight = null; });
    return inFlight;
  };
}

export const cachedWindowsDesktopSessionStatus = createWindowsDesktopSessionCache();

export async function assertWindowsInteractiveDesktop({
  platform = process.platform,
  probe = windowsDesktopSessionStatus,
} = {}) {
  if (platform !== 'win32') return;
  const status = await probe();
  if (status?.available === true) return;
  const reason = status?.reason || 'session_probe_failed';
  throw new Error(`Windows desktop unavailable (${reason}): sign in to an interactive Windows desktop before using native screen or input tools.`);
}

export function guardWindowsDesktopTool(handler, options = {}) {
  return async (...args) => {
    await assertWindowsInteractiveDesktop(options);
    return handler(...args);
  };
}
