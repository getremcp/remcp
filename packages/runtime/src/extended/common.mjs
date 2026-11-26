import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile, spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { ToolError, fail, structured, text } from '../util.mjs';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;

export function clamp(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function desktopSessionAvailable({
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform === 'win32' || platform === 'darwin') return true;
  if (platform !== 'linux') return false;
  return Boolean(String(env?.DISPLAY || '').trim() || String(env?.WAYLAND_DISPLAY || '').trim());
}

export function requireEnum(value, field, allowed) {
  const normalized = String(value ?? '');
  if (!allowed.includes(normalized)) fail(`${field} must be one of: ${allowed.join(', ')}`);
  return normalized;
}

export function jsonResult(value) {
  return structured(value);
}

// Recording must observe MCP cancellation and wait for child exit before
// removing staging files. In particular GJS needs its own sender to Stop.
async function runRecordingFile(file,args,options,timeout){
  options.signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    // A recorder owns a separate POSIX process group. Cancellation must
    // reach its wrapper/children, never the calling runtime's own group.
    const group=process.platform!=='win32';
    const child=spawn(file,args.map(String),{
      cwd:options.cwd,env:options.env||process.env,windowsHide:true,
      detached:group,stdio:['ignore','pipe','pipe'],
    });
    const stdout=[],stderr=[];
    const max=clamp(options.maxBuffer,MAX_BUFFER,1024,64*1024*1024);
    let bytes=0,failure=null,escalation=null,drain=null,exited=false,settled=false;
    const label=options.label||file;
    const sendSignal=signal=>{
      // Never signal a recycled group identifier after observing leader exit.
      if(exited||child.exitCode!==null||child.signalCode!==null||!child.pid)return;
      try{if(group)process.kill(-child.pid,signal);else child.kill(signal);}
      catch{failure||=new ToolError(label+' could not signal the recording process');}
    };
    const stop=reason=>{
      if(failure)return;
      failure=new ToolError(label+' '+reason);
      // Give GJS its bounded D-Bus Stop call and GNU timeout its cleanup.
      sendSignal('SIGTERM');
      escalation=setTimeout(()=>sendSignal('SIGKILL'),22_000);
      escalation.unref?.();
    };
    const onAbort=()=>stop('cancelled');
    const timer=setTimeout(()=>stop('timed out'),timeout);
    const collect=target=>chunk=>{
      if(failure)return;
      bytes+=chunk.length;
      if(bytes>max){stop('exceeded its output limit');return;}
      target.push(chunk);
    };
    child.stdout.on('data',collect(stdout));
    child.stderr.on('data',collect(stderr));
    const cleanup=()=>{
      clearTimeout(timer);
      clearTimeout(escalation);
      clearTimeout(drain);
      options.signal?.removeEventListener('abort',onAbort);
    };
    child.once('error',()=>{failure||=new ToolError(label+' could not start or stop');});
    child.once('exit',()=>{
      exited=true;
      clearTimeout(escalation);
      // Node's close event waits for inherited stdio. A descendant can
      // retain a pipe after the actual recorder exited. Do not wait forever
      // or report a successful recording with unconfirmed output ownership.
      drain=setTimeout(()=>{
        if(settled)return;
        settled=true;
        cleanup();
        child.stdout.destroy();
        child.stderr.destroy();
        reject(failure||new ToolError(label+' output streams did not close after recorder exit'));
      },1000);
    });
    child.once('close',(code,signal)=>{
      if(settled)return;
      settled=true;
      cleanup();
      if(failure)return reject(failure);
      if(signal||!Number.isInteger(code))return reject(new ToolError(label+' terminated without a valid exit code'));
      const result={stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),code};
      if(code===0||options.allowFailure)return resolve(result);
      reject(new ToolError(label+' failed: '+(result.stderr.trim().slice(0,2000)||'exit '+code)));
    });
    options.signal?.addEventListener('abort',onAbort,{once:true});
    if(options.signal?.aborted)onAbort();
  });
}

export async function runFile(file, args = [], options = {}) {
  // Only trusted internal callers may opt into a bounded finalization margin.
  const timeout = clamp(options.timeout, 15_000, 100, options.recordingFinalization===true?150_000:120_000);
  if(options.recordingFinalization===true)return runRecordingFile(file,args,options,timeout);
  try {
    const result = await execFileAsync(file, args.map(String), {
      cwd: options.cwd,
      env: options.env || process.env,
      timeout,
      windowsHide: true,
      maxBuffer: options.maxBuffer || MAX_BUFFER,
      encoding: 'utf8',
    });
    return { ...result, code: 0 };
  } catch (error) {
    if (options.allowFailure) {
      return { stdout: String(error?.stdout || ''), stderr: String(error?.stderr || ''), code: error?.code ?? 1, error };
    }
    // execFile's fallback error.message embeds the entire command line, which
    // can contain a file path, a PowerShell script, or caller-supplied data.
    // Prefer real stderr; otherwise report a bounded status without arguments.
    const stderr = String(error?.stderr || '').trim();
    const code = error?.code;
    const status = error?.killed ? `timed out after ${timeout} ms`
      : Number.isInteger(code) ? `exited with code ${code}`
      : ['ENOENT','EACCES','EPERM','ETIMEDOUT','ENOSPC'].includes(code)
        ? `OS error ${code}` : 'process failed without diagnostic stderr';
    throw new ToolError(`${options.label || file} failed: ${stderr ? stderr.slice(0, 2000) : status}`);
  }
}

export async function runWithInput(file, args = [], input = '', options = {}) {
  const timeout = clamp(options.timeout, 15_000, 100, 120_000);
  const maxBuffer = clamp(options.maxBuffer, MAX_BUFFER, 1024, 64 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args.map(String), {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out = [];
    const err = [];
    let buffered = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new ToolError(`${options.label || file} timed out after ${timeout} ms`));
    }, timeout);
    const collect = target => chunk => {
      if (settled) return;
      buffered += chunk.length;
      if (buffered > maxBuffer) {
        child.kill('SIGKILL');
        finish(reject, new ToolError(`${options.label || file} exceeded the ${maxBuffer} byte output limit`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.on('error', error => {
      finish(reject, new ToolError(`${options.label || file} failed: ${error.message}`));
    });
    child.on('close', code => {
      if (settled) return;
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0 || options.allowFailure) finish(resolve, { stdout, stderr, code });
      else finish(reject, new ToolError(`${options.label || file} failed: ${stderr.trim() || `exit ${code}`}`));
    });
    child.stdin.on('error', error => {
      if (settled) return;
      child.kill('SIGKILL');
      finish(reject, new ToolError(`${options.label || file} input failed: ${error.message}`));
    });
    const inputText = String(input);
    if (inputText.length) child.stdin.end(inputText);
    else child.stdin.end();
  });
}

export async function runFileHeadLines(file, args = [], lineLimit = 200, options = {}) {
  const timeout = clamp(options.timeout, 15_000, 100, 120_000);
  const limit = clamp(lineLimit, 200, 1, 5000);
  const maxBuffer = clamp(options.maxBuffer, 1024 * 1024, 1024, 64 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args.map(String), {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const decoder = new StringDecoder('utf8');
    const lines = [];
    const err = [];
    let pending = '';
    let buffered = 0;
    let settled = false;
    let reachedLimit = false;
    let hardKillTimer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      fn(value);
    };
    const stopAfterLimit = () => {
      if (reachedLimit) return;
      reachedLimit = true;
      child.kill('SIGTERM');
      hardKillTimer = setTimeout(() => child.kill('SIGKILL'), 250);
      hardKillTimer.unref?.();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new ToolError(`${options.label || file} timed out after ${timeout} ms`));
    }, timeout);
    child.stdout.on('data', chunk => {
      if (settled || reachedLimit) return;
      buffered += chunk.length;
      if (buffered > maxBuffer) {
        child.kill('SIGKILL');
        finish(reject, new ToolError(`${options.label || file} exceeded the ${maxBuffer} byte output limit before producing ${limit} lines`));
        return;
      }
      pending += decoder.write(chunk);
      while (lines.length < limit) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        lines.push(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (lines.length >= limit) stopAfterLimit();
    });
    child.stderr.on('data', chunk => {
      if (settled || reachedLimit) return;
      buffered += chunk.length;
      if (buffered > maxBuffer) {
        child.kill('SIGKILL');
        finish(reject, new ToolError(`${options.label || file} exceeded the ${maxBuffer} byte output limit`));
        return;
      }
      err.push(chunk);
    });
    child.on('error', error => finish(reject, new ToolError(`${options.label || file} failed: ${error.message}`)));
    child.on('close', code => {
      if (settled) return;
      if (!reachedLimit) {
        pending += decoder.end();
        if (pending && lines.length < limit) lines.push(pending);
      }
      const stdout = lines.slice(0, limit).join('\n');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0 || reachedLimit || options.allowFailure) finish(resolve, { stdout, stderr, code, truncated: reachedLimit });
      else finish(reject, new ToolError(`${options.label || file} failed: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

// Windows PowerShell writes redirected stdout in the OEM code page by default,
// which corrupts Unicode names and clipboard text. Emit UTF-8 without a BOM.
const WINDOWS_UTF8_OUTPUT = '[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false;';

// Inline runtime commands do not require an execution-policy override.
// Respect enterprise PowerShell policy rather than forcing Bypass on every call.
export function windowsPowerShellArguments(script) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_UTF8_OUTPUT + script];
}

export async function runPowerShell(script, options = {}) {
  const executable = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  return runFile(executable, windowsPowerShellArguments(script), {
    ...options,
    label: options.label || 'PowerShell',
  });
}

export async function runOsa(script, options = {}) {
  const args = options.javascript ? ['-l', 'JavaScript', '-e', script] : ['-e', script];
  return runFile('/usr/bin/osascript', args, { ...options, label: options.label || 'osascript' });
}

export function escapeAppleScript(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
}

export function escapePowerShellSingle(value) {
  return String(value).replace(/'/g, "''");
}

export function commandExists(command) {
  if (!command) return false;
  if (path.isAbsolute(command)) return existsSync(command);
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  return dirs.some(dir => extensions.some(ext => existsSync(path.join(dir, process.platform === 'win32' ? `${command}${ext}` : command))));
}

export function spawnDetached(file, args = [], options = {}) {
  const child = spawn(file, args.map(String), {
    cwd: options.cwd,
    env: options.env || process.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  // Opt-in process lifecycle callbacks for long-lived detached services.
  // Do not forward command arguments or OS error messages into telemetry.
  if (typeof options.onExit === 'function') {
    child.once('exit', (code, signal) => {
      try { options.onExit({ pid: child.pid ?? null, code, signal }); } catch {}
    });
  }
  if (typeof options.onError === 'function') {
    child.once('error', error => {
      try { options.onError({ pid: child.pid ?? null, code: String(error?.code || 'UNKNOWN') }); } catch {}
    });
  }
  child.unref();
  return child.pid;
}

export async function spawnDetachedWithInput(file, args = [], input = '', options = {}) {
  const timeout = clamp(options.timeout, 3000, 100, 30_000);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args.map(String), {
      cwd: options.cwd,
      env: options.env || process.env,
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(reject, new ToolError(`${options.label || file} did not accept input within ${timeout} ms`));
    }, timeout);
    child.once('error', error => finish(reject, new ToolError(`${options.label || file} failed: ${error.message}`)));
    child.once('spawn', () => {
      child.unref();
      child.stdin.once('error', error => finish(reject, new ToolError(`${options.label || file} failed while writing input: ${error.message}`)));
      child.stdin.end(String(input), error => {
        if (error) finish(reject, new ToolError(`${options.label || file} failed while writing input: ${error.message}`));
        else finish(resolve, child.pid);
      });
    });
  });
}

export async function readPrivateTempFile(file, maxBytes) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ToolError('Temporary capture is not a regular file');
    if (info.size > maxBytes) throw new ToolError(`Captured file is ${info.size} bytes, above the ${maxBytes}-byte inline limit`);
    return { info, data: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

export async function tempDir(prefix = 'remcp-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeTemp(dir) {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

export function secretLike(key) {
  return /(TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|AUTH|BEARER|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CREDENTIAL|SESSION|DATABASE[_-]?URL|REDIS[_-]?URL|CONNECTION[_-]?STRING|DSN)/i.test(String(key));
}

function credentialBearingUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return Boolean(url.username || url.password);
  } catch { return false; }
}

export function safeEnvironment() {
  return Object.fromEntries(Object.entries(process.env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, secretLike(key) || credentialBearingUrl(value) ? '***' : String(value ?? '')]));
}

export function unavailable(feature, hint = '') {
  fail(`${feature} is not available on this computer${hint ? `: ${hint}` : ''}`);
}
