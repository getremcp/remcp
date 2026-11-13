// Pure, conservative GUI-session eligibility checks, reusable for native OS smoke tests.
export function classifyGuiSession(platform, evidence = {}) {
  if (platform === 'linux') {
    const env = evidence.env || {};
    return {
      interactive:Boolean(env.DISPLAY || env.WAYLAND_DISPLAY),
      reason:env.DISPLAY || env.WAYLAND_DISPLAY ? 'display_advertised' : 'no_display',
    };
  }
  if (platform === 'win32') {
    const sessionId = Number(evidence.sessionId);
    const valid = Number.isInteger(sessionId) && sessionId > 0 && evidence.userInteractive === true;
    return {interactive:valid,reason:valid ? 'user_session' : 'session_0_or_noninteractive'};
  }
  if (platform === 'darwin') {
    const consoleUser = String(evidence.consoleUser || '');
    const currentUser = String(evidence.currentUser || '');
    const valid = Boolean(consoleUser && currentUser && consoleUser === currentUser && consoleUser !== 'root');
    return {interactive:valid,reason:valid ? 'console_user' : 'no_matching_console_user'};
  }
  return {interactive:false,reason:'unsupported_platform'};
}
