import { ToolError } from './util.mjs';
// Error telemetry is a small closed vocabulary. Never return an error message,
// path, URL, selector, command, or arbitrary error.code to account telemetry.
const PERMISSION_CODES = new Set(['EACCES', 'EPERM']);
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ETIME']);
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH']);

export function classifyRuntimeToolError(error, toolName = '') {
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  const message = typeof error?.message === 'string' ? error.message.slice(0, 2048).toLowerCase() : '';
  const browserTool = typeof toolName === 'string' && toolName.startsWith('browser_');
  if (PERMISSION_CODES.has(code)) return 'permission';
  if (MISSING_CODES.has(code)) return 'not_found';
  if (TIMEOUT_CODES.has(code)) return 'timeout';
  if (browserTool && CONNECTION_CODES.has(code)) return 'browser_unavailable';
  if (browserTool && code === 'BROWSER_TARGET_DISAPPEARED') return 'browser_target_stale';
  if (/\bcancelled\b|\bcanceled\b|\baborted by the client\b/.test(message)) return 'cancelled';
  if (/blocked (?:by|local|private)|outside the directories this device allows|private browser destination|blocked local browser scheme/.test(message)) return 'blocked';
  if (browserTool && /browser cdp endpoint is unavailable|browser control is unavailable|cdp websocket (?:error|connection timed out)|local cdp endpoint did not become ready/.test(message)) {
    return 'browser_unavailable';
  }
  if (browserTool) {
    // Match only fixed CDP failure signatures; never emit the error text, tab ID,
    // destination URL or selector as a telemetry category.
    if (/browser child guard failed|browser request guard failed|browser safety guard failed/.test(message)) {
      return 'browser_guard_failed';
    }
    if (/browser cdp target disappeared|target (?:was )?closed|no target with given id|target with given id not found|inspected target navigated or closed/.test(message)) {
      return 'browser_target_stale';
    }
    if (/cdp websocket (?:closed|is not open)|session with given id not found|cdp session (?:closed|disconnected)/.test(message)) {
      return 'browser_session_lost';
    }
    if (/browser navigation failed|cannot navigate (?:back|forward)|net::err_[a-z_]+/.test(message)) {
      return 'browser_navigation_failed';
    }
  }
  if (/permission denied|access is denied|not authorized|not authorised|accessibility permission/.test(message)) return 'permission';
  if (/timed out|timeout after|time limit exceeded/.test(message)) return 'timeout';
  if (/element not found|no element matches|no matching ui window|target not found|not found in the current/.test(message)) return 'not_found';
  if (/requires .*|must be (?:a |an |positive |between )|invalid (?:argument|selector|field|parameter)/.test(message)) return 'invalid_input';
  return error instanceof ToolError ? 'tool_error' : 'runtime_error';
}
