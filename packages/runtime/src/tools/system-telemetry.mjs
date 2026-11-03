// Best-effort host measurements. Keep interface names, mount paths and sensor labels bounded;
// never expose raw process arguments or arbitrary kernel sensor metadata.
import { readFile, readdir } from 'node:fs/promises';
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

// `netstat -e` reports cumulative unicast + non-unicast packets even on some
// Windows NIC drivers whose byte counters are missing. The numeric rows are
// bytes, unicast and non-unicast in that order (labels can be localized).
// Packet rates are NOT byte throughput and must never be presented as B/s.
export function parseWindowsNetstatPackets(input) {
  const rows = String(input).split(/\r?\n/).slice(0,24)
    .map(line => line.match(/^\s*([^\d\r\n]+?)\s+(\d{1,18})\s+(\d{1,18})\s*$/))
    .filter(Boolean).map(row => [Number(row[2]), Number(row[3])]);
  if (rows.length < 3 || rows.slice(0,3).some(row => !numeric(row[0]) || !numeric(row[1]))) return [];
  const rx = rows[1][0] + rows[2][0];
  const tx = rows[1][1] + rows[2][1];
  return numeric(rx) && numeric(tx)
    ? [{ name: 'windows-all-adapters', rx, tx, unit: 'packets' }] : [];
}

export function calculateNetworkRates(current, previous, elapsedSeconds) {
  if (!Array.isArray(current) || !Array.isArray(previous) || !Number.isFinite(elapsedSeconds) ||
      elapsedSeconds < 1 || elapsedSeconds > 300) return null;
  if (current.length === 1 && current[0]?.unit === 'packets') {
    const row = current[0];
    const prior = previous.find(item => item.name === row.name && item.unit === 'packets');
    if (!prior || !numeric(row.rx) || !numeric(row.tx) ||
        row.rx < prior.rx || row.tx < prior.tx) return null;
    return {
      rxBytesPerSecond: null, txBytesPerSecond: null,
      rxPacketsPerSecond: Math.round((row.rx - prior.rx) / elapsedSeconds),
      txPacketsPerSecond: Math.round((row.tx - prior.tx) / elapsedSeconds),
      interfaces: [],
    };
  }
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
let windowsByteRetryAt = 0;

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
    if (Date.now() >= windowsByteRetryAt) {
      const script = 'Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes | ConvertTo-Json -Compress';
      try {
        const { stdout } = await run('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { windowsHide: true, timeout: 3500, maxBuffer: 128 * 1024 });
        const active = new Set(Object.entries(os.networkInterfaces())
          .filter(([, addresses]) => addresses?.some(address => !address.internal))
          .map(([name]) => name));
        const bytes = parseWindowsNetworkCounters(stdout, active);
        if (bytes.length) { windowsByteRetryAt = 0; return bytes; }
      } catch { /* Some virtual NICs have no adapter byte counters. */ }
      windowsByteRetryAt = Date.now() + 60_000;
    }
    const { stdout } = await run('netstat', ['-e'],
      { windowsHide: true, timeout: 2500, maxBuffer: 64 * 1024 });
    return parseWindowsNetstatPackets(stdout);
  }
  return [];
}

export async function sampleNetworkRates(readCounters = readNetworkCounters, wait = delay) {
  try {
    let current = await readCounters();
    // Some Windows NIC drivers report no byte counters at all. Do not run a
    // second expensive PowerShell probe or invent 0 B/s from missing data.
    if (!current.length) { lastNetwork = null; return null; }
    let now = performance.now();
    let previous = lastNetwork;
    const elapsed = previous ? (now - previous.at) / 1000 : 0;
    // The first diagnostics request must return a measured rate, not null.
    // Bootstrap from two real counters; never manufacture a zero-rate sample.
    if (elapsed < 1 || elapsed > 300) {
      previous = { at: now, interfaces: current };
      await wait(1100);
      current = await readCounters();
      if (!current.length) { lastNetwork = null; return null; }
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

export async function diskVolumes() {
  if (process.platform === 'win32') return [];
  try {
    const { stdout } = await run('df', ['-kP'], { timeout: 2000, maxBuffer: 256 * 1024 });
    return parseDiskVolumes(stdout);
  } catch { return []; }
}
