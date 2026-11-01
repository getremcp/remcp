// NVIDIA exposes GPU die temperatures through the read-only nvidia-smi CLI
// on Linux and Windows. Do not execute a shell or user-supplied arguments.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export function parseNvidiaTemperatures(stdout) {
  return String(stdout || '').split(/\r?\n/).slice(0, 16).flatMap((line, index) => {
    const value = line.trim();
    if (!/^\d{1,3}(?:\.\d)?$/.test(value)) return [];
    const celsius = Number(value);
    return celsius >= 0 && celsius <= 125
      ? [{ name: 'NVIDIA GPU ' + index, celsius }] : [];
  });
}

export async function nvidiaTemperatureReadings({ run = exec } = {}) {
  try {
    const result = await run('nvidia-smi',
      ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 2500, maxBuffer: 4096 });
    return parseNvidiaTemperatures(result.stdout);
  } catch { return []; }
}
