import os from 'node:os';
import { VERSION } from './version.mjs';

export function normalizedServerUrl(value, { allowInsecure = false } = {}) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('serverUrl must use http or https');
  if (url.username || url.password) throw new Error('serverUrl must not embed credentials');
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol === 'http:' && !loopback && !allowInsecure) throw new Error('Remote serverUrl must use https');
  url.hash = '';
  url.search = '';
  return url.href.replace(/\/$/, '');
}

export function sendRelayMessage(socket, message) {
  if (socket?.readyState !== 1) return false;
  // The authenticated relay is ReMCP's explicit data boundary: model-requested tool results are
  // intentionally returned to the paired workspace and never to an arbitrary third-party URL.
  // codeql[js/file-access-to-http]
  socket.send(JSON.stringify(message));
  return true;
}

export function jitter(ms) {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

export function boundedReconnectDelay(value, fallbackMs = 150) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallbackMs;
  return Math.max(100, Math.min(60_000, Math.floor(parsed)));
}

// Device health is sampled locally and is the only thing ReMCP stores about the machine
// beyond its name, platform and last-seen time. No process list, no file names.
export function deviceMetrics(extra = {}) {
  const load = os.loadavg?.()[0] ?? 0;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    uptimeSeconds: Math.round(os.uptime()),
    agentUptimeSeconds: Math.round(process.uptime()),
    rssBytes: process.memoryUsage().rss,
    load1: Number.isFinite(load) ? Number(load.toFixed(2)) : 0,
    cpuCount: os.cpus?.().length ?? 0,
    freeMemoryRatio: totalMem > 0 ? Number((freeMem / totalMem).toFixed(3)) : 0,
    agentVersion: VERSION,
    ...extra,
  };
}
