// A five-second UI cache is fast only when the captured tree covers the
// caller's requested native accessibility scope. Avoid cross-app false hits.
function scope(args = {}) {
  const pid=args.pid != null && args.pid !== '' && Number.isInteger(Number(args.pid)) ? Number(args.pid) : null;
  const app=String(args.app||'').trim().toLowerCase();
  const window=String(args.window_title||args.windowTitle||'').trim().toLowerCase();
  const explicitlyScoped=pid!==null||Boolean(app)||Boolean(window);
  const activeOnly=args.active_only == null ?
    !explicitlyScoped&&args.scope!=='desktop' : args.active_only === true;
  return {pid,app,window,activeOnly,browserDom:args.browser_dom===true};
}

function maxLimit(value,fallback,max){
  const number=Number(value);
  return value==null||!Number.isFinite(number) ? fallback
    : Math.max(1,Math.min(max,Math.trunc(number)));
}

export function uiSnapshotCacheCovers(snapshot,args={}) {
  if (!snapshot || !Array.isArray(snapshot.payload?.nodes)) return false;
  const captured=scope(snapshot.args);
  const requested=scope(args);
  if (captured.activeOnly!==requested.activeOnly ||
      captured.browserDom!==requested.browserDom ||
      captured.pid!==requested.pid ||
      captured.app!==requested.app ||
      captured.window!==requested.window) return false;
  const payload=snapshot.payload;
  const currentDepth=maxLimit(snapshot.args?.max_depth??payload.max_depth,8,32);
  const requiredDepth=maxLimit(args.max_depth,8,32);
  if (requiredDepth>currentDepth) return false;
  const currentBudget=maxLimit(snapshot.args?.max_nodes??payload.max_nodes,500,5000);
  const requiredBudget=maxLimit(args.max_nodes,500,5000);
  if (requiredBudget>currentBudget &&
      (payload.truncated===true ||
       payload.nodes.length>=currentBudget ||
       Number(payload.count)>payload.nodes.length)) return false;
  return true;
}
