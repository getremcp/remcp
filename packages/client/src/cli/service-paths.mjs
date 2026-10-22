// Shared service launcher/path escaping across the three supported platforms.
import fs from 'node:fs';
import path from 'node:path';

export function resolvedCliScript(cliPath) {
  return fs.existsSync(cliPath) ? fs.realpathSync(cliPath) : path.resolve(cliPath);
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
