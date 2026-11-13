// One allowlisted action inside an already verified web service tab.
// A page may re-render at any point: validate HTTPS origin, accessible label,
// exact role, uniqueness and form-submit safety in ONE page-side operation.
// Never accept arbitrary JavaScript, selector, text, URL or key from the caller.
import { withTarget, callPageFunction } from './browser-session.mjs';
import { matchesWebHost } from './app-workflow-inspect-core.mjs';

// Each invocation is one trusted source-owned page function. Arguments are
// serialized as JSON data by callPageFunction, not interpreted as code.
export const PAGE_GUIDED_STEP = `function(host,policy,query) {
  function verifiedHost() {
    const p=location;
    const h=String(host||'').toLowerCase();
    const actual=String(p.hostname||'').toLowerCase();
    return p.protocol==='https:' && !p.username && !p.password && !p.port &&
      (actual===h || actual==='www.'+h ||
      (h==='atlassian.net' && actual.endsWith('.atlassian.net')));
  }
  if(!verifiedHost()) throw Error('Guided step refused: web origin changed');
  if(!policy || !['focus','invoke','set_query'].includes(policy.action) ||
    !Array.isArray(policy.names) || !Array.isArray(policy.roles))
    throw Error('Invalid registered step policy');
  if(policy.action==='set_query' && (typeof query!=='string' || !query.trim() || query.length>256 || /[\\u0000-\\u001f\\u007f\\u202a-\\u202e\\u2066-\\u2069]/u.test(query)))
    throw Error('Invalid registered search query');
  const names=new Set(policy.names.map(s=>String(s).normalize('NFKC').trim().replace(/\\s+/g,' ').toLowerCase()));
  const roles=new Set(policy.roles.map(s=>String(s).toLowerCase()));
  const elements=document.querySelectorAll(
    'button,[role="button"],[role="menuitem"],input,textarea,[role="searchbox"],[role="textbox"],[contenteditable="true"]');
  if(elements.length>3000)return {dispatched:false,reason:'page_control_budget_exceeded'};
  const norm=s=>String(s||'').normalize('NFKC').trim().replace(/\\s+/g,' ').toLowerCase();
  function role(el) {
    const explicit=String(el.getAttribute('role')||'').toLowerCase();
    if(explicit)return explicit;
    const tag=el.tagName.toLowerCase();
    if(tag==='button')return 'button';
    if(tag==='textarea'||el.isContentEditable)return 'textbox';
    if(tag==='input') {
      const type=String(el.getAttribute('type')||'text').toLowerCase();
      if(type==='search')return 'searchbox';
      if(['button','submit','reset','image'].includes(type))return 'button';
      if(['text','email','url','tel'].includes(type))return 'textbox';
    }
    return '';
  }
  const matching=[];
  for(const el of elements) {
    if(el.disabled || el.getAttribute('aria-disabled')==='true' ||
      (el.tagName.toLowerCase()==='input' && ['password','hidden','file'].includes(
        String(el.getAttribute('type')||'').toLowerCase())) ||
      el.closest('[aria-hidden="true"],[inert]') ||
      !el.isConnected) continue;
    const r=role(el);
    if(!roles.has(r))continue;
    const style=getComputedStyle(el);
    const rect=el.getBoundingClientRect();
    if(style.display==='none'||style.visibility==='hidden'||rect.width<=0||rect.height<=0)continue;
    const options=[el.getAttribute('aria-label'),el.getAttribute('placeholder'),
      el.getAttribute('title'),el.getAttribute('name'),
      r==='button'||r==='menuitem' ? (el.innerText||el.textContent) : ''];
    if(!options.some(s=>names.has(norm(s))))continue;
    if(policy.action==='set_query' && (el.tagName.toLowerCase()!=='input' ||
      !['text','search'].includes(String(el.getAttribute('type')||'text').toLowerCase()) || el.readOnly))
      continue;
    if(policy.action==='invoke') {
      const tag=el.tagName.toLowerCase();
      if(tag==='a' || el.hasAttribute('formaction') ||
        el.getAttribute('type')?.toLowerCase()==='submit' ||
        (tag==='button' && el.closest('form') && !el.hasAttribute('type')))
        continue;
    }
    if(String(el.getAttribute('autocomplete')||'').match(/password|otp|one-time|token/i))continue;
    matching.push({el,role:r,name:options.find(s=>names.has(norm(s)))||''});
    if(matching.length>1)break;
  }
  if(matching.length!==1)return {dispatched:false,
    reason:matching.length?'ambiguous_controls':'control_not_found'};
  const selected=matching[0];
  if(!verifiedHost())throw Error('Guided step refused: web origin changed');
  if(policy.action==='set_query') {
    // Native property setter + input event supports controlled React/Vue
    // search fields without keyboard Enter or form submission.
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
    if(typeof setter!=='function')throw Error('Browser input setter unavailable');
    selected.el.focus({preventScroll:true});
    setter.call(selected.el,query);
    selected.el.dispatchEvent(new Event('input',{bubbles:true}));
    return {dispatched:true,action:'set_query',readback_confirmed:selected.el.value===query,
      focused:document.activeElement===selected.el,query_length:query.length};
  }
  if(policy.action==='focus') {
    selected.el.focus({preventScroll:true});
    return {dispatched:true,action:'focus',focused:document.activeElement===selected.el,
      role:selected.role,name:String(selected.name).slice(0,100)};
  }
  selected.el.click();
  return {dispatched:true,action:'invoke',verified:false,role:selected.role,
    name:String(selected.name).slice(0,100)};
}`;

export async function performGuidedBrowserStep({plan,inspection,policy,query},adapters={}) {
  if(!plan?.web_only || !inspection?.inspected || !policy)
    throw new Error('Guided browser step requires an inspected registered web service');
  if(!inspection.target_id)throw new Error('Inspected web tab has no target ID');
  const withSelectedTarget=adapters.withTarget || withTarget;
  const execute=adapters.callPageFunction || callPageFunction;
  return withSelectedTarget({target_id:inspection.target_id},async (session,target)=>{
    if(!matchesWebHost(target.url,plan.host))
      return {dispatched:false,reason:'browser_origin_changed'};
    const response=await execute(session,PAGE_GUIDED_STEP,[plan.host,policy,query]);
    return {
      ...response,target_id:inspection.target_id,
      // Page-side click may open an editor asynchronously. Never claim success
      // of the actual guide from a successful click alone.
      verified:policy.action==='focus' ? response.focused===true : false,
      ...(policy.action==='set_query'?{readback_confirmed:response?.readback_confirmed===true}:{})
    };
  });
}
