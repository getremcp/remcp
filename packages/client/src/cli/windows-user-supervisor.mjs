// Single-instance, current-user Windows Startup supervisor with authenticated local control.
// Owns its child PID; never enumerates or kills unrelated node.exe/cmd.exe processes.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnWindowsOwnedJob } from './windows-owned-job.mjs';

const currentFile = fileURLToPath(import.meta.url);
const root = process.env.REMCP_CONFIG_DIR || path.join(os.homedir(), '.config', 'remcp');
const keyFile = path.join(root, 'windows-startup-control.key');
const actions = new Set(['status', 'stop', 'restart']);

export function windowsSupervisorPath(configDir = root, platform = process.platform) {
  const id = crypto.createHash('sha256').update(path.resolve(configDir)).digest('hex').slice(0, 32);
  return platform === 'win32' ? '\\\\.\\pipe\\remcp-user-' + id
    : path.join(os.tmpdir(), 'remcp-user-' + id + '.sock');
}

export function ensureWindowsSupervisorKey() {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(keyFile, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(keyFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 32) {
    throw new Error('Invalid ReMCP supervisor control key');
  }
  return fs.readFileSync(keyFile);
}

function signature(secret, action, nonce) {
  return crypto.createHmac('sha256', secret).update(action + ':' + nonce).digest('hex');
}

export async function windowsSupervisorRequest(action, { timeoutMs = action === 'stop' ? 14500 : 4000 } = {}) {
  if (!actions.has(action)) throw new Error('Invalid Windows supervisor action');
  const secret = fs.readFileSync(keyFile);
  if (secret.length !== 32) throw new Error('Invalid supervisor key');
  const nonce = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(windowsSupervisorPath());
    let output = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Supervisor timed out')); }, timeoutMs);
    socket.on('connect', () => socket.write(JSON.stringify({
      action, nonce, mac: signature(secret, action, nonce),
    }) + '\n'));
    socket.on('data', chunk => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > 2048) socket.destroy(new Error('Supervisor reply too large'));
    });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(output.trim());
        const { mac, nonce: replyNonce, ...body } = result;
        if (replyNonce !== nonce || !/^[a-f0-9]{64}$/.test(String(mac))) {
          throw new Error('Unauthenticated supervisor reply');
        }
        const expected = signature(secret, 'reply', nonce + ':' + JSON.stringify(body));
        if (!crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'))) {
          throw new Error('Untrusted supervisor reply');
        }
        if (!body.ok) throw new Error(body.error || 'Supervisor rejected command');
        resolve(body);
      } catch (error) { reject(error); }
    });
  });
}

// Synchronous callers in the installed CLI use a separate Node client.
// Never pass device tokens or control keys in command-line arguments.
export function windowsSupervisorCommand(action, { timeoutMs = action === 'stop' ? 20000 : 15000 } = {}) {
  if (!actions.has(action) && action !== 'wait') throw new Error('Invalid supervisor action');
  const proc = spawnSync(process.execPath, [currentFile, 'control', action], {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 8192,
  });
  if (proc.error || proc.status !== 0) throw new Error(
    'ReMCP user supervisor ' + action + ' failed: ' +
      String(proc.stderr || proc.error?.message || proc.stdout || 'unavailable').trim().slice(0, 300));
  try { return JSON.parse(proc.stdout.trim()); }
  catch { throw new Error('Invalid supervisor status'); }
}

async function serve(cliEntry) {
  if (!path.isAbsolute(cliEntry) || !fs.existsSync(cliEntry)) throw new Error('Invalid ReMCP CLI entry');
  const secret = ensureWindowsSupervisorKey();
  let child = null;
  let stopped = false;
  let restartTimer = null;
  let requestedRestart = null;
  let startedAt = 0;
  let lastExit = null;
  let containmentFailure = null;
  const usedNonces = new Set();

  function start() {
    if (stopped || child || containmentFailure) return;
    const logFile = path.join(root, 'windows-startup-agent.log');
    try { if (fs.statSync(logFile).size > 4 * 1024 * 1024) fs.truncateSync(logFile, 0); } catch {}
    const log = fs.openSync(logFile, 'a', 0o600);
    const prefix = path.resolve(path.dirname(cliEntry), '../../../../');
    try {
      const env = { ...process.env, REMCP_USER_STARTUP_SUPERVISOR:'1', NPM_CONFIG_PREFIX: prefix,
        PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') };
      child = process.platform === 'win32'
        ? spawnWindowsOwnedJob(process.execPath, [cliEntry, 'start', '--service'], {cwd:root,log:logFile,env})
        : spawn(process.execPath, [cliEntry, 'start', '--service'], {
          cwd:root, windowsHide:true, stdio:['ignore',log,log,'ipc'], env,
        });
    } finally { fs.closeSync(log); }
    const ownChild = child;
    startedAt = Date.now();
    ownChild.ownedJob?.ready.then(() => { startedAt=Date.now(); }).catch(error => { lastExit=error.message; });
    ownChild.ownedJob?.done.catch(error => { lastExit=error.message; });
    ownChild.on('error', error => {
      lastExit = error.message;
      if (ownChild.ownedJob) {
        containmentFailure = new Error('Windows job ownership failed; restart refused');
        stopped=true;
        return; // Retain the owner until close; only confirmedEmpty can release it.
      }
      if (child === ownChild) {
        child = null;
        if (!stopped) restartTimer = setTimeout(start, 3000);
      }
    });
    ownChild.on('close', (code, signal) => {
      if (child !== ownChild) return;
      child = null;
      // Completion failure does not prove the previous tree is empty. Fail closed.
      if (ownChild.ownedJob && !ownChild.ownedJob.confirmedEmpty) {
        containmentFailure = new Error('Windows job did not confirm an empty process tree; restart refused');
        stopped=true; lastExit=containmentFailure.message; return;
      }
      lastExit = code === null ? String(signal || 'unknown') : String(code);
      if (!stopped) restartTimer = setTimeout(start, 3000);
    });
  }

  async function endChild() {
    clearTimeout(restartTimer);
    if (containmentFailure) throw containmentFailure;
    const ownChild = child;
    if (!ownChild) return;
    if (ownChild.ownedJob) { await ownChild.ownedJob.stop(); return; }
    if (ownChild.exitCode === null && !ownChild.killed) {
      ownChild.kill('SIGTERM');
    }
    if (ownChild.exitCode === null) await Promise.race([
      new Promise(resolve => ownChild.once('exit', resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Agent exit timed out')), 4500)),
    ]);
  }

  const server = net.createServer(socket => {
    socket.on('error', () => {}); // A disconnected local client must not crash the agent.
    socket.setTimeout(15000, () => socket.destroy());
    let input = '';
    socket.on('data', chunk => {
      input += chunk.toString('utf8');
      if (Buffer.byteLength(input) > 1024) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      const raw = input.slice(0, input.indexOf('\n'));
      input = '';
      void (async () => {
        try {
          const request = JSON.parse(raw);
          const reply = body => socket.end(JSON.stringify({ ...body, nonce: request.nonce,
            mac: signature(secret, 'reply', request.nonce + ':' + JSON.stringify(body)) }) + '\n');
          if (!actions.has(request.action) ||
              !/^[a-f0-9]{32}$/.test(String(request.nonce)) ||
              !/^[a-f0-9]{64}$/.test(String(request.mac)) ||
              usedNonces.has(request.nonce) ||
              !crypto.timingSafeEqual(Buffer.from(request.mac, 'hex'),
                Buffer.from(signature(secret, request.action, request.nonce), 'hex'))) {
            throw new Error('Unauthorized supervisor request');
          }
          usedNonces.add(request.nonce);
          if (usedNonces.size > 128) usedNonces.clear();
          if (request.action === 'stop') {
            clearTimeout(requestedRestart);
            requestedRestart = null;
            stopped = true;
            await endChild();
            reply({ ok: true, stopped: true });
            server.close(() => {
              if (process.platform !== 'win32') {
                try { fs.unlinkSync(windowsSupervisorPath()); } catch {}
              }
              process.exit(0);
            });
          } else if (request.action === 'restart') {
            if (containmentFailure) throw containmentFailure;
            // Agent-initiated npm updates call this from a child of the current agent.
            // Killing that tree before the update CLI returns can abort the updater itself.
            // Coalesce requests and schedule the owned-child handoff after acknowledgement.
            if (!requestedRestart) {
              requestedRestart = setTimeout(() => {
                requestedRestart = null;
                void (async () => {
                  stopped = true;
                  try { await endChild(); }
                  catch (error) { console.error('ReMCP supervisor restart failed:', error.message); }
                  finally { if (!containmentFailure) { stopped = false; if (!child) start(); } }
                })();
              }, 2500);
            }
            reply({ ok: true, restartScheduled: true });
          } else reply({
            ok: true, childPid: child?.ownedJob?.pid || child?.pid || null,
            running: Boolean(child?.pid && child.exitCode === null && (!child.ownedJob || child.ownedJob.running)),
            restartPending: Boolean(requestedRestart),
            uptimeMs: child ? Date.now() - startedAt : null, lastExit,
          });
        } catch (error) { socket.end(JSON.stringify({ ok: false, error: error.message }) + '\n'); }
      })();
    });
  });
  server.maxConnections = 16;
  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      // A second logon or repeated Startup invocation must never create a second agent.
      process.exitCode = 0;
    } else { console.error('ReMCP supervisor:', error.message); process.exitCode = 1; }
  });
  server.listen(windowsSupervisorPath(), start);
}

async function control(action) {
  if (action === 'stop') {
    const result = await windowsSupervisorRequest('stop');
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      try { await windowsSupervisorRequest('status', { timeoutMs: 450 }); }
      catch (error) {
        if (['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(error?.code)) return result;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Windows Startup supervisor has not exited after stop');
  }
  if (action !== 'wait') return windowsSupervisorRequest(action);
  const deadline = Date.now() + 11000;
  while (Date.now() < deadline) {
    try {
      const current = await windowsSupervisorRequest('status', { timeoutMs: 1000 });
      if (current.running && current.uptimeMs >= 700) return current;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Supervisor did not start');
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  if (process.argv[2] === 'serve') void serve(process.argv[3])
    .catch(error => { console.error(error.message); process.exitCode = 1; });
  else if (process.argv[2] === 'control') void control(process.argv[3])
    .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
