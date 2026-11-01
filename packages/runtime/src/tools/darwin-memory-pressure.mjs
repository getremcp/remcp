// Read-only macOS kernel telemetry. These readings are not physical RAM occupancy.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const options = { timeout: 1200, maxBuffer: 4096, windowsHide: true };
const command = (file, args) => exec(file, args, options).then(({ stdout }) => stdout).catch(() => '');

export function parseDarwinMemoryPressure(output, levelOutput) {
  const match = /^System-wide memory free percentage:\s*(\d{1,3})%\s*$/m.exec(String(output).slice(0, 4096));
  const free = match ? Number(match[1]) : NaN;
  const level = /^\s*([124])\s*$/.exec(String(levelOutput).slice(0, 32))?.[1];
  return {
    effectiveFreeRatio: Number.isInteger(free) && free >= 0 && free <= 100 ? free / 100 : null,
    effectiveFreeMethod: Number.isInteger(free) && free >= 0 && free <= 100 ? 'darwin-memory_pressure-Q' : null,
    pressureLevel: ({ '1': 'normal', '2': 'warning', '4': 'critical' })[level] ?? null,
    pressureMethod: level ? 'darwin-kernel-sysctl' : null,
  };
}

export async function readDarwinMemoryPressure(runner = command) {
  const [free, level] = await Promise.all([
    runner('/usr/bin/memory_pressure', ['-Q']),
    runner('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
  ]);
  return parseDarwinMemoryPressure(free, level);
}
