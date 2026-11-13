// Portable pure application and web DOM matching; no ReMCP runtime dependencies.
export function safeUrl(raw) {
  try {
    const parsed=new URL(raw);
    if(parsed.protocol!=='https:' || parsed.username || parsed.password || parsed.port)return null;
    return parsed;
  } catch {return null;}
}

export function matchesWebHost(rawUrl,host) {
  const parsed=safeUrl(rawUrl);
  const allowed=String(host||'').toLowerCase();
  if(!parsed||!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(allowed))return false;
  const actual=parsed.hostname.toLowerCase();
  if(actual===allowed||actual==='www.'+allowed)return true;
  // Jira/Atlassian tenant domains are provisioned below atlassian.net.
  // All other service profiles are exact-origin only.
  return allowed==='atlassian.net'&&actual.endsWith('.atlassian.net');
}

export function matchingWebTabs(tabs,host) {
  if(!Array.isArray(tabs))return [];
  return tabs.filter(tab=>matchesWebHost(tab.url,host)).map(tab=>({
    target_id:String(tab.id||'').slice(0,256),
    title:String(tab.title||'').slice(0,160),
    // Do not echo path, query, tokens or fragment to app-catalog callers.
    origin:safeUrl(tab.url)?.origin||null,
  })).filter(tab=>tab.target_id);
}

export function selectedWebTarget(matches,targetId) {
  const id=typeof targetId==='string'?targetId.trim():'';
  if(id) {
    const found=matches.filter(x=>x.target_id===id);
    return found.length===1?{target:found[0],reason:'selected'}:
      {target:null,reason:'target_id_not_found'};
  }
  if(matches.length===1)return {target:matches[0],reason:'unique'};
  return {target:null,reason:matches.length?'multiple_matching_tabs':'no_matching_tabs'};
}

export function summarizeAppWindow(snapshot,windowNames,selection={}) {
  const nodes=Array.isArray(snapshot?.nodes)?snapshot.nodes:[];
  const names=(windowNames||[]).map(x=>String(x).toLowerCase());
  if(!names.length)return {matched:false,reason:'no_verified_application_identifier'};
  const matches=nodes.filter(node=>{
    const app=String(node.app||'').toLowerCase();
    return names.some(name=>app===name||app===name+'.exe');
  });
  const windows=matches.filter(node=>{
    const role=String(node.role||'').toLowerCase();
    return ['window','frame','dialog'].includes(role)&&Number(node.width)>0&&Number(node.height)>0;
  });
  const pid=Number(selection.pid);
  let selected=selection.pid!=null
    ? (Number.isInteger(pid) && pid>0 ? windows.filter(x=>Number(x.pid)===pid) : [])
    : windows;
  if(selection.window_id)selected=selected.filter(x=>
    String(x.id||'')===String(selection.window_id)||
    String(x.window_id||'')===String(selection.window_id));
  // Prefer an actually reported active window, never merely the first one.
  const active=selected.filter(x=>x.active===true);
  const candidates=active.length===1?active:selected;
  if(candidates.length!==1)return {
    matched:false,reason:windows.length
      ? (selected.length?'ambiguous_app_windows':'requested_window_not_found')
      : 'no_matching_window',
    window_count:windows.length,
    matching_windows:windows.slice(0,12).map(x=>({
      id:String(x.id||'').slice(0,160),pid:x.pid,
      title:String(x.window||x.name||'').slice(0,120),active:x.active===true,
    })),
  };
  const window=candidates[0];
  // Several windows can belong to one PID. A PID match alone is NOT enough:
  // only return nodes whose real accessibility parent chain reaches the exact
  // selected top-level window. Never mix dialog/window contents.
  const byId=new Map(matches.filter(n=>n.id).map(n=>[String(n.id),n]));
  const belongsToWindow=node=>{
    const seen=new Set();
    let parent=String(node.parent_id||'');
    while(parent && !seen.has(parent) && seen.size<32){
      if(parent===String(window.id||''))return true;
      seen.add(parent);
      const ancestor=byId.get(parent);
      if(!ancestor || Number(ancestor.pid)!==Number(window.pid))return false;
      parent=String(ancestor.parent_id||'');
    }
    return false;
  };
  const actionable=new Set([
    'button','push button','menuitem','menu item','text field','textfield',
    'search field','searchfield','searchbox','textbox','entry','edit',
    'combobox','combo box','checkbox','check box','radio button','radiobutton',
    'switch','tab','popup button','pop up button','link','slider',
    'spinbutton','spin button','toggle button','menu button',
  ]);
  const controls=matches.filter(n=>Number(n.pid)===Number(window.pid)
    && belongsToWindow(n) && actionable.has(String(n.role||'').toLowerCase())
    && n.password!==true && n.enabled!==false && n.hidden!==true
    && !/password|secret|token|otp|recovery/i.test(String(n.name||'')))
    .slice(0,60).map(n=>({
      role:String(n.role||'').slice(0,50),
      name:String(n.name||'').slice(0,120),
      ...(n.id?{id:String(n.id).slice(0,160)}:{}),
      ...(Number.isInteger(n.label)?{label:n.label}:{}),
    }));
  return {
    matched:true,reason:'window_present',window_title:String(window.window||window.name||'').slice(0,160),
    app:String(window.app||'').slice(0,120),
    pid:window.pid,controls,truncated:snapshot?.truncated===true,
    ...(window.window_id?{window_id:String(window.window_id).slice(0,40)}:{}),
    foreground_verified:window.active===true,
  };
}
