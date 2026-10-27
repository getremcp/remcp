// Best-effort host measurements. Keep interface names, mount paths and sensor labels bounded;
// never expose raw process arguments or arbitrary kernel sensor metadata.
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';

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
export async function networkRates() {
  if (process.platform !== 'linux') return null;
  try {
    const input = await readFile('/proc/net/dev', 'utf8');
    const current = parseNetworkCounters(input);
    const now = performance.now();
    const previous = lastNetwork;
    lastNetwork = { at: now, interfaces: current };
    return previous ? calculateNetworkRates(current, previous.interfaces, (now - previous.at) / 1000) : null;
  } catch {
    lastNetwork = null;
    return null;
  }
}

export async function thermalReadings() {
  if (process.platform !== 'linux') return [];
  const sensors = [];
  // Linux thermal zones expose millidegrees Celsius; only fixed kernel paths are read.
  try {
    const names = (await readdir('/sys/class/thermal')).filter(name => /^thermal_zone\d{1,3}$/.test(name)).slice(0, 16);
    for (const name of names) {
      try {
        const value = Number((await readFile('/sys/class/thermal/' + name + '/temp', 'utf8')).trim()) / 1000;
        if (Number.isFinite(value) && value >= -40 && value <= 125)
          sensors.push({ name: 'Thermal ' + name.slice(12), celsius: Number(value.toFixed(1)) });
      } catch { /* Sensor is optional or permissions deny reading it. */ }
    }
  } catch { /* No thermal zone inventory. */ }
  // hwmon is common on desktop hardware without usable thermal zones.
  if (!sensors.length) {
    try {
      const chips = (await readdir('/sys/class/hwmon')).filter(name => /^hwmon\d{1,3}$/.test(name)).slice(0, 12);
      for (const chip of chips) {
        for (let index = 1; index <= 4 && sensors.length < 12; index++) {
          try {
            const value = Number((await readFile('/sys/class/hwmon/' + chip + '/temp' + index + '_input', 'utf8')).trim()) / 1000;
            if (Number.isFinite(value) && value >= -40 && value <= 125)
              sensors.push({ name: 'Sensor ' + (sensors.length + 1), celsius: Number(value.toFixed(1)) });
          } catch { /* Not every chip exposes every temperature index. */ }
        }
      }
    } catch { /* No readable hwmon inventory. */ }
  }
  return sensors.slice(0, 12);
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
