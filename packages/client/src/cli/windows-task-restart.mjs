// ReMCP's confirmed remote God Mode change must acknowledge its command BEFORE
// killing the agent's own Task Scheduler process tree. Launch a fixed-purpose
// helper outside the CLI process; never interpolate a user-provided task or shell.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { windowsTaskName } from './env.mjs';

const helperPath = fileURLToPath(import.meta.url);
const options = { windowsHide:true, encoding:'utf8', timeout:15000, maxBuffer:32768 };

export function scheduleWindowsTaskRestart(nodePath = process.execPath) {
  if (!path.isAbsolute(nodePath) || !fs.existsSync(nodePath)) {
    throw new Error('Windows deferred restart requires the existing Node interpreter');
  }
  const child = spawn(nodePath, [helperPath, '--relaunch'], {
    detached:true, windowsHide:true, stdio:'ignore',
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    throw new Error('Could not schedule independent Windows ReMCP restart');
  }
  child.unref();
  return 'ReMCP Agent (restart scheduled)';
}

export async function executeWindowsTaskRestart({
  pause = ms => new Promise(resolve => setTimeout(resolve,ms)),
  invoke = spawnSync,
} = {}) {
  await pause(2500);
  // Do not run a second agent if Windows refused to stop the owned task.
  const stopped = invoke('schtasks.exe', ['/End','/TN',windowsTaskName], options);
  if (stopped.error || stopped.status !== 0) {
    throw new Error('Windows ReMCP task could not be stopped safely');
  }
  const started = invoke('schtasks.exe', ['/Run','/TN',windowsTaskName], options);
  if (started.error || started.status !== 0) {
    throw new Error('Windows ReMCP task could not be started after stop');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === helperPath) {
  if (process.argv[2] !== '--relaunch' || process.argv.length !== 3 || process.platform !== 'win32') {
    process.exitCode = 2;
  } else {
    executeWindowsTaskRestart().catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
