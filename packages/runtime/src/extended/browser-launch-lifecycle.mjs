// Bounded, content-free telemetry for ReMCP-owned Chrome child lifecycles.
let recentExit = null;
const HINT_WINDOW_MS = 60_000;

export function classifyBrowserLaunchExit({ code = null, signal = null, error = null } = {}) {
  if (error) return 'spawn_error';
  if (typeof signal === 'string' && /^SIG[A-Z0-9]+$/.test(signal)) return 'signaled';
  if (code === 0) return 'clean_exit';
  if (Number.isInteger(code)) return 'nonzero_exit';
  return 'unknown_exit';
}

export function observeBrowserLaunchExit({ code = null, signal = null, error = null } = {}, {
  startedAt = Date.now(), now = Date.now(), restore = false, isolated = false,
  log = console.warn,
} = {}) {
  const event = {
    event:'dedicated_browser_exit',
    reason:classifyBrowserLaunchExit({ code, signal, error }),
    exit_code:Number.isInteger(code) ? code : null,
    signal:typeof signal === 'string' && /^SIG[A-Z0-9]+$/.test(signal) ? signal : null,
    elapsed_ms:Math.min(86_400_000, Math.max(0, now - startedAt)),
    restore_requested:Boolean(restore),
    recovery_profile:Boolean(isolated),
  };
  recentExit = { at:now, reason:event.reason };
  log(`ReMCP browser lifecycle: ${JSON.stringify(event)}`);
  return event;
}

// Advisory only: a Chrome launcher can exit without bringing CDP down. Never
// claim this event caused a later endpoint failure or authorize a relaunch.
export function browserLaunchExitHint({ now = Date.now(), configured = false } = {}) {
  if (configured || !recentExit || now < recentExit.at || now - recentExit.at > HINT_WINDOW_MS) return '';
  return ` A recently launched ReMCP browser process exited (${recentExit.reason}); the event may be unrelated to CDP availability.`;
}
