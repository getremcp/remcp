// Programmatic, OS-specific GUI navigation with an explicit allowlisted contract.
// No dynamic command-line arguments, external URLs, coordinate guesses or auth bypasses.
import process from 'node:process';
import { assertAllowedCommand } from '../policy.mjs';
import { commandExists, jsonResult, runFile, spawnDetached } from './common.mjs';
import { findAppProfile, listAppProfiles } from './app-launch-registry.mjs';
import { findWebAppProfile, listWebAppProfiles } from './app-web-profiles.mjs';
import { inspectGuidedWorkflow } from './app-workflow-inspect.mjs';
import { runGuidedStep } from './app-workflow-step.mjs';
import { guidedStepPolicy, validateGuidedQuery } from './app-workflow-step-policy.mjs';
import { appGuidesFor, findAppGuide } from './app-guides.mjs';
import { appAvailability } from './app-availability.mjs';
import { detectedApps } from './app-dynamic-discovery.mjs';
import { requireInteractiveGuiSession } from './app-session-guard.mjs';
import { assertGnomeDisplaySafe } from './app-gnome-display-guard.mjs';
import { resolveSystemRoute, systemRouteIds } from './app-system-routes.mjs';
import { keyboard, listWindows, resultValue, uiSnapshot, windowAction } from './desktop-core.mjs';
import { launchApp } from './desktop-ui-actions.mjs';

export function appCatalogPayload(args = {}) {
  const platform = args.platform || process.platform;
  const category = args.category || null;
  const query = String(args.filter || '').trim().toLowerCase();
  if (args.include_guides === true && !args.app && !args.category && !args.filter) {
    throw new Error('To include multi-step guides, first select an app, category or filter; an unfiltered app guide response would be excessive.');
  }
  const requestedApp = args.app ? String(args.app).trim() : null;
  const selectedProfile = requestedApp && requestedApp !== 'system'
    ? findAppProfile(requestedApp) || findWebAppProfile(requestedApp) : null;
  if (requestedApp && requestedApp !== 'system' && !selectedProfile) throw new Error(`Unknown registered app: ${requestedApp}`);
  if (!['win32','darwin','linux'].includes(platform)) throw new Error('Unsupported OS for GUI app catalog');
  const system = {
    id:'system', category:'system', name:platform === 'win32' ? 'Windows system' : platform === 'darwin' ? 'macOS system' : 'Linux desktop',
    destinations:systemRouteIds(platform),
  };
  const profiles = category === 'web' ? [] : listAppProfiles(platform,category === 'system' ? null : category);
  const webProfiles = !category || category === 'web' ? listWebAppProfiles() : [];
  const rows = (category === 'system' ? [system] : category ? [...profiles,...webProfiles] : [system,...profiles,...webProfiles])
    .filter(row => !selectedProfile || row.id === selectedProfile.id)
    .filter(row => !requestedApp || requestedApp !== 'system' || row.id === 'system')
    .map(row => {
      if (row.id === 'system') return row;
      const guideList = appGuidesFor(row.category === 'web' ? findWebAppProfile(row.id) : findAppProfile(row.id),platform);
      return { ...row, guide_ids:guideList.map(g=>g.id), guide_count:guideList.length,
        ...(args.include_guides === true ? {guides:guideList} : {}) };
    })
    .filter(row => !query || [row.id,row.name,row.category,row.host||'',...row.destinations,
      ...(row.guide_ids||[])].some(part => part.toLowerCase().includes(query)));
  // Prevent accidental multi-hundred-KB tool results on broad categories.
  if (args.include_guides === true && rows.length > 12) {
    throw new Error('Too many detailed application guides. Narrow to app=<id> or a more specific filter.');
  }
  return {
    platform,
    count:rows.length,
    apps:rows,
    note:'Native app entries are navigation templates, not proof of installation. Web services provide guidance only; use browser DOM with a verified origin and account. Guided tasks do not execute actions.',
  };
}
export function appCatalog(args = {}) {
  const payload = appCatalogPayload(args);
  if (args.include_detected === true) {
    if (args.app || args.include_guides) throw new Error(
      'Detected-app inventory supports filter/category only, not registered-app guides');
    if (args.platform && args.platform !== process.platform)
      throw new Error('Native discovery requires the current device platform');
    return Promise.all([
      (!args.category||args.category==='detected')
        ? detectedApps({filter:args.filter||'',limit:60,refresh:args.refresh===true})
        : {apps:[],total:0,truncated:false,inventory_truncated:false},
      args.check_installed===true
        ? appAvailability(process.platform,{refresh:args.refresh===true}) : null,
    ]).then(([detected,availability]) => jsonResult({
      ...payload,count:payload.count+detected.apps.length,
      detected_total:detected.total,detected_truncated:detected.truncated,
      detected_status:detected.inventory_status||'ok',
      inventory_truncated:detected.inventory_truncated,
      availability_source:availability?.source||detected.backend,
      apps:[
        ...payload.apps.map(item=>!availability?item:
          item.category==='system'?{...item,installation:'system'}:
          item.category==='web'?{...item,installation:'web_service'}:
          {...item,installation:availability.status[item.id]||'unconfirmed'}),
        ...detected.apps,
      ],
      note:detected.inventory_status==='unavailable'
        ? 'Detected Windows Start Menu inventory is unavailable in this session; no unverified registry fallback or GUI control was attempted.'
        : detected.backend==='xdg_desktop_entries'
        ? 'Detected Linux apps come from XDG graphical launcher entries; identical display names stay separate but cannot be acted on without unambiguous provenance. No Exec metadata authorizes actions.'
        : detected.backend==='system_profiler'
          ? 'macOS .app copies have distinct opaque IDs; the selected PID executable must match the exact bundle before GUI access.'
          : detected.backend==='windows_startmenu_shortcuts'
            ? 'Windows applications come from bounded local Start Menu .lnk files; GUI access requires interactive UIA and a match between the selected PID executable and shortcut target. Shortcuts are never executed.'
            : 'Detected inventory rows may include packages, not GUI apps. Windows registry-only records cannot authorize generic GUI access.',
    }));
  }
  if (args.check_installed !== true) return jsonResult(payload);
  if (args.platform && args.platform !== process.platform) {
    throw new Error('Native installation checks require the current device platform');
  }
  return appAvailability(process.platform,{refresh:args.refresh === true}).then(({source,status}) => jsonResult({
    ...payload, inspected_at:new Date().toISOString(), availability_source:source,
    apps:payload.apps.map(item => item.category === 'system'
      ? {...item,installation:'system'}
      : item.category === 'web' ? {...item,installation:'web_service'}
      : {...item,installation:status[item.id] || 'unconfirmed'}),
    note:'Confirmed means a native executable or app entry was discovered; launcher_present means a shared launcher exists but the individual module may be missing (e.g. LibreOffice Base). Web services are not native installations. Unconfirmed never proves absence.',
  }));
}
export function planAppNavigation(args = {}, { platform = process.platform, desktop = process.env.XDG_CURRENT_DESKTOP || '' } = {}) {
  const appId = String(args.app || 'system').trim();
  const destination = String(args.destination || '').trim().toLowerCase();
  if (!destination || !/^[a-z][a-z0-9_]*$/.test(destination)) throw new Error('Destination must be an allowlisted route name');
  if (!['win32','darwin','linux'].includes(platform)) throw new Error('Unsupported OS for GUI navigation');
  if (appId === 'system') {
    const route = resolveSystemRoute(destination,platform,desktop);
    if (!route) throw new Error(`System destination "${destination}" is not supported on ${platform}`);
    return { kind:'system',...route };
  }
  const webProfile = findWebAppProfile(appId);
  if (webProfile) {
    const guide = findAppGuide(webProfile,platform,destination);
    if (!guide) throw new Error(`Web service "${webProfile.id}" supports guides only; inspect its real browser DOM for navigation`);
    return {kind:'guided',app:webProfile.id,category:'web',destination,web_only:true,host:webProfile.host,guide};
  }
  const profile = findAppProfile(appId);
  if (!profile || !profile.targets[platform]) throw new Error(`Application "${appId}" is not supported on ${platform}`);
  if (destination === 'launch') {
    return {kind:'app_launch',app:profile.id,category:profile.category,launch:profile.targets[platform],launchArgs:profile.launchArgs[platform] || [],windowNames:profile.processes[platform] || []};
  }
  const shortcut = profile.routes[destination]?.[platform];
  if (!shortcut) {
    const guide = findAppGuide(profile,platform,destination);
    if (guide) return {kind:'guided',app:profile.id,category:profile.category,destination,
      windowNames:profile.processes[platform] || [],guide};
    throw new Error(`Application "${profile.id}" has no verified route or guide for "${destination}" on ${platform}`);
  }
  return {
    kind:'app_shortcut',app:profile.id,category:profile.category,destination,shortcut,
    windowNames:profile.processes[platform] || [], launch:profile.targets[platform],
  };
}
export function chooseAppWindow(windows,plan) {
  const names = plan.windowNames.map(name=>name.toLowerCase());
  const matching = windows.filter(row => {
    const app = String(row.app || '').toLowerCase();
    // Match a real process/app identifier, not a partial window-title guess.
    return names.some(name => app === name || app === name+'.exe');
  });
  if (matching.length === 1) return matching[0];
  const active = matching.filter(row => row.active === true);
  if (active.length === 1) return active[0];
  if (!matching.length) throw new Error(`No running "${plan.app}" window found. Launch it first; navigation never sends keys to an unknown foreground window.`);
  throw new Error(`Multiple "${plan.app}" windows found; focus the intended window first to disambiguate.`);
}
export function verifiedAppFocus(target, windows) {
  if (!target || !Array.isArray(windows)) return false;
  const active = windows.filter(row => row.active === true);
  if (active.length !== 1) return false;
  const current = active[0];
  const stableIdMatch = Boolean(target.id && current.id === target.id);
  const sameProcess = Number.isInteger(target.pid) && target.pid > 0
    && Number(current.pid) === target.pid;
  const sameApp = Boolean(target.app) && String(current.app || '').toLowerCase()
    === String(target.app).toLowerCase();
  const sameTitle = Boolean(target.title) && String(current.title || '') === String(target.title);
  return stableIdMatch || (sameProcess && sameApp && sameTitle);
}
async function launchLinuxPanel(plan) {
  await assertGnomeDisplaySafe(plan);
  const isKde = plan.shell === 'kde';
  const command = isKde ? (plan.panel ? 'kcmshell6' : 'systemsettings') : 'gnome-control-center';
  if (!commandExists(command)) throw new Error(`Desktop settings backend "${command}" is not installed`);
  if (!isKde && plan.panel) {
    const available = await runFile(command,['--list'],{label:'enumerate GNOME settings',timeout:7000,allowFailure:true});
    const panels = String(available.stdout).split(/\r?\n/).map(s=>s.trim());
    if (available.code !== 0 || !panels.includes(plan.panel)) {
      throw new Error(`GNOME settings panel "${plan.panel}" is not installed; use System Settings and Accessibility navigation.`);
    }
  }
  if (isKde && plan.panel) {
    // Refuse to dispatch a stale KDE KCM ID: Plasma modules vary by version.
    const available = await runFile('kcmshell6',['--list'],{label:'enumerate KDE settings',timeout:7000,allowFailure:true});
    if (available.code !== 0 || !String(available.stdout).split(/\r?\n/).some(line => line.trim().split(/\s+/)[0] === plan.panel)) {
      throw new Error(`KDE settings module "${plan.panel}" is not installed; open System Settings and use Accessibility navigation.`);
    }
  }
  await launchApp({app:command,args:plan.panel ? [plan.panel] : []});
  return {via:'linux_settings',backend:command,verified:false};
}
async function navigateSystem(plan) {
  if (plan.method === 'key') {
    await keyboard({shortcut:plan.value});
    return {via:'system_shortcut',verified:false};
  }
  if (plan.method === 'uri' && plan.platform === 'darwin') {
    // Static Apple System Settings URI, never derived from an untrusted prompt.
    assertAllowedCommand('/usr/bin/open '+plan.value);
    spawnDetached('/usr/bin/open',[plan.value]);
    return {via:'macos_settings_uri',verified:false,warning:'System Settings URL handling varies by macOS version; inspect the visible pane before further actions.'};
  }
  if (plan.method === 'uri' || plan.method === 'launch') {
    await launchApp({app:plan.value});
    return {via:plan.method === 'uri' ? 'windows_settings_uri' : 'native_launch',verified:false};
  }
  if (plan.method === 'chooser') {
    const target = plan.value.find(commandExists);
    if (!target) throw new Error(`No supported desktop application installed for "${plan.destination}"`);
    await launchApp({app:target});
    return {via:'native_launch',backend:target,verified:false};
  }
  if (plan.method === 'desktop_panel') return launchLinuxPanel(plan);
  throw new Error('Unknown internal system navigation method');
}
export function findLaunchUiWindow(payload,plan) {
  const names = (plan.windowNames || []).map(name => String(name).toLowerCase());
  if (!names.length) return null;
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  return nodes.find(node => {
    const app = String(node.app || '').toLowerCase();
    const role = String(node.role || '').toLowerCase();
    const title = String(node.window || node.name || '').trim();
    return names.some(name => app === name || app === name+'.exe')
      && ['frame','window','dialog'].includes(role)
      && title.length > 0 && Number(node.width) > 0 && Number(node.height) > 0;
  }) || null;
}
async function verifyAppLaunchWindow(plan,timeoutMs = 20_000) {
  if (!plan.windowNames?.length) return {verified:false,verification:'no_app_identifier'};
  // One scoped AT-SPI/UIA/AX capture. Repeated short captures cause
  // artificial timeouts on busy GNOME sessions; keep this opt-in.
  let snapshot;
  try {
    snapshot = resultValue(await uiSnapshot({
      scope:'desktop',app:plan.windowNames[0],
      semantic_tree:false,max_nodes:100,max_depth:2,timeout_ms:timeoutMs,
    }));
  } catch {
    return {verified:false,verification:'accessibility_unavailable'};
  }
  const window = findLaunchUiWindow(snapshot,plan);
  if (!window) return {verified:false,verification:'window_not_found'};
  return {
    verified:true,verification:'window_present',window_title:window.window || window.name,
    // Window presence says nothing about whether the OS granted foreground focus.
    foreground_verified:false,
  };
}

export async function appNavigate(args = {}) {
  const plan = planAppNavigation(args);
  if (args.dry_run === true) {
    if (args.step != null) {
      const policy=guidedStepPolicy(plan.destination,args.step);
      if (plan.kind !== 'guided' || !policy) throw new Error('Unknown or unsafe guided atomic step');
      const query=validateGuidedQuery(args,policy);
      return jsonResult({status:'planned',plan,step:policy,
        ...(query!=null?{query_length:query.length}:{})});
    }
    return jsonResult({status:'planned',plan});
  }
  if (plan.kind === 'guided') {
    if (args.step != null) return jsonResult(await runGuidedStep(plan,args));
    if (args.verify === true) throw new Error('verify=true is for application launch; use inspect=true for read-only guided UI inspection');
    if (args.inspect === true) return jsonResult(await inspectGuidedWorkflow(plan,args));
    return jsonResult({status:'guidance_only',app:plan.app,destination:plan.destination,
      executed:false,...(plan.web_only ? {web_only:true,host:plan.host} : {}),guide:plan.guide});
  }
  if (args.inspect === true) throw new Error('inspect=true supports guided destinations only');
  if (args.step != null) throw new Error('step supports guided destinations only');
  if (args.verify === true && plan.kind !== 'app_launch') throw new Error('verify=true currently supports application launch only; use ui_snapshot to confirm system panes or shortcut results');
  await requireInteractiveGuiSession();
  if (plan.kind === 'system') {
    const result = await navigateSystem(plan);
    return jsonResult({status:'dispatched',app:'system',destination:plan.destination,...result});
  }
  if (plan.kind === 'app_launch') {
    await launchApp({app:plan.launch,args:plan.launchArgs});
    const requestedTimeout = Number(args.verify_timeout_ms);
    const timeoutMs = Number.isFinite(requestedTimeout) && args.verify_timeout_ms != null
      ? Math.max(2_000,Math.min(30_000,Math.trunc(requestedTimeout))) : 20_000;
    const verification = args.verify === true ? await verifyAppLaunchWindow(plan,timeoutMs) : {verified:false};
    return jsonResult({status:'dispatched',app:plan.app,destination:'launch',via:'native_launch',...verification});
  }
  const windows = resultValue(await listWindows({include_monitor:false}));
  if (!Array.isArray(windows)) throw new Error('OS window inventory is not available');
  const target = chooseAppWindow(windows,plan);
  if (!target.id) throw new Error('Selected window has no stable identifier');
  await windowAction({action:'focus',id:target.id});
  // A successful focus request is not proof of a foreground window. Windows
  // SendKeys and macOS System Events target the active application, so fail
  // closed when another process retained focus.
  const afterFocus = resultValue(await listWindows({include_monitor:false}));
  if (!Array.isArray(afterFocus)) throw new Error('Cannot verify active window after focus');
  const active = afterFocus.filter(row => row.active === true);
  if (!verifiedAppFocus(target,active)) {
    throw new Error(`Application focus could not be verified for "${plan.app}"; navigation shortcut was not sent`);
  }
  // The explicit window id/PID is preserved, particularly for Wayland targeting.
  await keyboard({shortcut:plan.shortcut,window_id:target.id,pid:target.pid});
  return jsonResult({
    status:'dispatched',app:plan.app,destination:plan.destination,
    via:'focused_window_shortcut',window_id:target.id,verified:false,
    note:'Shortcut was sent after window focus. Check the resulting UI state with ui_snapshot before more actions.',
  });
}
