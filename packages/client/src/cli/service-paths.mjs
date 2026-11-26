// Shared service launcher/path escaping across the three supported platforms.
import fs from 'node:fs';
import path from 'node:path';
import { stableMacCliPath } from './mac-release-anchor.mjs';

export function resolvedCliScript(cliPath) {
  if (process.platform === 'darwin' || (process.env.NODE_ENV==='test' && process.env.REMCP_TEST_PLATFORM==='darwin')) return stableMacCliPath(cliPath);
  return fs.existsSync(cliPath) ? fs.realpathSync(cliPath) : path.resolve(cliPath);
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function quoteSystemd(value) {
  // The ':' prefix disables environment expansion without changing the executable path.
  const literal = String(value).includes('$') ? ':' : '';
  return literal + `"${String(value).replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
