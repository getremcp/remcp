// Recheck the same exact control after mouseMoved: hover can replace the
// element under an otherwise valid coordinate before mousePressed.
import {PAGE_TEXT_TARGET} from './browser-text-target.mjs';

export const PAGE_VERIFY_POINTER_TARGET = `function(selector, needle, x, y, origin, pointerToken) {
  // A short-lived private property preserves the exact DOM object selected
  // before hover. Delete it at verification even if the page has rerendered.
  let original=null;
  if (pointerToken) {
    const key='__remcp_pointer_'+pointerToken;
    original=document[key];
    delete document[key];
    if (!original) throw new Error('Pointer target identity unavailable after hover; click suppressed');
  }
  if (origin && location.origin !== origin)
    throw new Error('Pointer target origin changed after hover; click suppressed');
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new Error('Pointer target coordinates are invalid');
  let target;
  if (selector) {
    const matches = document.querySelectorAll(selector);
    if (matches.length !== 1)
      throw new Error('Pointer target selector changed after hover; click suppressed');
    target = matches[0];
  } else {
    target = (${PAGE_TEXT_TARGET})(needle, 'click');
  }
  if (pointerToken && target !== original)
    throw new Error('Pointer target identity changed after hover; click suppressed');
  if (!target || !target.isConnected || target.disabled ||
      target.getAttribute?.('aria-disabled') === 'true' ||
      target.closest?.('[inert],[hidden],[aria-hidden="true"]')) {
    throw new Error('Pointer target unavailable after hover; click suppressed');
  }
  const r = target.getBoundingClientRect();
  if (x < r.left || x >= r.right || y < r.top || y >= r.bottom)
    throw new Error('Pointer target moved after hover; click suppressed');
  const hit = document.elementFromPoint(x, y);
  if (!hit || (hit !== target && !target.contains(hit)))
    throw new Error('Pointer target obstructed after hover; click suppressed');
  return true;
}`;


// One short-lived identity per click. Failed CDP hover/evaluation must not
// leave a reference to the page's node in the document after an exception.
export const PAGE_DISCARD_POINTER_TARGET = `function(pointerToken) {
  if (pointerToken) delete document['__remcp_pointer_'+pointerToken];
  return true;
}`;

// A hostile site can rewrite document expandos. Query the actual DOM tree
// through Chromium's CDP DOM agent: page JavaScript cannot forge its NodeId.
// Do not substitute getNodeForLocation: it can return a covered background
// control even when elementFromPoint selects a fixed overlay.
async function readSelectorNode(session,rootNodeId,selector) {
  let result;
  try {result=await session.send('DOM.querySelector',{nodeId:rootNodeId,selector});}
  catch(cause) {throw new Error('CDP selector target unavailable; click suppressed',{cause});}
  if (!Number.isSafeInteger(result?.nodeId) || result.nodeId<=0)
    throw new Error('CDP selector target unavailable; click suppressed');
  return result.nodeId;
}

// For text-only locators Chromium resolves the actual DOM node behind the
// semantic match, independently of the page-writable pointer expando.
// Releasing each short-lived remote object avoids leaking inspector handles.
async function readTextNode(session,needle) {
  let objectId;
  try {
    const response=await session.send('Runtime.evaluate',{
      expression:'('+PAGE_TEXT_TARGET+')('+JSON.stringify(needle)+',"click")',
      returnByValue:false,awaitPromise:false,
    });
    if(response?.exceptionDetails || response?.result?.subtype!=='node' ||
       typeof response?.result?.objectId!=='string')
      throw new Error('Text locator has no unique live node');
    objectId=response.result.objectId;
    const node=await session.send('DOM.requestNode',{objectId});
    if(!Number.isSafeInteger(node?.nodeId) || node.nodeId<=0)
      throw new Error('Text locator node is not in the inspected DOM');
    return node.nodeId;
  } catch(cause) {
    throw new Error('CDP text target unavailable; click suppressed',{cause});
  } finally {
    if(objectId) {
      try {await session.send('Runtime.releaseObject',{objectId});} catch {}
    }
  }
}

export async function dispatchVerifiedClick(session, target, evaluateGuard) {
  const {selector,needle,x,y,origin,pointerToken}=target;
  try {
    let rootNodeId=null,beforeNodeId=null;
    let documentNode;
    try {documentNode=await session.send('DOM.getDocument',{depth:0});}
    catch(cause) {throw new Error('CDP document unavailable; click suppressed',{cause});}
    rootNodeId=documentNode?.root?.nodeId;
    if (!Number.isSafeInteger(rootNodeId) || rootNodeId<=0)
      throw new Error('CDP document unavailable; click suppressed');
    beforeNodeId=selector?
      await readSelectorNode(session,rootNodeId,selector):
      await readTextNode(session,needle);
    await session.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,button:'none'});
    await evaluateGuard(PAGE_VERIFY_POINTER_TARGET,
      [selector,needle,x,y,origin,pointerToken]);
    const afterNodeId=selector?
      await readSelectorNode(session,rootNodeId,selector):
      await readTextNode(session,needle);
    if (beforeNodeId!==afterNodeId)
      throw new Error('CDP '+(selector?'selector':'text')+
        ' target changed after hover; click suppressed');
    await session.send('Input.dispatchMouseEvent',
      {type:'mousePressed',x,y,button:'left',clickCount:1});
    await session.send('Input.dispatchMouseEvent',
      {type:'mouseReleased',x,y,button:'left',clickCount:1});
  } catch(error) {
    // Best-effort read-only cleanup only. Never replay a click or a press
    // after a timeout; the remote pointer mutation outcome may be unknown.
    try {await evaluateGuard(PAGE_DISCARD_POINTER_TARGET,[pointerToken]);}
    catch {}
    throw error;
  }
}
