// Execute deterministic bounded UI steps on one guarded CDP target/session.
// A workflow is explicitly requested by the caller after inspecting the page.
// No arbitrary JavaScript, cross-target access, file uploads or implicit submits.
import { assertResolvedPageUrl } from './browser-endpoint.mjs';
import { callPageFunction, evaluate } from './browser-session.mjs';

const ACTIONS = new Set(['fill_form','set_value','select','focus','click','wait_for']);
const CONDITIONS = new Set(['selector','text','url_contains','load']);

export function validateBrowserWorkflow(steps, { validateFormFields }) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 12) {
    throw new Error('browser workflow requires 1 to 12 steps');
  }
  return steps.map((raw, index) => {
    const action = typeof raw?.action === 'string' ? raw.action : '';
    if (!ACTIONS.has(action)) throw new Error('Unsupported browser workflow action at step ' + (index + 1));
    if (action === 'fill_form') {
      return { action, fields:validateFormFields(raw.fields) };
    }
    if (action === 'wait_for') {
      const condition = String(raw.condition || 'selector');
      if (!CONDITIONS.has(condition)) throw new Error('Unsupported browser wait condition at step ' + (index + 1));
      const criterion = condition === 'selector' ? raw.selector : raw.text;
      if (condition !== 'load' && (typeof criterion !== 'string' || !criterion.trim() || criterion.length > 512)) {
        throw new Error('Browser workflow wait requires a bounded criterion at step ' + (index + 1));
      }
      const timeout_ms = raw.timeout_ms == null ? 1500 : Number(raw.timeout_ms);
      if (!Number.isInteger(timeout_ms) || timeout_ms < 100 || timeout_ms > 4000) {
        throw new Error('Browser workflow wait timeout must be 100-4000 ms');
      }
      return {action, condition, criterion:String(criterion || ''), timeout_ms};
    }
    if (typeof raw.selector !== 'string' || !raw.selector.trim() || raw.selector.length > 512) {
      throw new Error('Browser workflow action requires a CSS selector at step ' + (index + 1));
    }
    if (['set_value','select'].includes(action) &&
        (typeof raw.value !== 'string' && typeof raw.value !== 'number' && typeof raw.value !== 'boolean')) {
      throw new Error('Browser workflow input requires a string/number/boolean value at step ' + (index + 1));
    }
    if (['set_value','select'].includes(action) && String(raw.value).length > 16384) {
      throw new Error('Browser workflow input exceeds 16384 characters');
    }
    return {action, selector:raw.selector.trim(),
      ...(['set_value','select'].includes(action) ? {value:String(raw.value)} : {})};
  });
}

async function waitForStep(session, step, started) {
  const deadline = Math.min(started + 12000, Date.now() + step.timeout_ms);
  const expression = step.condition === 'selector' ?
    'Boolean(document.querySelector('+JSON.stringify(step.criterion)+'))'
    : step.condition === 'text' ?
      '(document.body?.innerText||"").includes('+JSON.stringify(step.criterion)+')'
      : step.condition === 'url_contains' ?
        'location.href.includes('+JSON.stringify(step.criterion)+')'
        : 'document.readyState === "complete"';
  while (Date.now() < deadline) {
    let state;
    try {
      // One CDP roundtrip validates the navigated page URL and the condition.
      state = await evaluate(session, '({url:location.href,matched:Boolean(' + expression + ')})');
    } catch (error) {
      // Clicking a link can invalidate the JS execution context briefly.
      if (!/execution context (was destroyed|not found)|cannot find context/i.test(String(error?.message || ''))) {
        throw error;
      }
      await new Promise(resolve=>setTimeout(resolve, 75));
      continue;
    }
    // Never accept a match on a private or unsafe page.
    await assertResolvedPageUrl(state?.url);
    if (state?.matched) return;
    await new Promise(resolve=>setTimeout(resolve, 75));
  }
  throw new Error('Workflow wait timed out');
}

export async function executeBrowserWorkflow(session, steps, {
  pageElementAction, pageFillForm,
}) {
  const started = Date.now();
  const completed = [];
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (Date.now() - started > 12000) throw new Error('Workflow exceeded 12 second budget after '+completed.length+' steps');
    try {
      const currentUrl = await evaluate(session, 'location.href');
      await assertResolvedPageUrl(currentUrl);
      if (step.action === 'fill_form') {
        await callPageFunction(session,pageFillForm,[step.fields]);
      } else if (step.action === 'wait_for') {
        await waitForStep(session,step,started);
      } else if (step.action === 'click') {
        const bounds=await callPageFunction(session,pageElementAction,[step.selector,null,'click','']);
        const x=Number(bounds.x)+Number(bounds.width)/2;
        const y=Number(bounds.y)+Number(bounds.height)/2;
        await session.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,button:'none'});
        await session.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
        await session.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
      } else {
        await callPageFunction(session,pageElementAction,[step.selector,null,step.action,step.value??'']);
      }
      completed.push({index:index+1,action:step.action,ok:true});
    } catch (error) {
      // Don't echo form values or page text in an error.
      throw new Error('Browser workflow stopped at step '+(index+1)+' ('+step.action+'); '+
        completed.length+' steps completed. '+(step.action==='wait_for'?'Condition not satisfied.':'Inspect the page before retrying.'));
    }
  }
  return {completed:completed.length,steps:completed,elapsed_ms:Date.now()-started};
}
