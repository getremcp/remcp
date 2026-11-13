// Read-only Telegram Web post discovery. A native Telegram Desktop login is
// NOT an authenticated TDLib/API session and must never be silently reused.
// The page-side function cannot edit, save, send, navigate, or execute user code.
import { browserTabs } from './browser.mjs';
import { withTarget, callPageFunction } from './browser-session.mjs';
import { matchesWebHost,matchingWebTabs,selectedWebTarget } from './app-workflow-inspect-core.mjs';
import { resultValue } from './desktop-core.mjs';

export const PAGE_TELEGRAM_POST_READ = `function(reference) {
  if(location.protocol!=='https:' || location.hostname!=='web.telegram.org' ||
    location.username||location.password||location.port)
    throw Error('Telegram Web origin is not verified');
  if(!reference||typeof reference.url!=='string')
    throw Error('Missing registered Telegram post reference');
  const normLink = value => {
    try {
      const u=new URL(value,location.href);
      if(u.protocol!=='https:'||u.hostname!=='t.me'||u.port||u.username||u.password)
        return '';
      return u.origin+u.pathname.replace(/\\/$/,'');
    } catch{return ''}
  };
  const expected=normLink(reference.url);
  if(!expected)return {status:'blocked',reason:'invalid_telegram_post_reference'};
  const links=document.querySelectorAll('a[href]');
  if(links.length>1800)return {status:'blocked',reason:'page_link_budget_exceeded'};
  const hits=new Map();
  for(const link of links) {
    if(normLink(link.getAttribute('href'))!==expected)continue;
    const bubble=link.closest('[data-mid],[data-message-id],.bubble,.message,.Message');
    if(bubble&&bubble.isConnected)hits.set(bubble,true);
  }
  if(hits.size!==1)return {status:'unavailable',
    reason:hits.size?'ambiguous_message_reference':'post_not_visible_in_tab'};
  const bubble=[...hits.keys()][0];
  const selectors=['.text-content','.message-text','.message-content',
    '[data-message-text]','.translatable-message'];
  let node=null;
  for(const selector of selectors){
    const found=bubble.querySelectorAll(selector);
    if(found.length===1){node=found[0];break}
  }
  if(!node)return {status:'unavailable',reason:'post_text_not_readable'};
  const text=String(node.textContent||'').trim();
  if(!text||text.length>4096)return {status:'unavailable',reason:'post_text_not_bounded'};
  // Do not infer ownership from a CSS class or an Edit button. Only an
  // authenticated app API can prove who may edit this particular message.
  return {status:'located',post_url:expected,current_text:text,
    text_length:text.length,own_post_verified:false,can_edit:false,
    verification:'unique_permalink_and_message_content'};
}`;

export async function inspectTelegramWebPost(post,options={},adapters={}) {
  const enumerate=adapters.browserTabs||browserTabs;
  const select=adapters.withTarget||withTarget;
  const evaluate=adapters.callPageFunction||callPageFunction;
  let tabs;
  try{tabs=resultValue(await enumerate({}));}
  catch{return {status:'unavailable',reason:'browser_tabs_unavailable'};}
  const matching=matchingWebTabs(tabs,'web.telegram.org');
  const selected=selectedWebTarget(matching,options.target_id);
  if(!selected.target)return {status:'unavailable',reason:selected.reason,
    matching_tabs:matching.length};
  try {
    const response=await select({target_id:selected.target.target_id},
      async (session,target)=>{
        if(!matchesWebHost(target?.url,'web.telegram.org'))
          return {status:'unavailable',reason:'browser_origin_changed'};
        const scanned=await evaluate(session,PAGE_TELEGRAM_POST_READ,[post]);
        return { ...scanned,
          target_id:selected.target.target_id,provider:'telegram_web_dom',
          verified_origin:true };
      });
    return response?.status?response:{status:'unavailable',reason:'browser_inspection_failed'};
  } catch {
    return {status:'unavailable',reason:'browser_inspection_failed'};
  }
}
