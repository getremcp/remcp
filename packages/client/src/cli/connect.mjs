// Pairing a computer: the browser handshake a person approves, and the trust check that decides
// whether a custom server may name the local runtime version.
import os from 'node:os';
import process from 'node:process';
import { spawn } from 'node:child_process';

import { ensureMachineId } from './config.mjs';
import { officialOrigin } from './env.mjs';
import { sleep } from './shell.mjs';
import { printPairingQr } from './pairing-qr.mjs';

// Keep the server-provided approval URL as data all the way to the OS. In particular, do not route it
// through `cmd /c start` on Windows: cmd reparses metacharacters such as `&`, so a custom pairing
// server could otherwise turn a verification URL into a local shell command.
export function browserLaunchCommand(url, platform = process.platform) {
  const target = String(url);
  if (platform === 'darwin') return { command: 'open', args: [target] };
  if (platform === 'win32') return { command: 'explorer.exe', args: [target] };
  return { command: 'xdg-open', args: [target] };
}

// Opens the approval page in the person's browser. A machine that nobody is looking at only gets the
// printed URL, so every failure here is silent and non-fatal.
export function openInBrowser(url) {
  try {
    const { command, args } = browserLaunchCommand(url);
    const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

export function assertSecureServerUrl(value, { allowInsecure = false } = {}) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error('server must be a valid URL'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('server must use http or https');
  if (url.username || url.password) throw new Error('server must not embed credentials');
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol === 'http:' && !loopback && !allowInsecure) throw new Error('Remote server must use https');
  url.hash = '';
  url.search = '';
  return url.href.replace(/\/$/, '');
}

const TRANSIENT_FETCH_RETRY_DELAY_MS = 150;

async function fetchWithTransientRetry(url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    // Node/undici reports transport failures (connection reset/refused, socket close, timeout)
    // as TypeError("fetch failed"). HTTP responses never enter this branch, so auth/server
    // rejections remain fail-closed and are not retried here.
    if (!(error instanceof TypeError)) throw error;
    await sleep(TRANSIENT_FETCH_RETRY_DELAY_MS);
    return fetch(url, options);
  }
}

// Device authorization (RFC 8628): the computer asks for a code, the person approves it in the
// browser while signed in, and this process collects the credential by polling. The device never
// sees a browser session or an account password.
export async function pairWithDeviceCode(server, flags) {
  server = assertSecureServerUrl(server, { allowInsecure: flags?.['allow-insecure-transport'] === true });
  const authorization = await fetchWithTransientRetry(`${server}/oauth/device_authorization`, {
    redirect: 'error',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: String(flags.name || os.hostname()),
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      machineId: ensureMachineId(),
    }),
  });
  if (!authorization.ok) throw new Error(`Pairing failed (${authorization.status}): ${await authorization.text()}`);
  const grant = await authorization.json();
  const approvalUrl = grant.verification_uri_complete || grant.verification_uri;
  console.log(`Approve this computer in your browser: ${approvalUrl}`);
  console.log(`Pairing code: ${grant.user_code}  (expires in ${Math.max(1, Math.round(Number(grant.expires_in || 600) / 60))} minutes)`);
  if (flags?.['no-qr'] !== true) printPairingQr({ server, approvalUrl, userCode: grant.user_code });
  openInBrowser(approvalUrl);
  console.log('Waiting for approval… (Ctrl+C to cancel)');
  const deadline = Date.now() + (Number(grant.expires_in) || 600) * 1000;
  let lastReminder = Date.now();
  const intervalMs = Math.max(1, Number(grant.interval) || 5) * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const response = await fetchWithTransientRetry(`${server}/oauth/token`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: String(grant.device_code || ''),
        machineId: ensureMachineId(),
      }).toString(),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.device_token) return data;
    if (data.error === 'authorization_pending' || data.error === 'slow_down') {
      if (Date.now() - lastReminder > 60_000) {
        lastReminder = Date.now();
        const left = Math.max(0, Math.round((deadline - Date.now()) / 60_000));
        console.log(`Still waiting — approve at ${approvalUrl} (about ${left} min left)`);
      }
      continue;
    }
    if (data.error === 'access_denied') throw new Error('That pairing request was denied in the browser. Run the command again if it was not you.');
    if (data.error === 'expired_token') break;
    throw new Error(`Pairing failed (${response.status}): ${JSON.stringify(data)}`);
  }
  throw new Error('The pairing code expired before it was approved. Run the command again.');
}

export function assertRuntimeTrust(server, flags) {
  const origin = new URL(server).origin;
  if (origin !== officialOrigin && !flags['trust-runtime']) {
    throw new Error('Custom servers can provide local runtime metadata. Re-run with --trust-runtime only if you trust that server.');
  }
}
