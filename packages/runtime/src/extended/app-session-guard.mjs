// A GUI command must never be marked dispatched from a headless worker.
// This is a read-only session preflight, not a permission or consent bypass.
import os from 'node:os';
import process from 'node:process';
import { runFile, runPowerShell } from './common.mjs';
import { classifyGuiSession } from './app-session-core.mjs';
export { classifyGuiSession } from './app-session-core.mjs';

export async function requireInteractiveGuiSession(platform = process.platform) {
  let evidence;
  if (platform === 'linux') {
    evidence = {env:process.env};
  } else if (platform === 'win32') {
    const { stdout } = await runPowerShell(
      '[pscustomobject]@{sessionId=[System.Diagnostics.Process]::GetCurrentProcess().SessionId;userInteractive=[Environment]::UserInteractive}|ConvertTo-Json -Compress',
      {label:'verify interactive Windows session',timeout:7000,maxBuffer:4096});
    try { evidence = JSON.parse(stdout.trim()); }
    catch { throw new Error('Cannot verify interactive Windows session; GUI navigation refused'); }
  } else if (platform === 'darwin') {
    const { stdout } = await runFile('/usr/bin/stat',['-f','%Su','/dev/console'],
      {label:'verify macOS console user',timeout:5000,maxBuffer:1024});
    evidence = {consoleUser:stdout.trim(),currentUser:os.userInfo().username};
  } else {
    throw new Error('Unsupported OS for GUI navigation');
  }
  const result = classifyGuiSession(platform,evidence);
  if (!result.interactive) throw new Error(`GUI navigation unavailable: ${result.reason}. Connect an interactive desktop session; no keys or app launches were dispatched.`);
  return result;
}
