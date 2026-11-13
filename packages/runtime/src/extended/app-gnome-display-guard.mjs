// Guard a confirmed Ubuntu/GNOME Displays-panel crash scenario without changing
// the user's closed-lid policy or installing/reconfiguring packages.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { runFile } from './common.mjs';

export function isAffectedClosedLidGnomeDisplay({
  osRelease='',packageVersion='',lidStates=[],connectors=[],
} = {}) {
  if (!/^ID="?ubuntu"?$/m.test(osRelease)) return false;
  if (!/^VERSION_ID="?26\.04(?:\.\d+)?"?$/m.test(osRelease)) return false;
  if (!/^1:50\.3-0ubuntu0\.[12](?:$|[+~-])/.test(packageVersion.trim())) return false;
  if (!lidStates.some(state => /\bclosed\b/i.test(state))) return false;
  // A sysfs eDP connector remains 'connected' even when the lid is shut.
  // Never treat it as an external monitor.
  const builtIn = connectors.some(c => /-(?:eDP|LVDS|DSI)-/i.test(c.name) && c.status === 'connected');
  if (!builtIn || !connectors.length) return false;
  return !connectors.some(c => !/-(?:eDP|LVDS|DSI)-/i.test(c.name) && c.status === 'connected');
}

async function readStatuses(directory, filename) {
  let dirs;
  try { dirs = await readdir(directory); } catch { return []; }
  return (await Promise.all(dirs.map(async name => {
    try { return {name,status:(await readFile(path.join(directory,name,filename),'utf8')).trim()}; }
    catch { return null; }
  }))).filter(Boolean);
}

export async function assertGnomeDisplaySafe(plan) {
  if (plan?.shell !== 'gnome' || plan.panel !== 'display') return;
  const osRelease = await readFile('/etc/os-release','utf8').catch(()=>'');
  if (!/^ID="?ubuntu"?$/m.test(osRelease) || !/^VERSION_ID="?26\.04(?:\.\d+)?"?$/m.test(osRelease)) return;
  const details = await runFile('dpkg-query',['-W','-f=${Version}','gnome-control-center'],
    {label:'read installed GNOME Settings version',timeout:3000,allowFailure:true}).catch(()=>null);
  if (!details || details.code !== 0) return;
  let lids = [];
  try {
    const names = await readdir('/proc/acpi/button/lid');
    lids = (await Promise.all(names.map(async name => {
      try { return await readFile(path.join('/proc/acpi/button/lid',name,'state'),'utf8'); }
      catch { return null; }
    }))).filter(Boolean);
  } catch {}
  const connectors = (await readStatuses('/sys/class/drm','status'))
    .filter(c => /^card\d+-/.test(c.name));
  if (isAffectedClosedLidGnomeDisplay({
    osRelease,packageVersion:details.stdout,lidStates:lids,connectors,
  })) {
    throw new Error('GNOME Displays panel launch refused: Ubuntu 26.04 GNOME Settings 50.3 is affected by a known closed-lid/no-external-display SIGSEGV (Ubuntu bug #2169467). No app was launched. Keep the laptop lid policy unchanged; use another settings panel or install an OS fix when available.');
  }
}
