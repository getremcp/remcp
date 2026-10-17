// Reassemble semantics-preserving source order for fail-closed desktop contract assertions.
import { readFile } from 'node:fs/promises';

const parts = [
  'desktop-core.mjs',
  'desktop-ui-actions.mjs',
  'desktop-vision.mjs',
  'desktop-computer-snapshot.mjs',
  'desktop-computer-actions.mjs',
];

export async function readDesktopSource() {
  return (await Promise.all(parts.map(name =>
    readFile(new URL('../../src/extended/' + name, import.meta.url), 'utf8')))).join('\n');
}
