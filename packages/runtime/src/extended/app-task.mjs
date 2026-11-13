// One-call, screenshot-free application intent routing. The intent is typed,
// but targets must still be grounded in the CURRENT native AX/UIA/AT-SPI tree
// or a current trusted CDP page. No raw selectors, shortcuts, scripts or URLs.
import process from 'node:process';
import {jsonResult} from './common.mjs';
import {appNavigate,planAppNavigation} from './app-navigation.mjs';
import {inspectGuidedWorkflow} from './app-workflow-inspect.mjs';
import {runGuidedStep} from './app-workflow-step.mjs';
import {guidedStepPolicy,validateGuidedQuery} from './app-workflow-step-policy.mjs';
import {validateAppTask} from './app-task-contract.mjs';
import {inspectTelegramWebPost} from './app-task-telegram.mjs';
import {findTelegramPostTask} from './app-task-telegram-find.mjs';
import {findWebAppProfile} from './app-web-profiles.mjs';
import {assertWindowsInteractiveDesktop} from './desktop-windows-session.mjs';
import {connectedTelegramAppProvider,connectedApplicationProvider} from './app-task-transport.mjs';
import {findAppProfile} from './app-launch-registry.mjs';
import {inspectDetectedApp} from './app-dynamic-discovery.mjs';

const searchDestinations=['find_conversation','find_email','find_note'];
function guidedPlan(app,candidates,planFn,platform){
  for(const destination of candidates){
    try {
      const plan=planFn({app,destination},{platform});
      if(plan.kind==='guided')return plan;
    }catch{}
  }
  throw new Error('Registered app has no verified workflow for this intent');
}

export function planAppTask(args={},options={}) {
  const validated=validateAppTask(args);
  const platform=options.platform||process.platform;
  const planFn=options.planAppNavigation||planAppNavigation;
  if(['inspect','find','focus_control','set_control_text'].includes(validated.intent) &&
    /^local-[a-f0-9]{20}$/.test(validated.app))
    return {app:validated.app,intent:validated.intent,kind:'detected_inspect',
      screenshot_required:false};
  if(validated.intent==='find_post')return {
    app:validated.app,intent:'find_post',kind:'telegram_post_lookup',
    channel:validated.channel,query_length:validated.query_length,
    screenshot_required:false,
  };
  if(validated.intent==='edit_post')return {
    app:validated.app,intent:'edit_post',kind:'transaction',
    post:validated.post,replacement_length:validated.replacement_length,
    transport:'verified_telegram_user_api_then_read_only_web_dom',
    stages:['resolve_exact_post','verify_owned_and_editable',
      'compare_original','prepare_edit','apply_if_explicit','read_back'],
    screenshot_required:false,commit:validated.commit,
  };
  if(validated.intent==='open'){
    if(findWebAppProfile(validated.app))throw new Error('Web applications require an already authorized tab; use inspect or find');
    const route=planFn({app:validated.app,destination:'launch'},{platform});
    if(route.kind!=='app_launch')throw new Error('Web applications require an already authorized tab; open is native-app only');
    return {app:validated.app,intent:'open',kind:'launch',route,
      screenshot_required:false};
  }
  if(validated.intent==='inspect'){
    let route;
    try{route=guidedPlan(validated.app,['inspect_app','inspect_web'],planFn,platform);}
    catch(error){
      // A registered app may expose an authenticated local connector even
      // when it has no generic AX or web inspection workflow. Do not invent
      // an unverified UI route or try to launch a different app.
      if(!findAppProfile(validated.app)&&!findWebAppProfile(validated.app))throw error;
      route=null;
    }
    return {app:validated.app,intent:'inspect',kind:route?'inspection':'api_only',route,
      screenshot_required:false};
  }
  const destinations=validated.intent==='find'?searchDestinations:['draft_chat'];
  let route;
  try{route=guidedPlan(validated.app,destinations,planFn,platform);}
  catch(error) {
    // A locally authorized app adapter may expose find even without a
    // corresponding native accessibility field. Still require registry entry.
    if(validated.intent!=='find'||
      (!findAppProfile(validated.app)&&!findWebAppProfile(validated.app)))throw error;
    route=null;
  }
  const step=validated.intent==='find'?'set_search_query':'focus_message';
  const policy=route?guidedStepPolicy(route.destination,step):null;
  if(route&&!policy)throw new Error('Requested application has no supported semantic field step');
  const query=validated.intent==='find'
    ? validateGuidedQuery(args,policy||{action:'set_query'})
    : validateGuidedQuery(args,policy);
  return {app:validated.app,intent:validated.intent,
    kind:route?'semantic_step':'api_only',route,step,
    screenshot_required:false,
    ...(query!=null?{query_length:query.length}:{})};
}
const resultWithoutContent=(plan,extra={})=>({
  app:plan.app,intent:plan.intent,...extra,
});

export async function editTelegramPostTask(plan,args,adapters={}) {
  if(!plan.post)return resultWithoutContent(plan,{status:'needs_exact_post_url',
    executed:false,verified:false,
    note:'Provide a specific t.me post permalink. A chat title alone cannot identify one existing post.'});
  const api=adapters.telegramApi||connectedTelegramAppProvider(adapters.connectorOptions||{});
  if(!api||typeof api.getPost!=='function'||typeof api.editPost!=='function'){
    if(plan.commit)return resultWithoutContent(plan,{status:'blocked',
      reason:'authenticated_telegram_edit_provider_not_connected',
      executed:false,verified:false});
    const inspect=adapters.inspectTelegramWebPost||inspectTelegramWebPost;
    const inspected=await inspect(plan.post,{target_id:args.target_id},adapters);
    return resultWithoutContent(plan,{
      status:inspected?.status==='located'?'preview_only':'inspection_unavailable',
      reason:'authenticated_telegram_edit_provider_not_connected',
      post_url:plan.post.url,executed:false,verified:false,
      ...(inspected?.status==='located'?{
        current_text:inspected.current_text,source:'telegram_web_dom',
        own_post_verified:false,can_edit:false,
      }:{inspection_reason:inspected?.reason||'not_available'}),
      note:'Telegram Desktop login is not an authorized TDLib session. Browser DOM can preview a uniquely linked post but cannot prove edit permission. No edit was dispatched.',
    });
  }
  let before;
  try{before=await api.getPost(plan.post);}
  catch{return resultWithoutContent(plan,{status:'inspection_unavailable',reason:'telegram_api_read_failed',
    executed:false,verified:false});}
  const sameTarget=before?.post_url===plan.post.url &&
    String(before.message_id)===plan.post.message_id &&
    typeof before.chat_id==='string' && before.chat_id.length>0 &&
    typeof before.account_id==='string' && before.account_id.length>0;
  if(!sameTarget||typeof before.text!=='string'||before.text.length>4096)
    return resultWithoutContent(plan,{status:'blocked',reason:'telegram_post_identity_unverified',
      executed:false,verified:false});
  if(before.is_own_post!==true||before.can_edit!==true)return resultWithoutContent(plan,{
    status:'blocked',reason:'telegram_post_ownership_or_edit_rights_unverified',
    post_url:plan.post.url,executed:false,verified:false,
  });
  // TDLib uses distinct text and caption editors. Do not strip formatting,
  // media or link previews by treating every message as plain text.
  const plainText=before.content_kind==='text' &&
    before.has_text_entities===false && before.has_media===false &&
    before.has_link_preview===false;
  if(!plainText)return resultWithoutContent(plan,{
    status:'blocked',reason:'telegram_post_format_or_media_not_supported',
    post_url:plan.post.url,executed:false,verified:false,
    note:'This editor only supports verified plain-text posts without formatting, media or link previews.',
  });
  if(args.replacement_text==null||args.expected_text==null)
    return resultWithoutContent(plan,{status:'ready_for_review',
      post_url:plan.post.url,current_text:before.text,editable:true,
      executed:false,verified:false,
      note:'Use this exact inspected post text as expected_text, propose replacement_text, then explicitly commit the edit.'});
  if(before.text===args.replacement_text)return resultWithoutContent(plan,{
    status:'already_applied',post_url:plan.post.url,executed:false,verified:true,
  });
  if(before.text!==args.expected_text)return resultWithoutContent(plan,{
    status:'blocked',reason:'original_post_text_changed',
    post_url:plan.post.url,executed:false,verified:false,
  });
  if(!plan.commit)return resultWithoutContent(plan,{
    status:'ready_for_review',post_url:plan.post.url,
    current_text:before.text,replacement_length:plan.replacement_length,
    executed:false,verified:false,
  });
  const identity={
    post_url:plan.post.url,message_id:before.message_id,
    chat_id:before.chat_id,account_id:before.account_id,
    expected_text:before.text,expected_content_kind:'text',
    expected_has_text_entities:false,expected_has_media:false,
    expected_has_link_preview:false,
    ...(before.revision!=null?{expected_revision:before.revision}:{}),
  };
  try{
    const changed=await api.editPost({...identity,new_text:args.replacement_text});
    if(changed?.ok!==true)throw Error('post edit not acknowledged');
    const after=await api.getPost(plan.post);
    if(after?.text===args.replacement_text &&
      after?.content_kind==='text' && after?.has_text_entities===false &&
      after?.has_media===false && after?.has_link_preview===false &&
      after?.post_url===before.post_url &&
      after?.account_id===before.account_id &&
      after?.chat_id===before.chat_id &&
      String(after?.message_id)===String(before.message_id))
      return resultWithoutContent(plan,{status:'completed',
        post_url:plan.post.url,executed:true,verified:true,
        verification:'same_authenticated_post_read_back'});
  }catch{}
  return resultWithoutContent(plan,{status:'outcome_unknown',
    post_url:plan.post.url,executed:null,verified:false,
    reason:'post_edit_or_readback_not_confirmed',
    note:'A server-side edit may have occurred. Re-read this exact post before retrying; never blindly duplicate the mutation.'});
}

export async function appTask(args={},adapters={}) {
  const plan=planAppTask(args,{...adapters,platform:adapters.platform||process.platform});
  if(args.dry_run===true)return jsonResult({status:'planned',executed:false,plan});
  if(plan.intent==='find_post')
    return jsonResult(await findTelegramPostTask(plan,args,adapters));
  if(plan.kind==='detected_inspect')
    return jsonResult(await inspectDetectedApp(args,adapters));
  if(plan.intent==='edit_post')
    return jsonResult(await editTelegramPostTask(plan,args,adapters));
  // Prefer an authenticated local app API. One structured request can search
  // a warmed application cache in milliseconds, with no screenshots or
  // window focus. Failure falls back to the same verified GUI policy.
  if(['find','inspect'].includes(plan.intent)) {
    const provider=adapters.appApi||connectedApplicationProvider(plan.app,adapters.connectorOptions||{});
    if(provider){
      try{
        const raw=plan.intent==='find'?await provider.find(args.query):await provider.inspect();
        if(raw && raw.ok===true) {
          if(plan.intent==='find'){
            if(!Array.isArray(raw.results)||raw.results.length>50)throw Error('Invalid app API results');
            const results=raw.results.slice(0,20).filter(x=>x&&typeof x.id==='string'&&typeof x.label==='string')
              .map(x=>({id:x.id.slice(0,160),label:x.label.slice(0,300),
                ...(typeof x.preview==='string'?{preview:x.preview.slice(0,500)}:{})}));
            return jsonResult({status:'completed',app:plan.app,intent:plan.intent,
              via:'user_local_app_connector',executed:false,verified:true,
              results,search_results_verified:true,screenshot_used:false});
          }
          return jsonResult({status:'inspected',app:plan.app,intent:plan.intent,
            via:'user_local_app_connector',executed:false,verified:true,
            available:raw.available===true,
            capabilities:Array.isArray(raw.capabilities)
              ?raw.capabilities.filter(x=>typeof x==='string').slice(0,20).map(x=>x.slice(0,70)):[],
            screenshot_used:false});
        }
      }catch{/* A read-only local API failure may fall back to UI. */}
    }
  }
  if(!plan.route)return jsonResult({
    status:'blocked',app:plan.app,intent:plan.intent,
    reason:'no_verified_app_connector_or_semantic_field',
    executed:false,verified:false,screenshot_used:false,
  });
  if((adapters.platform||process.platform)==='win32' && plan.route?.web_only!==true){
    const guard=adapters.assertWindowsInteractiveDesktop||assertWindowsInteractiveDesktop;
    await guard();
  }
  if(plan.kind==='launch'){
    const nav=adapters.appNavigate||appNavigate;
    return nav({app:plan.app,destination:'launch',verify:args.verify===true});
  }
  if(plan.kind==='inspection'){
    const inspect=adapters.inspectGuidedWorkflow||inspectGuidedWorkflow;
    return jsonResult(await inspect(plan.route,args,adapters));
  }
  const run=adapters.runGuidedStep||runGuidedStep;
  const output=await run(plan.route,{
    step:plan.step,...(plan.intent==='find'?{query:args.query}:{}),
    ...(args.target_id?{target_id:args.target_id}:{}),
    ...(args.window_id?{window_id:args.window_id}:{}),
    ...(args.pid?{pid:args.pid}:{}),
  },adapters);
  return jsonResult({...output,intent:plan.intent,screenshot_used:false,
    ...(plan.intent==='find'?{search_results_verified:false}:{})});
}
