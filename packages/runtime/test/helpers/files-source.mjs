// Source-code security assertions read every bounded filesystem capability module.
import { readFileSync } from 'node:fs';

const parts = [
  'files-secure-paths.mjs',
  'files-read-traversal.mjs',
  'files-write-edit.mjs',
  'files-bulk-operations.mjs',
  'files-archive-safety.mjs',
  'files-archive-actions.mjs',
  'files-screenshots.mjs',
];

export function readFilesSource() {
  return parts.map(name =>
    readFileSync(new URL('../../src/tools/' + name, import.meta.url), 'utf8')).join('\n');
}
