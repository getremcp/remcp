// Best-effort host measurements. Keep interface names, mount paths and sensor labels bounded;
// never expose raw process arguments or arbitrary kernel sensor metadata.
import { readFile, readdir, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { darwinTemperatureReadings } from './darwin-temperature.mjs';
import { linuxTemperatureReadings } from './linux-temperature.mjs';
import { windowsTemperatureReadings } from './windows-temperature.mjs';

const run = promisify(execFile);
const numeric = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const safeName = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,40}$/.test(value);

export function parseNetworkCounters(input) {
  const interfaces = [];
  for (const line of String(input).split('\n').slice(2, 130)) {
    const match = line.match(/^\s*([^:\s]+):\s*(.+)$/);
    if (!match || !safeName(match[1]) || match[1] === 'lo') continue;
    const columns = match[2].trim().split(/\s+/);
    const rx = Number(columns[0]);
    const tx = Number(columns[8]);
    if (!numeric(rx) || !numeric(tx) || columns.length < 16) continue;
    interfaces.push({ name: match[1], rx, tx });
    if (interfaces.length >= 24) break;
  }
  return interfaces;
}

// netstat -ib has multiple address rows per interface on macOS. Only the
// <Link#N> row contains the canonical byte counters; never sum duplicates.
export function parseDarwinNetworkCounters(input, activeNames = null) {
  const lines = String(input).split(/\r?\n/);
  const header = lines[0]?.trim().split(/\s+/) ?? [];
  const rxIndex = header.indexOf('Ibytes');
  const txIndex = header.indexOf('Obytes');
  if (rxIndex < 0 || txIndex < 0) return [];
  const found = new Map();
  for (const line of lines.slice(1, 160)) {
    const parts = line.trim().split(/\s+/);
    const name = parts[0];
    if (!safeName(name) || !/^<Link#\d+>$/.test(parts[2]) ||
        /^(?:lo\d*|awdl\d*|llw\d*|utun\d*|bridge\d*|gif\d*|stf\d*|ap\d*|anpi\d*)$/.test(name) ||
        (activeNames && !activeNames.has(name))) continue;
    const rx = Number(parts[rxIndex]);
    const tx = Number(parts[txIndex]);
    if (!numeric(rx) || !numeric(tx)) continue;
    found.set(name, { name, rx, tx });
    if (found.size >= 24) break;
  }
  return [...found.values()];
}

// Windows adapter statistics are real cumulative counters, not link-speed estimates.
export function parseWindowsNetworkCounters(input, activeNames = null) {
  let parsed;
  try { parsed = JSON.parse(String(input)); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const found = new Map();
  for (const row of rows.slice(0, 128)) {
    const name = row?.Name;
    if (typeof name !== 'string' || !/^[\p{L}\p{N} _().:#-]{1,64}$/u.test(name) ||
        (activeNames && !activeNames.has(name))) continue;
    const parseCounter = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? value : typeof value === 'string' && /^\d{1,16}$/.test(value) && numeric(Number(value))
        ? Number(value) : null;
    const rx = parseCounter(row?.ReceivedBytes);
    const tx = parseCounter(row?.SentBytes);
    if (rx === null || tx === null) continue;
    found.set(name, { name, rx, tx });
    if (found.size >= 24) break;
  }
  return [...found.values()];
}

// netsh exposes cumulative interface bytes even on Windows hosts where the
// NetAdapterStatistics PowerShell provider returns no entries. Match columns
// rather than localized header words; reject unsafe aliases and fake rates.
export function parseWindowsNetshCounters(input, activeNames = null) {
  const found = new Map();
  for (const line of String(input).split(/\r?\n/).slice(0, 130)) {
    const match = line.match(/^\s*\d{1,10}\s+1\s+(\d{1,16})\s+(\d{1,16})\s+(.+?)\s*$/u);
    if (!match) continue;
    const name = match[3];
    if (!/^[\p{L}\p{N} _().:#-]{1,64}$/u.test(name) ||
        (activeNames && !activeNames.has(name))) continue;
    const rx = Number(match[1]), tx = Number(match[2]);
    if (!numeric(rx) || !numeric(tx)) continue;
    found.set(name, { name, rx, tx });
    if (found.size >= 24) break;
  }
  return [...found.values()];
}

export function calculateNetworkRates(current, previous, elapsedSeconds) {
  if (!Array.isArray(current) || !Array.isArray(previous) || !Number.isFinite(elapsedSeconds) ||
      elapsedSeconds < 1 || elapsedSeconds > 300) return null;
  const old = new Map(previous.map(row => [row.name, row]));
  const interfaces = current.flatMap(row => {
    const prior = old.get(row.name);
    if (!prior || !numeric(row.rx) || !numeric(row.tx) || row.rx < prior.rx || row.tx < prior.tx) return [];
    const rxBytesPerSecond = Math.round((row.rx - prior.rx) / elapsedSeconds);
    const txBytesPerSecond = Math.round((row.tx - prior.tx) / elapsedSeconds);
    return [{ name: row.name, rxBytesPerSecond, txBytesPerSecond }];
  });
  if (!interfaces.length) return null;
  return {
    rxBytesPerSecond: interfaces.reduce((sum, row) => sum + row.rxBytesPerSecond, 0),
    txBytesPerSecond: interfaces.reduce((sum, row) => sum + row.txBytesPerSecond, 0),
    interfaces,
  };
}

let lastNetwork = null;
let pendingNetwork = null;

async function readNetworkCounters() {
  if (process.platform === 'linux') {
    const active = new Set(Object.entries(os.networkInterfaces())
      .filter(([, addresses]) => addresses?.some(address => !address.internal))
      .map(([name]) => name));
    return parseNetworkCounters(await readFile('/proc/net/dev', 'utf8'))
      .filter(row => active.has(row.name) && !/^(?:veth|docker|br-|virbr|tun|tap|wg|lo)/.test(row.name));
  }
  if (process.platform === 'darwin') {
    const { stdout } = await run('/usr/sbin/netstat', ['-ibn'],
      { timeout: 2500, maxBuffer: 128 * 1024 });
    const active = new Set(Object.entries(os.networkInterfaces())
      .filter(([, addresses]) => addresses?.some(address => !address.internal &&
        !address.address.startsWith('fe80:'))).map(([name]) => name));
    return parseDarwinNetworkCounters(stdout, active);
  }
  if (process.platform === 'win32') {
    const active = new Set(Object.entries(os.networkInterfaces())
      .filter(([, addresses]) => addresses?.some(address => !address.internal))
      .map(([name]) => name));
    try {
      const { stdout } = await run('netsh', ['interface', 'ipv4', 'show', 'subinterfaces'],
        { windowsHide: true, timeout: 2500, maxBuffer: 128 * 1024 });
      const counters = parseWindowsNetshCounters(stdout, active);
      if (counters.length) return counters;
    } catch { /* Fall through to the existing adapter provider. */ }
    try {
      const script = 'Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes | ConvertTo-Json -Compress';
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024 });
      return parseWindowsNetworkCounters(stdout, active);
    } catch { return []; }
  }
  return [];
}

async function sampleNetworkRates() {
  try {
    let current = await readNetworkCounters();
    let now = performance.now();
    let previous = lastNetwork;
    const elapsed = previous ? (now - previous.at) / 1000 : 0;
    // The first diagnostics request must return a measured rate, not null.
    // Bootstrap from two real counters; never manufacture a zero-rate sample.
    if (elapsed < 1 || elapsed > 300) {
      previous = { at: now, interfaces: current };
      await delay(1100);
      current = await readNetworkCounters();
      now = performance.now();
    }
    lastNetwork = { at: now, interfaces: current };
    return calculateNetworkRates(current, previous.interfaces, (now - previous.at) / 1000);
  } catch {
    lastNetwork = null;
    return null;
  }
}

export async function networkRates() {
  if (!['linux', 'darwin', 'win32'].includes(process.platform)) return null;
  if (pendingNetwork) return pendingNetwork;
  pendingNetwork = sampleNetworkRates();
  try { return await pendingNetwork; }
  finally { pendingNetwork = null; }
}

export async function thermalReadings() {
  if (process.platform === 'darwin') return darwinTemperatureReadings();
  if (process.platform === 'linux') return linuxTemperatureReadings();
  if (process.platform === 'win32') return windowsTemperatureReadings();
  return [];
}

export function parseDiskVolumes(input) {
  const volumes = [];
  const seen = new Set();
  for (const line of String(input).split('\n').slice(1, 256)) {
    const match = line.trim().match(/^(\/dev\/\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(\S+)$/);
    if (!match || seen.has(match[6])) continue;
    // Snap/loop and memory-backed devices are virtual mounts, not storage volumes.
    if (/^\/dev\/(?:loop\d+|zram\d+|ram\d+)$/.test(match[1])) continue;
    const [size, used, available] = match.slice(2, 5).map(Number);
    const percent = Number(match[5]);
    if (!numeric(size) || !numeric(used) || !numeric(available) || size <= 0 ||
        used > size || available > size || percent > 100 ||
        ![size, used, available].every(value => Number.isSafeInteger(value * 1024))) continue;
    const mount = match[6];
    if (mount.length > 100 || !/^\/[\w./ -]*$/.test(mount)) continue;
    seen.add(mount);
    volumes.push({ mount, totalBytes: size * 1024, usedBytes: used * 1024,
      availableBytes: available * 1024, usedRatio: Number((used / size).toFixed(3)) });
    if (volumes.length >= 12) break;
  }
  return volumes;
}

async function windowsDiskVolumes() {
  const volumes = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const mount = `${letter}:\\`;
    let timer;
    try {
      const info = await Promise.race([
        statfs(mount),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('volume probe timeout')), 250); }),
      ]);
      const totalBytes = Number(info.blocks) * Number(info.bsize);
      const freeBytes = Number(info.bfree) * Number(info.bsize);
      const availableBytes = Number(info.bavail) * Number(info.bsize);
      if (!Number.isFinite(totalBytes) || totalBytes <= 0) continue;
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      volumes.push({
        mount,
        totalBytes,
        usedBytes,
        availableBytes,
        usedRatio: Number((usedBytes / totalBytes).toFixed(3)),
      });
    } catch {}
    finally { clearTimeout(timer); }
  }
  return volumes;
}

export async function diskVolumes() {
  if (process.platform === 'win32') return windowsDiskVolumes();
  try {
    const { stdout } = await run('df', ['-kP'], { timeout: 2000, maxBuffer: 256 * 1024 });
    return parseDiskVolumes(stdout);
  } catch { return []; }
}
