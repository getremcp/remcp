// Pure, dependency-free cross-platform matching of curated application profiles.
// "unconfirmed" is not proof of absence (portable, sandbox and alternate locations).
import os from 'node:os';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { APP_PROFILES } from './app-launch-registry.mjs';

const norm = value => String(value || '').trim().toLocaleLowerCase('en-US');
export function matchWindowsStartApps(rows, profiles = APP_PROFILES) {
  const names = new Set((Array.isArray(rows) ? rows : [rows]).map(row => norm(row?.Name)));
  return Object.fromEntries(profiles.filter(x => x.targets.win32).map(profile => {
    const candidates = [profile.targets.win32, ...profile.aliases].map(norm);
    return [profile.id, candidates.some(name => names.has(name)) ? 'confirmed' : 'unconfirmed'];
  }));
}
export function matchLinuxBinaries(profiles = APP_PROFILES, exists = () => false) {
  return Object.fromEntries(profiles.filter(x => x.targets.linux).map(profile => {
    const found = exists(profile.targets.linux);
    const status = found && profile.id.startsWith('libreoffice-')
      ? 'launcher_present' : found ? 'confirmed' : 'unconfirmed';
    return [profile.id,status];
  }));
}
export async function matchMacApplications(
  profiles = APP_PROFILES,
  { home = os.homedir(), exists = async file => { try { await access(file); return true; } catch { return false; } } } = {},
) {
  const roots = ['/Applications','/Applications/Utilities','/System/Applications',
    '/System/Applications/Utilities',path.join(home,'Applications')];
  const result = {};
  for (const profile of profiles.filter(x => x.targets.darwin)) {
    const appName = profile.targets.darwin;
    const candidate = appName.endsWith('.app') ? appName : appName + '.app';
    // Only trusted registry values reach native bundle paths.
    const paths = roots.map(root => path.join(root,candidate));
    const found = (await Promise.all(paths.map(exists))).some(Boolean);
    result[profile.id] = found && profile.id.startsWith('libreoffice-')
      ? 'launcher_present' : found ? 'confirmed' : 'unconfirmed';
  }
  return result;
}
