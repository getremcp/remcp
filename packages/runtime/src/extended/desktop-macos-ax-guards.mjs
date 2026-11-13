// Trusted JXA source fragments used inside the macOS Accessibility adapter.
// Keep the foreground decision identical for read-only snapshots and live
// mutation. AXFocused on a window is commonly false even when AXMain is true.
export const MAC_AX_FOREGROUND_SOURCE = `
function axWindowForeground(proc,win,safeWindows){
  let frontmost=false;
  try{frontmost=proc.frontmost()===true}catch(_){}
  if(!frontmost)return false;
  try{return win.attributes.byName('AXMain').value()===true}
  catch(_){return safeWindows(proc).length===1}
}`;

// Boolean-only post-action evidence. Never echo a field value in the result.
export const MAC_AX_READBACK_SOURCE = `
function axActionReadback(proc,win,target,action,inputValue,props,scalar,safeWindows){
  const foreground_after=axWindowForeground(proc,win,safeWindows);
  let focused_after=false,value_matches_after=false;
  if(action==='focus')try{focused_after=props(target).focused===true}catch(_){}
  if(action==='set_value')try{
    value_matches_after=String(scalar(props(target).value))===inputValue;
  }catch(_){}
  return {foreground_after,
    ...(action==='focus'?{focused_after}:{}),
    ...(action==='set_value'?{value_matches_after}:{})};
}`;

// These are existing AX actions, moved out of the main file to enforce the
// project 500-line source limit. Coordinate fallback is never permitted for
// guided/strict "invoke"; it remains legacy behavior only for direct click.
export const MAC_AX_ACTION_HELPERS_SOURCE = `
function perform(e,wanted){
  let acts=[];try{acts=e.actions()}catch(_){}
  for(let i=0;i<acts.length;i++){let n='';try{n=String(acts[i].name())}catch(_){}if(n===wanted){acts[i].perform();return true}}
  return false;
}
function setAttribute(e,n,v){try{e.attributes.byName(n).value=v;return true}catch(_){return false}}
function coordinateClick(e){
  const m=meta(e);if(!(m.width>0&&m.height>0))throw new Error('UI element has no clickable bounds');
  const p=$.CGPointMake(m.x+m.width/2,m.y+m.height/2);
  function post(t){const ev=$.CGEventCreateMouseEvent(null,t,p,$.kCGMouseButtonLeft);$.CGEventPost($.kCGHIDEventTap,ev)}
  post($.kCGEventLeftMouseDown);post($.kCGEventLeftMouseUp);return 'coordinate';
}`;
