// Native, read-only installation hints. Never claim absence from a missing match.
import process from 'node:process';
import { commandExists, runPowerShell } from './common.mjs';
import { createAppInventoryCache } from './app-inventory-cache.mjs';
import { matchWindowsStartApps, matchLinuxBinaries, matchMacApplications } from './app-presence-core.mjs';

const cached = createAppInventoryCache({ ttlMs:30_000 });
export async function appAvailability(platform = process.platform, { refresh = false } = {}) {
  if (!['win32','darwin','linux'].includes(platform)) throw new Error('Unsupported platform');
  if (platform === 'linux') {
    return cached(async () => ({source:'path_executables',status:matchLinuxBinaries(undefined,commandExists)}), {refresh});
  }
  if (platform === 'darwin') {
    return cached(async () => ({source:'application_bundles',status:await matchMacApplications()}), {refresh});
  }
  return cached(async () => {
    const { stdout } = await runPowerShell(
      "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress",
      {label:'read-only Start Menu inventory',timeout:15_000,maxBuffer:8*1024*1024});
    let rows;
    try { rows = JSON.parse(stdout.trim() || '[]'); }
    catch { throw new Error('Invalid Windows Start Menu inventory JSON'); }
    return {source:'start_menu',status:matchWindowsStartApps(rows)};
  }, {refresh});
}
