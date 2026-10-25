// Native CDP event-listener audit for one explicitly selected DOM element.
// CDP returns handler references, source positions and custom listener names:
// NONE of that may leave the paired device. Never evaluate page JavaScript.
const TYPES = new Set([
  'click','dblclick','auxclick','contextmenu','input','change','beforeinput',
  'submit','reset','keydown','keyup','keypress','focus','blur','focusin','focusout',
  'mousedown','mouseup','mousemove','mouseenter','mouseleave',
  'pointerdown','pointerup','pointermove','pointerenter','pointerleave',
  'touchstart','touchend','touchmove','wheel','scroll','resize','load','error',
  'drag','dragstart','dragend','dragover','drop','animationend','transitionend',
]);
const MAX_LISTENERS = 200;
const MAX_TYPES = 24;
export function validSelector(value,maxLength=120,allowChildCombinator=false) {
  if (typeof value !== 'string') throw new TypeError('A CSS selector is required for the event listener audit');
  const selector = value.trim();
  if (!selector || selector.length > maxLength || /[\u0000-\u001f\u007f<]/.test(selector) || (!allowChildCombinator && selector.includes('>'))) {
    throw new TypeError('A CSS selector between 1 and '+maxLength+' safe characters is required');
  }
  return selector;
}
export function summarizeElementListeners(raw) {
  const listeners = Array.isArray(raw) ? raw : [];
  const sample = listeners.slice(0,MAX_LISTENERS);
  const types = Object.create(null);
  let passive = 0, once = 0, capturing = 0;
  for (const listener of sample) {
    if (!listener || typeof listener !== 'object') continue;
    const eventType = TYPES.has(listener.type) ? listener.type : 'other';
    types[eventType] = (types[eventType] || 0) + 1;
    if (listener.passive === true) passive++;
    if (listener.once === true) once++;
    if (listener.useCapture === true) capturing++;
  }
  const byType = Object.entries(types).sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,MAX_TYPES);
  return {
    sampled_listeners:sample.length,
    listener_count:Math.min(listeners.length,100000),
    truncated:listeners.length>MAX_LISTENERS,
    by_type:Object.fromEntries(byType),
    passive_count:passive, once_count:once, capture_count:capturing,
    repeated_event_types:byType.filter(([,count])=>count>1).length,
    note:'Native CDP listener counts on the single selected node. Repeated event types are not proof of duplicate handlers. Delegated ancestor listeners are not included; handler code, locations, custom event names and page contents are never returned.',
  };
}
export async function inspectElementListeners(session,selectorValue) {
  const selector=validSelector(selectorValue);
  // getDocument(depth:0) is enough to get the root without enumerating contents.
  const {root} = await session.send('DOM.getDocument',{depth:0,pierce:false});
  if (!Number.isSafeInteger(root?.nodeId) || root.nodeId<=0) throw new Error('CDP document root unavailable');
  let objectId;
  try {
    const selected = await session.send('DOM.querySelector',{nodeId:root.nodeId,selector});
    if (!Number.isSafeInteger(selected?.nodeId) || selected.nodeId<=0)
      return {action:'listeners',found:false,listeners:summarizeElementListeners([])};
    const resolved=await session.send('DOM.resolveNode',{nodeId:selected.nodeId});
    objectId=resolved?.object?.objectId;
    if (typeof objectId!=='string' || !objectId || objectId.length>512) throw new Error('Selected DOM node cannot be resolved');
    const result=await session.send('DOMDebugger.getEventListeners',{objectId,depth:0,pierce:false});
    return {action:'listeners',found:true,listeners:summarizeElementListeners(result.listeners)};
  } finally {
    if (objectId) await session.send('Runtime.releaseObject',{objectId}).catch(()=>{});
    await session.send('DOM.disable').catch(()=>{});
  }
}
