#!/usr/bin/env node
// Public source-size ceiling: every exception must shrink until deleted.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const legacy = JSON.parse(readFileSync(path.join(root, 'scripts/source-size-legacy.json'), 'utf8'));
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'utf8'
}).split('\0').filter(Boolean);
const target = /\.(?:[cm]?js|tsx?|jsx?|py|ps1|sh|css|scss|sql)$/;
const files = tracked.filter(file => target.test(file) && !file.includes('/node_modules/'));
const violations = [];
const seen = new Set();

for (const file of files) {
  const absolute = path.join(root, file);
  if (!existsSync(absolute)) continue;
  const content = readFileSync(absolute, 'utf8');
  const count = content.split(/\r?\n/).length;
  const lines = count > 0 ? count - (content.endsWith('\n') ? 1 : 0) : 0;
  seen.add(file);
  if (lines <= 500 && Object.hasOwn(legacy, file)) {
    violations.push(file + ': ' + lines + ' lines, remove stale legacy exception');
  } else if (lines > 500) {
    const maximum = legacy[file];
    if (!Number.isInteger(maximum) || lines > maximum) {
      violations.push(file + ': ' + lines + ' lines exceeds 500' + (maximum ? ' (legacy max ' + maximum + ')' : ''));
    }
  }
}
for (const file of Object.keys(legacy)) {
  if (!seen.has(file)) violations.push(file + ': obsolete or missing legacy exception');
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Public source size OK: ' + files.length + ' code files; max 500 lines; ' + Object.keys(legacy).length + ' shrinking exceptions');
}
