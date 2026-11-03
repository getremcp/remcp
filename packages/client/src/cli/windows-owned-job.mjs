import path from 'node:path';
import { spawn } from 'node:child_process';
import { windowsOwnedJobScript } from './windows-owned-job-source.mjs';

function quote(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid owned-job argument');
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

// The helper owns an unnamed kernel job; no PID enumeration or taskkill is used.
// Acknowledgement is emitted only after the job's ActiveProcesses count reaches zero.
export function spawnWindowsOwnedJob(application, args, { cwd, log, env = process.env } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows owned jobs require Windows');
  if (![application, cwd, log].every(p => typeof p === 'string' && !p.includes('\0') && path.isAbsolute(p))) {
    throw new Error('Owned-job paths must be absolute');
  }
  const command = [application, ...args].map(quote).join(' ');
  if (command.length > 32766) throw new Error('Owned-job command line is too long');
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helper = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(windowsOwnedJobScript, 'utf16le').toString('base64')], {
    cwd:path.dirname(powershell), env, windowsHide:true, stdio:['pipe','pipe','pipe'],
  });
  let output = '', stderr = '', started = false, empty = false, settled = false;
  let resolveReady, rejectReady, resolveDone, rejectDone;
  const ready = new Promise((resolve, reject) => { resolveReady=resolve; rejectReady=reject; });
  const done = new Promise((resolve, reject) => { resolveDone=resolve; rejectDone=reject; });
  // Callers may observe readiness and completion separately; suppress unhandled rejection noise.
  ready.catch(() => {}); done.catch(() => {});
  const fail = error => { rejectReady(error); rejectDone(error); };
  const timer = setTimeout(() => { fail(new Error('Windows job startup timed out')); helper.kill(); }, 15000);
  helper.stdin.on('error', () => {});
  helper.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2048); });
  helper.stdout.on('data', chunk => {
    output += chunk.toString('utf8');
    if (output.length > 4096) { fail(new Error('Invalid Windows job response')); helper.kill(); return; }
    while (output.includes('\n')) {
      const index = output.indexOf('\n'), line = output.slice(0,index).trim(); output=output.slice(index+1);
      try {
        const message = JSON.parse(line);
        if (message.ready === true && !started) {
          // ASCII envelope survives Windows PowerShell 5.1's OEM console codepage.
          helper.stdin.write(Buffer.from(JSON.stringify({application,command,cwd,log}),'utf8').toString('base64') + '\n');
        } else if (message.started === true && Number.isSafeInteger(message.pid) && message.pid > 0 && !started) {
          started=true; helper.ownedJob.running=true; helper.ownedJob.pid=message.pid;
          clearTimeout(timer); resolveReady(message);
        } else if (message.empty === true && started) { empty=true; helper.ownedJob.running=false; }
        else throw new Error('Unexpected Windows job response');
      } catch { fail(new Error('Invalid Windows job response')); helper.kill(); }
    }
  });
  helper.on('error', error => { clearTimeout(timer); fail(error); });
  helper.on('close', code => {
    clearTimeout(timer); helper.ownedJob.running=false; settled=true;
    helper.ownedJob.confirmedEmpty = code === 0 && started && empty;
    if (helper.ownedJob.confirmedEmpty) resolveDone();
    else fail(new Error('Windows owned job failed: ' + stderr.trim().slice(0,300)));
    if (!started) rejectReady(new Error('Windows job exited before readiness'));
  });
  helper.ownedJob = { ready, done, running:false, confirmedEmpty:false, pid:null, stop: async () => {
    if (!settled) helper.stdin.end('STOP\n');
    let timeout;
    try { await Promise.race([done, new Promise((_, reject) => {
      timeout=setTimeout(() => reject(new Error('Windows owned job stop timed out')), 9000);
    })]); } finally { clearTimeout(timeout); }
  }};
  return helper;
}
