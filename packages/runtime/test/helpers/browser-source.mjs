// Preserve security-contract assertions across refactored browser modules.
import { readFile } from 'node:fs/promises';

const parts = [
  'browser-endpoint.mjs',
  'browser-policy.mjs',
  'browser-session.mjs',
  'browser-read.mjs',
  'browser-actions.mjs',
];

export async function readBrowserSource() {
  return (await Promise.all(parts.map(name =>
    readFile(new URL('../../src/extended/' + name, import.meta.url), 'utf8')))).join('\n');
}
