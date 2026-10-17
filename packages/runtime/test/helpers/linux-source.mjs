// Read the split Linux adapter in semantic source order for fail-closed regression assertions.
import { readFile } from 'node:fs/promises';

const parts = [
  'desktop-linux-windows.mjs',
  'desktop-linux-window-actions.mjs',
  'desktop-linux-ui.mjs',
  'desktop-linux-input.mjs',
  'desktop-linux-displays.mjs',
  'desktop-linux-screen.mjs',
];

export async function readLinuxSource() {
  return (await Promise.all(parts.map(name =>
    readFile(new URL('../../src/extended/' + name, import.meta.url), 'utf8')))).join('\n');
}
