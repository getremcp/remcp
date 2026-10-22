import process from 'node:process';
import { assertAllowedCommand } from '../policy.mjs';
import { text, throwIfCancelled, ToolError } from '../util.mjs';
import { commandExists, requireEnum, runFile, runOsa, runPowerShell, spawnDetached, unavailable } from './common.mjs';
import { serviceTool, eventLog, networkTool, installedApps } from './diagnostics-platform.mjs';
import { environmentTool, audioTool } from './diagnostics-audio.mjs';
import { recordScreen } from './diagnostics-recording.mjs';

export * from './diagnostics-platform.mjs';
export * from './diagnostics-audio.mjs';
export * from './diagnostics-recording.mjs';

export const POWER_ACTION_MAX_DELAY_SECONDS = 90;

export function normalizePowerActionDelay(value) {
  if (value === undefined || value === null || value === '') return 0;
  const delay = Number(value);
  if (!Number.isFinite(delay) || delay < 0 || delay > POWER_ACTION_MAX_DELAY_SECONDS) {
    throw new Error(`delay_seconds must be between 0 and ${POWER_ACTION_MAX_DELAY_SECONDS}`);
  }
  return delay;
}

export async function waitForPowerActionDelay(delaySeconds, signal) {
  throwIfCancelled(signal);
  if (delaySeconds <= 0) return;

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, new ToolError('Cancelled by the client; power action was not executed.'));
    const timer = setTimeout(() => finish(resolve), delaySeconds * 1000);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once:true });
  });

  throwIfCancelled(signal);
}

export async function powerAction(args, extra = {}) {
  const action = requireEnum(args.action, 'action', ['lock','sleep','restart','shutdown']);
  const policy = assertAllowedCommand(action === 'restart' ? 'reboot' : action === 'shutdown' ? 'shutdown' : action);
  const delay = normalizePowerActionDelay(args.delay_seconds);
  await waitForPowerActionDelay(delay, extra.signal);
  throwIfCancelled(extra.signal);
  if (process.platform === 'win32') {
    if (action === 'lock') await runPowerShell('rundll32.exe user32.dll,LockWorkStation', { label:'lock workstation' });
    else if (action === 'sleep') await runPowerShell('rundll32.exe powrprof.dll,SetSuspendState 0,1,0', { label:'sleep workstation' });
    else spawnDetached('shutdown.exe', [action === 'restart' ? '/r' : '/s','/t','0']);
  } else if (process.platform === 'darwin') {
    if (action === 'lock') spawnDetached('/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession', ['-suspend']);
    else if (action === 'sleep') await runFile('/usr/bin/pmset', ['sleepnow'], { label:'sleep' });
    else await runOsa(`tell application "System Events" to ${action === 'restart' ? 'restart' : 'shut down'}`, { label:action });
  } else {
    if (action === 'lock') {
      if (!commandExists('loginctl')) unavailable('Session lock', 'loginctl is required');
      await runFile('loginctl', ['lock-session'], { label:'lock session' });
    } else {
      if (!commandExists('systemctl')) unavailable('Power action', 'systemctl is required');
      await runFile('systemctl', [action === 'sleep' ? 'suspend' : action === 'restart' ? 'reboot' : 'poweroff'], { label:action });
    }
  }
  return text(`${policy.note ? `${policy.note}\n` : ''}Power action ${action} requested.`);
}

export const diagnosticHandlers = {
  service:serviceTool,
  event_log:eventLog,
  network:networkTool,
  installed_apps:installedApps,
  environment:environmentTool,
  audio:audioTool,
  power_action:powerAction,
  record_screen:recordScreen,
};
