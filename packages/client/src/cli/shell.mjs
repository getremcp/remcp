// The two ways this CLI runs another program: streaming straight to the terminal, or captured for a
// value it has to read back. Sleep lives here so pairing can wait without its own timer.
import { spawnSync } from 'node:child_process';

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
  return result;
}

export function output(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
  return String(result.stdout || '').trim();
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

