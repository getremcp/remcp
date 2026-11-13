// Opt-in, read-only inspection before running an application guide.
// No keyboard input, pointer, authentication, message sending or browser navigation.
import { browserTabs, browserSnapshot } from './browser.mjs';
import { requireInteractiveGuiSession } from './app-session-guard.mjs';
import { resultValue, uiSnapshot } from './desktop-core.mjs';
import { linuxRegisteredProcessState } from './app-process-preflight.mjs';

import {matchesWebHost,matchingWebTabs,selectedWebTarget,summarizeAppWindow} from './app-workflow-inspect-core.mjs';
export {matchingWebTabs,selectedWebTarget,summarizeAppWindow} from './app-workflow-inspect-core.mjs';

export async function inspectGuidedWorkflow(plan,args={},adapters={}) {
  if(plan?.kind!=='guided')throw new Error('Inspection only supports guided workflows');
  const result={app:plan.app,destination:plan.destination,guide:plan.guide,executed:false,
    inspected:false,side_effects:false};
  if(plan.web_only){
    const tabs=adapters.browserTabs||browserTabs;
    const snapshot=adapters.browserSnapshot||browserSnapshot;
    let entries;
    try { entries=resultValue(await tabs({})); }
    catch {return {...result,status:'inspection_unavailable',reason:'browser_tabs_unavailable',host:plan.host};}
    const matches=matchingWebTabs(entries,plan.host);
    const selection=selectedWebTarget(matches,args.target_id);
    if(!selection.target)return {...result,status:'inspection_unavailable',
      reason:selection.reason,host:plan.host,matching_tabs:matches};
    try {
      const dom=resultValue(await snapshot({target_id:selection.target.target_id,max_nodes:80,
        include_screenshot:false}));
      // Domain must still agree after CDP attaches; an opened tab may navigate
      // between listing and DOM inspection.
      if(!matchesWebHost(dom?.url,plan.host))
        return {...result,status:'inspection_unavailable',reason:'tab_navigated_during_inspection',
          host:plan.host};
      // Re-enumerate the exact target after reading the DOM. Do not expose
      // accessible names when a tab navigated away in the meantime.
      const after=resultValue(await tabs({target_id:selection.target.target_id}));
      if(!matchingWebTabs(after,plan.host).some(tab=>tab.target_id===selection.target.target_id))
        return {...result,status:'inspection_unavailable',reason:'tab_changed_after_dom',
          host:plan.host};
      if(!Array.isArray(dom?.nodes)||dom.nodes.length===0)
        return {...result,status:'inspection_unavailable',reason:'browser_dom_empty',host:plan.host};
      const controls=dom.nodes.filter(n=>n.ignored!==true
        && n.name && !/password|secret|token/i.test(String(n.name)))
        .slice(0,30).map(n=>({role:String(n.role||'').slice(0,50),
          name:String(n.name).slice(0,120)}));
      return {...result,status:'inspected',inspected:true,host:plan.host,
        target_id:selection.target.target_id,tab_title:selection.target.title,
        controls,truncated:dom?.truncated===true};
    }catch {return {...result,status:'inspection_unavailable',reason:'browser_dom_unavailable',
      host:plan.host,target_id:selection.target.target_id};}
  }
  const checkSession=adapters.requireInteractiveGuiSession||requireInteractiveGuiSession;
  await checkSession();
  // Linux AT-SPI can spend 15–25s scanning a stopped app. A small, read-only
  // /proc preflight avoids that latency without claiming the app is installed.
  // Injected snapshots in unit tests deliberately bypass host-specific probes.
  if(process.platform==='linux' && !adapters.uiSnapshot) {
    const checkProcess=adapters.linuxRegisteredProcessState||linuxRegisteredProcessState;
    const presence=checkProcess(plan.windowNames);
    if(presence.state==='not_found')return {...result,status:'inspection_unavailable',
      reason:'registered_process_not_running'};
  }
  const capture=adapters.uiSnapshot||uiSnapshot;
  let captured;
  try {
    const timeout=Number(args.inspect_timeout_ms);
    const max=Number.isFinite(timeout)&&args.inspect_timeout_ms!=null
      ?Math.max(2000,Math.min(30000,Math.trunc(timeout))):20000;
    captured=resultValue(await capture({scope:'desktop',app:plan.windowNames?.[0],
      max_nodes:160,max_depth:3,semantic_tree:false,timeout_ms:max}));
  }catch {return {...result,status:'inspection_unavailable',reason:'native_accessibility_unavailable'};}
  const summary=summarizeAppWindow(captured,plan.windowNames,{
    pid:args.pid,window_id:args.window_id,
  });
  if(!summary.matched)return {...result,status:'inspection_unavailable',reason:summary.reason,
    window_count:summary.window_count||0,matching_windows:summary.matching_windows||[]};
  return {...result,status:'inspected',inspected:true,window:summary};
}