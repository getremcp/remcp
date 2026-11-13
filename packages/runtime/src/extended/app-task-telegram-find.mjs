// Fast read-only Telegram post discovery for natural-language requests such
// as "find my post about the release". Never select or edit an ambiguous hit.
import { telegramPostReference } from './app-task-contract.mjs';
import { connectedTelegramAppProvider } from './app-task-transport.mjs';

export async function findTelegramPostTask(plan,args={},adapters={}) {
  const api=adapters.telegramApi||connectedTelegramAppProvider(adapters.connectorOptions||{});
  if(!api||typeof api.findPosts!=='function')
    return {status:'blocked',app:plan.app,intent:'find_post',
      reason:'authenticated_telegram_search_provider_not_connected',
      executed:false,verified:false,screenshot_used:false};
  let response;
  try{response=await api.findPosts(args.query.trim(),plan.channel);}
  catch{return {status:'inspection_unavailable',app:plan.app,intent:'find_post',
    reason:'telegram_post_search_failed',executed:false,verified:false,
    screenshot_used:false}};
  if(!Array.isArray(response?.results)||response.results.length>20)
    return {status:'blocked',app:plan.app,intent:'find_post',
      reason:'invalid_or_excessive_post_results',executed:false,verified:false,
      screenshot_used:false};
  const hits=[];
  for(const row of response.results){
    // The authenticated provider may return stale or unexpected content.
    // A read-only search result is only a candidate; edit_post will re-read
    // and independently verify identity, ownership, permissions and old text.
    if(row?.is_own_post!==true||typeof row.post_url!=='string')continue;
    let ref;
    try{ref=telegramPostReference(row.post_url)}catch{continue}
    if(plan.channel&&String(ref.channel||'').toLowerCase()!==plan.channel.toLowerCase())
      continue;
    if(row.message_id!=null && String(row.message_id)!==ref.message_id)continue;
    if(hits.some(hit=>hit.post_url===ref.url))continue;
    const snippet=typeof row.text_excerpt==='string'?row.text_excerpt.slice(0,500):'';
    hits.push({post_url:ref.url,message_id:ref.message_id,
      ...(snippet?{text_excerpt:snippet}:{}),
      ownership_claimed_by_provider:true,
      can_edit_hint:row.can_edit===true});
  }
  return {
    status:hits.length===1?'candidate_found':hits.length>1?'multiple_candidates':'no_matching_own_posts',
    app:plan.app,intent:'find_post',results:hits,
    match_count:hits.length,executed:false,verified:false,
    ownership_verified:false,screenshot_used:false,
    note:'Results are candidate permalinks only. For an edit, re-read the exact post with edit_post and verify account, ownership, content and permissions before changing it.',
  };
}
