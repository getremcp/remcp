// Run the same read-only OS probes on actual Windows, macOS and Linux hardware.
// No GUI input, application launch, settings mutation, network or dependency installation.
import os from 'node:os';
import path from 'node:path';
import { existsSync, constants, accessSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { APP_PROFILES, resolveAppLaunchAlias, listAppProfiles } from '../src/extended/app-launch-registry.mjs';
import { WEB_APP_PROFILES } from '../src/extended/app-web-profiles.mjs';
import { appGuidesFor } from '../src/extended/app-guides.mjs';
import { guidedStepPolicy } from '../src/extended/app-workflow-step-policy.mjs';
import { planAppTask } from '../src/extended/app-task.mjs';
import { APP_TASK_INTENTS } from '../src/extended/app-task-contract.mjs';
import { systemRouteIds, resolveSystemRoute } from '../src/extended/app-system-routes.mjs';
import { matchWindowsStartApps, matchLinuxBinaries, matchMacApplications } from '../src/extended/app-presence-core.mjs';
import { classifyGuiSession } from '../src/extended/app-session-core.mjs';

const platform = process.platform;
if (!['win32','darwin','linux'].includes(platform)) throw new Error('Unsupported smoke platform');
const systemRoutes = systemRouteIds(platform);
const profiles = listAppProfiles(platform);
if (profiles.length < 100 || systemRoutes.length < 15 || WEB_APP_PROFILES.length < 30)
  throw new Error('App Engine catalog is unexpectedly sparse');
for (const item of profiles) {
  if (resolveAppLaunchAlias(item.id,platform)?.id !== item.id) {
    throw new Error('Unresolvable profile '+item.id);
  }
  if (!item.destinations.includes('launch')) throw new Error('Missing launch destination '+item.id);
  const entry=APP_PROFILES.find(p=>p.id===item.id);
  if (appGuidesFor(entry,platform).length === 0) throw new Error('Missing task guidance '+item.id);
  if (item.id==='libreoffice-writer' && platform==='linux' && resolveAppLaunchAlias(item.id,platform)?.args?.[0] !== '--writer') throw new Error('Writer module launch missing');
}
for (const [guide,step] of [['compose_email','open_compose'],['find_email','focus_search'],
  ['draft_chat','focus_message'],['find_email','set_search_query']]) {
  const policy=guidedStepPolicy(guide,step);
  if (!policy || !['focus','invoke','set_query'].includes(policy.action)) throw new Error('Missing safe atomic step '+guide+'/'+step);
}
if (guidedStepPolicy('compose_email','send') || guidedStepPolicy('draft_chat','send'))
  throw new Error('Unsafe send action in atomic workflow registry');
const fastTelegram=planAppTask({app:'telegram',intent:'find',query:'smoke'},{platform});
if(fastTelegram.kind!=='semantic_step'||fastTelegram.step!=='set_search_query'||fastTelegram.screenshot_required!==false)
  throw new Error('Unified Telegram intent is not routed to the safe semantic field');
if(APP_TASK_INTENTS.length!==6)throw new Error('Unified application task contract unexpectedly changed');
for (const destination of systemRoutes) {
  if (!resolveSystemRoute(destination,platform,process.env.XDG_CURRENT_DESKTOP || '')) {
    throw new Error('Broken system route '+destination);
  }
}
function run(cmd,args,timeout=15000) {
  const result=spawnSync(cmd,args,{encoding:'utf8',timeout,maxBuffer:8*1024*1024,windowsHide:true});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(cmd+' exited '+result.status+': '+String(result.stderr).slice(0,250));
  return String(result.stdout || '').trim();
}
const result={
  os:platform,
  release:os.release(),
  registered_apps:profiles.length,
  registered_web_services:WEB_APP_PROFILES.length,
  registered_system_routes:systemRoutes.length,
  total_navigation_routes:profiles.reduce((n,row)=>n+row.destinations.length,systemRoutes.length),
  installation_source:null,
  safe_atomic_steps:4,
  unified_app_task_intents:APP_TASK_INTENTS.length,
  app_api_protocol:'remcp.app.v1',
  guided_workflows_available:profiles.reduce((count,row)=>{
    const entry=APP_PROFILES.find(p=>p.id===row.id);
    return count+appGuidesFor(entry,platform).length;
  },0),
  confirmed_app_ids:[],
  launcher_only_ids:[],
  unconfirmed_count:0,
  gui_session:'unknown',
  gui_actions_allowed:false,
  native_checks:{},
};
let detected;
if (platform==='win32') {
  const ps=run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress"]);
  const rows=JSON.parse(ps || '[]');
  detected=matchWindowsStartApps(rows);
  const session=run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    '[pscustomobject]@{sessionId=[System.Diagnostics.Process]::GetCurrentProcess().SessionId;interactive=[Environment]::UserInteractive}|ConvertTo-Json -Compress']);
  const status=JSON.parse(session);
  const verdict=classifyGuiSession('win32',{sessionId:status.sessionId,userInteractive:status.interactive});
  result.gui_session=verdict.reason;
  result.gui_actions_allowed=verdict.interactive;
  for (const tool of ['control.exe','explorer.exe','Taskmgr.exe']) {
    const file=path.join(process.env.WINDIR||'C:\\Windows',...(tool === 'explorer.exe' ? [] : ['System32']),tool);
    result.native_checks[tool]=existsSync(file);
  }
  if (!result.native_checks['control.exe'] || !result.native_checks['explorer.exe'])
    throw new Error('Core Windows system tools were not found');
} else if (platform==='darwin') {
  detected=await matchMacApplications();
  const consoleUser=run('/usr/bin/stat',['-f','%Su','/dev/console']);
  const verdict=classifyGuiSession('darwin',{consoleUser,currentUser:os.userInfo().username});
  result.gui_session=verdict.reason;
  result.gui_actions_allowed=verdict.interactive;
  result.native_checks['System Settings.app']=existsSync('/System/Applications/System Settings.app');
  result.native_checks['Finder.app']=existsSync('/System/Library/CoreServices/Finder.app');
  result.native_checks['open']=existsSync('/usr/bin/open');
  if (!result.native_checks['System Settings.app'] || !result.native_checks['Finder.app'])
    throw new Error('Core macOS GUI bundles were not found');
} else {
  const executable=command => {
    for (const dir of String(process.env.PATH||'').split(path.delimiter)) {
      if (!dir) continue;
      try { accessSync(path.join(dir,command),constants.X_OK); return true; } catch {}
    }
    return false;
  };
  detected=matchLinuxBinaries(APP_PROFILES,executable);
  const desktop=String(process.env.XDG_CURRENT_DESKTOP || '');
  const verdict=classifyGuiSession('linux',{env:process.env});
  result.gui_session=verdict.reason;
  result.gui_actions_allowed=verdict.interactive;
  result.native_checks['desktop']=desktop || '(none)';
  if (executable('gnome-control-center')) {
    const raw=run('gnome-control-center',['--list'],7000);
    const panels=new Set(raw.split(/\r?\n/).map(x=>x.trim()));
    result.native_checks['gnome_display_panel']=panels.has('display');
    result.native_checks['gnome_network_panel']=panels.has('network');
  }
}
result.installation_source={win32:'start_menu',darwin:'application_bundles',linux:'path_executables'}[platform];
result.confirmed_app_ids=Object.entries(detected).filter(([,s])=>s==='confirmed').map(([id])=>id);
result.launcher_only_ids=Object.entries(detected).filter(([,s])=>s==='launcher_present').map(([id])=>id);
result.unconfirmed_count=Object.values(detected).filter(s=>s==='unconfirmed').length;
result.status='passed';
console.log(JSON.stringify(result,null,2));
