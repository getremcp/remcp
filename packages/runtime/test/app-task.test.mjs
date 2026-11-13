import test from 'node:test';
import assert from 'node:assert/strict';
import {appTask,planAppTask,editTelegramPostTask} from '../src/extended/app-task.mjs';
import {telegramPostReference,validateAppTask} from '../src/extended/app-task-contract.mjs';
import {inspectTelegramWebPost,PAGE_TELEGRAM_POST_READ} from '../src/extended/app-task-telegram.mjs';
import {extendedToolDefinitions} from '../src/extended/catalog.mjs';

const ref='https://t.me/examplechannel/123';
const args={app:'telegram',intent:'edit_post',post_url:ref};
const post={
  post_url:ref,chat_id:'-100987654321',message_id:'123',
  account_id:'owner-42',is_own_post:true,can_edit:true,
  text:'Original post',revision:'v9',content_kind:'text',
  has_text_entities:false,has_media:false,has_link_preview:false,
};
const wrapped=async (args,adapters={})=>(await appTask(args,adapters)).structuredContent;

test('app_task schema is bounded, typed and an explicit mutating tool',()=>{
  const tool=extendedToolDefinitions.find(x=>x.name==='app_task');
  assert.ok(tool);
  assert.equal(tool.inputSchema.properties.intent.enum.includes('edit_post'),true);
  assert.equal(tool.inputSchema.additionalProperties,false);
  assert.equal(tool.annotations.readOnlyHint,false);
  assert.equal(tool.annotations.destructiveHint,true);
});

test('one-call Telegram search is a scoped semantic step, not screenshot navigation',async()=>{
  const result=await wrapped({app:'telegram',intent:'find',query:'new travel post'},{
    platform:'linux',
    runGuidedStep:async (route,params)=>{
      assert.equal(route.destination,'find_conversation');
      assert.deepEqual(route.windowNames,['telegram-desktop']);
      assert.equal(params.step,'set_search_query');
      assert.equal(params.query,'new travel post');
      return {status:'dispatched',verified:true,executed:true,via:'scoped_native_accessibility'};
    },
  });
  assert.equal(result.status,'dispatched');
  assert.equal(result.search_results_verified,false);
  assert.equal(result.screenshot_used,false);
  assert.ok(!JSON.stringify(result).includes('new travel post'));
});

test('one-call web search uses the registered HTTPS app profile',async()=>{
  const out=await wrapped({app:'telegram-web',intent:'find',query:'announcement',target_id:'tab123'},{
    platform:'linux',
    runGuidedStep:async (plan,args)=>{
      assert.equal(plan.web_only,true);
      assert.equal(plan.host,'web.telegram.org');
      assert.equal(args.target_id,'tab123');
      return {status:'blocked',reason:'browser_origin_changed',executed:false,verified:false};
    },
  });
  assert.equal(out.status,'blocked');
  assert.equal(out.reason,'browser_origin_changed');
});

test('dry run is fast and never touches a running app or provider',async()=>{
  const p=await wrapped({app:'telegram',intent:'find',query:'secret',dry_run:true},{
    platform:'linux',
    runGuidedStep:()=>assert.fail('no GUI action in dry-run'),
  });
  assert.equal(p.status,'planned');
  assert.equal(p.plan.query_length,6);
  assert.ok(!JSON.stringify(p).includes('secret'));
  const edit=await wrapped({...args,replacement_text:'Private revision',dry_run:true},{
    telegramApi:{getPost:()=>assert.fail('no Telegram API call in dry-run')},
  });
  assert.equal(edit.plan.screenshot_required,false);
  assert.ok(!JSON.stringify(edit).includes('Private revision'));
});

test('native open/inspect and focus_draft routes are accessible via one task interface',async()=>{
  const p=planAppTask({app:'telegram',intent:'open'},{platform:'linux'});
  assert.equal(p.kind,'launch');
  assert.equal(p.route.kind,'app_launch');
  const q=planAppTask({app:'telegram',intent:'inspect'},{platform:'linux'});
  assert.equal(q.kind,'inspection');
  assert.equal(q.route.destination,'inspect_app');
  const f=planAppTask({app:'telegram',intent:'focus_draft'},{platform:'linux'});
  assert.equal(f.kind,'semantic_step');
  assert.equal(f.step,'focus_message');
  await assert.rejects(()=>appTask({app:'telegram-web',intent:'open',dry_run:true}),/authorized tab/);
  assert.throws(()=>planAppTask({app:'blender',intent:'focus_draft'},{platform:'linux'}),/no verified workflow|no supported semantic/);
});

test('API-first inspection works for registered applications without an AX guide and stays fail-closed',async()=>{
  const noGuide=()=>{throw Error('No verified native guide')};
  const plan=planAppTask({app:'blender',intent:'inspect'},{
    platform:'linux',planAppNavigation:noGuide,
  });
  assert.equal(plan.kind,'api_only');
  assert.equal(plan.route,null);
  let calls=0;
  const result=await wrapped({app:'blender',intent:'inspect'},{
    platform:'linux',planAppNavigation:noGuide,
    appApi:{inspect:async()=>{calls++;return {ok:true,available:true,capabilities:['scene_search']};}},
    inspectGuidedWorkflow:()=>assert.fail('Unverified GUI inspection must not run'),
  });
  assert.equal(result.status,'inspected');
  assert.equal(result.via,'user_local_app_connector');
  assert.equal(result.verified,true);
  assert.equal(result.screenshot_used,false);
  assert.equal(calls,1);
  const withoutConnector=await wrapped({app:'blender',intent:'inspect'},{
    platform:'linux',planAppNavigation:noGuide,
    connectorOptions:{home:'/nonexistent-dev-app-engine-qa'},
    inspectGuidedWorkflow:()=>assert.fail('No connector: never attempt unauthorized UI'),
  });
  assert.equal(withoutConnector.status,'blocked');
  assert.equal(withoutConnector.reason,'no_verified_app_connector_or_semantic_field');
  await assert.rejects(()=>wrapped({app:'unlisted_qa',intent:'inspect'}),/registered application|Unknown|no verified workflow/);
});

test('API-first search finds content even without a native guide and skips any UI probe',async()=>{
  let calls=0;
  const result=await wrapped({app:'blender',intent:'find',query:'Cylinder'},{
    platform:'linux',
    appApi:{find:async q=>{calls++;assert.equal(q,'Cylinder');return {
      ok:true,results:[{id:'mesh:42',label:'Cylinder',preview:'Object in Scene'}]}},
      inspect:()=>assert.fail('search does not inspect'),
    },
    runGuidedStep:()=>assert.fail('API search needs no screenshot or GUI'),
  });
  assert.equal(calls,1);
  assert.equal(result.status,'completed');
  assert.equal(result.via,'user_local_app_connector');
  assert.equal(result.search_results_verified,true);
  assert.equal(result.screenshot_used,false);
  assert.deepEqual(result.results,[{id:'mesh:42',label:'Cylinder',preview:'Object in Scene'}]);
});

test('a nonregistered or unsigned app cannot inject a new connector route',async()=>{
  await assert.rejects(()=>appTask({app:'unknown-evil-app',intent:'find',query:'test'},{
    platform:'linux',appApi:{find:async()=>({ok:true,results:[]})}
  }),/no verified workflow|Unknown registered|not supported/);
  const missing=await wrapped({app:'blender',intent:'find',query:'Cylinder'},{platform:'linux'});
  assert.equal(missing.status,'blocked');
  assert.equal(missing.reason,'no_verified_app_connector_or_semantic_field');
});

test('read-only API inspection returns only bounded capability metadata',async()=>{
  const response=await wrapped({app:'telegram',intent:'inspect'},{
    platform:'win32',
    appApi:{inspect:async()=>({ok:true,available:true,
      capabilities:['search','open_post','edit_post'],secret:'must not echo'})},
    assertWindowsInteractiveDesktop:()=>assert.fail('API reads allowed in Windows Session 0'),
    inspectGuidedWorkflow:()=>assert.fail('no GUI required for API inspection'),
  });
  assert.equal(response.status,'inspected');
  assert.deepEqual(response.capabilities,['search','open_post','edit_post']);
  assert.ok(!JSON.stringify(response).includes('must not echo'));
  assert.equal(response.screenshot_used,false);
});

test('native app task on Windows checks interactive desktop before any GUI step',async()=>{
  await assert.rejects(()=>appTask({app:'telegram',intent:'find',query:'hello'},{
    platform:'win32',
    assertWindowsInteractiveDesktop:async()=>{throw Error('Windows desktop unavailable (windows_session_0)')},
    runGuidedStep:()=>assert.fail('must not run UI step from Session 0'),
  }),/windows_session_0/);
});

test('find_post resolves exact candidate links from authorized Telegram API without a screenshot',async()=>{
  const result=await wrapped({app:'telegram',intent:'find_post',
    query:'updated announcement',channel:'@examplechannel'},{
    telegramApi:{findPosts:async(query,channel)=>{
      assert.equal(query,'updated announcement');
      assert.equal(channel,'examplechannel');
      return {results:[
        {post_url:ref,message_id:'123',is_own_post:true,can_edit:true,
          text_excerpt:'Here is my announcement'},
        {post_url:'https://t.me/anotherchannel/654',is_own_post:true},
        {post_url:'https://evil.t.me/examplechannel/42',is_own_post:true},
        {post_url:'https://t.me/examplechannel/124',is_own_post:false},
        {post_url:ref,is_own_post:true},
      ]};
    }},
  });
  assert.equal(result.status,'candidate_found');
  assert.equal(result.match_count,1);
  assert.equal(result.results[0].post_url,ref);
  assert.equal(result.results[0].can_edit_hint,true);
  assert.equal(result.ownership_verified,false);
  assert.equal(result.verified,false);
  assert.equal(result.screenshot_used,false);
  assert.ok(!JSON.stringify(result).includes('updated announcement'));
});

test('find_post requires exact app and user query; returns no link when provider unavailable',async()=>{
  assert.throws(()=>planAppTask({app:'telegram',intent:'find_post'}),/query/);
  assert.throws(()=>planAppTask({app:'blender',intent:'find_post',query:'search'}),/Telegram/);
  assert.throws(()=>planAppTask({app:'telegram',intent:'find_post',query:'ok',channel:'a!!'}),/channel/);
  const missing=await wrapped({app:'telegram',intent:'find_post',query:'last update'});
  assert.equal(missing.status,'blocked');
  assert.equal(missing.reason,'authenticated_telegram_search_provider_not_connected');
  const plan=await wrapped({app:'telegram',intent:'find_post',
    query:'private content',dry_run:true},{telegramApi:{findPosts:()=>assert.fail('dry-run must not call API')}});
  assert.equal(plan.status,'planned');
  assert.equal(plan.plan.query_length,15);
  assert.ok(!JSON.stringify(plan).includes('private content'));
});

test('find_post refuses excessive results and does not silently select ambiguous posts',async()=>{
  const multiple=await wrapped({app:'telegram',intent:'find_post',query:'news'},{
    telegramApi:{findPosts:async()=>({results:[
      {post_url:ref,is_own_post:true},
      {post_url:'https://t.me/examplechannel/124',is_own_post:true},
    ]})},
  });
  assert.equal(multiple.status,'multiple_candidates');
  assert.equal(multiple.match_count,2);
  assert.equal(multiple.executed,false);
  const oversized=await wrapped({app:'telegram',intent:'find_post',query:'news'},{
    telegramApi:{findPosts:async()=>({results:Array.from({length:21},()=>({post_url:ref,is_own_post:true}))})},
  });
  assert.equal(oversized.status,'blocked');
  assert.equal(oversized.reason,'invalid_or_excessive_post_results');
});

test('Telegram post parser rejects lookalike origins, credentials and malformed IDs',()=>{
  assert.deepEqual(telegramPostReference(ref),{
    url:ref,channel:'examplechannel',private_channel:null,message_id:'123',
  });
  assert.equal(telegramPostReference('https://t.me/c/123456/987?single').url,'https://t.me/c/123456/987');
  for(const url of ['http://t.me/examplechannel/123',
    'https://t.me.evil.org/examplechannel/123','https://evil.t.me/examplechannel/123',
    'https://someone@t.me/examplechannel/123','https://t.me:444/examplechannel/123',
    'https://t.me/examplechannel/not-an-id','https://t.me/examplechannel/0',
    'https://t.me/examplechannel/123#fragment','https://t.me/examplechannel/123?next=evil',
    'https://t.me/c/000/123','javascript:alert(1)','https://t.me/a/1']) {
    assert.throws(()=>telegramPostReference(url),undefined,url);
  }
  assert.throws(()=>validateAppTask({app:'telegram',intent:'edit_post',post_url:ref,
    replacement_text:'x\u202eY'}),/replacement_text/);
  assert.throws(()=>validateAppTask({app:'telegram',intent:'edit_post',post_url:ref,
    commit:true,replacement_text:'Edited'}),/expected_text/);
});

test('edit post without exact permalink requests identity, not a guessed chat',async()=>{
  const data=await wrapped({app:'telegram',intent:'edit_post'});
  assert.equal(data.status,'needs_exact_post_url');
  assert.equal(data.executed,false);
  const committed=await wrapped({...args,expected_text:'Original',replacement_text:'Revised',commit:true});
  assert.equal(committed.status,'blocked');
  assert.equal(committed.reason,'authenticated_telegram_edit_provider_not_connected');
});

test('Telegram Web fallback can only preview, never infer edit rights',async()=>{
  const out=await wrapped({...args,replacement_text:'Proposed revision'},{
    inspectTelegramWebPost:async()=>({status:'located',current_text:'Existing post'}),
  });
  assert.equal(out.status,'preview_only');
  assert.equal(out.current_text,'Existing post');
  assert.equal(out.own_post_verified,false);
  assert.equal(out.can_edit,false);
  assert.equal(out.executed,false);
});

test('authenticated Telegram provider demands exact post identity, ownership and edit permission',async()=>{
  let edits=0;
  for(const patch of [
    {post_url:'https://t.me/anotherchannel/123'},
    {message_id:'124'}, {chat_id:null}, {account_id:null},
    {is_own_post:false}, {can_edit:false},
  ]){
    const response=await wrapped({...args,expected_text:post.text,
      replacement_text:'Improved post',commit:true},{
      telegramApi:{getPost:async()=>({...post,...patch}),
        editPost:async()=>{edits++;return {ok:true}}},
    });
    assert.equal(response.status,'blocked');
  }
  assert.equal(edits,0);
});

test('Telegram post mutation refuses rich text, captions, link previews and missing content metadata',async()=>{
  let edits=0;
  const unsupported=[
    {content_kind:'photo',has_media:true},
    {content_kind:'video',has_media:true},
    {content_kind:'text',has_text_entities:true},
    {content_kind:'text',has_link_preview:true},
    {content_kind:undefined},
    {has_text_entities:undefined},
    {has_media:undefined},
    {has_link_preview:undefined},
  ];
  for(const properties of unsupported){
    const output=await wrapped({...args,expected_text:post.text,
      replacement_text:'Corrected plain text',commit:true},{
      telegramApi:{
        getPost:async()=>({...post,...properties}),
        editPost:async()=>{edits++;return {ok:true}},
      },
    });
    assert.equal(output.status,'blocked');
    assert.equal(output.reason,'telegram_post_format_or_media_not_supported');
    assert.equal(output.executed,false);
  }
  assert.equal(edits,0);
});

test('Telegram edit read-back rejects unexpected formatting introduced after save',async()=>{
  let calls=0;
  const api={
    getPost:async()=>calls++?{...post,text:'Updated',has_text_entities:true}:post,
    editPost:async()=>({ok:true}),
  };
  const result=await wrapped({...args,expected_text:post.text,
    replacement_text:'Updated',commit:true},{telegramApi:api});
  assert.equal(result.status,'outcome_unknown');
  assert.equal(result.verified,false);
});

test('API edit requires preview or expected original text, and refuses race changes',async()=>{
  let edits=0;
  const api={getPost:async()=>post,editPost:async()=>{edits++;return {ok:true}}};
  const preview=await wrapped({...args,replacement_text:'Revised post'},{telegramApi:api});
  assert.equal(preview.status,'ready_for_review');
  assert.equal(preview.current_text,post.text);
  const changed=await wrapped({...args,expected_text:'Previous version',
    replacement_text:'Revised post',commit:true},{telegramApi:api});
  assert.equal(changed.status,'blocked');
  assert.equal(changed.reason,'original_post_text_changed');
  assert.equal(edits,0);
});

test('authorized API provider can edit exact owned post and read it back, once',async()=>{
  let current={...post};
  const calls=[];
  const api={
    getPost:async()=>({...current}),
    editPost:async payload=>{
      calls.push(payload);
      current={...current,text:payload.new_text,revision:'v10'};
      return {ok:true};
    },
  };
  const outcome=await wrapped({...args,expected_text:'Original post',
    replacement_text:'Corrected post',commit:true},{telegramApi:api});
  assert.equal(outcome.status,'completed');
  assert.equal(outcome.verified,true);
  assert.equal(outcome.verification,'same_authenticated_post_read_back');
  assert.equal(calls.length,1);
  assert.equal(calls[0].account_id,'owner-42');
  assert.equal(calls[0].expected_revision,'v9');
  assert.equal(calls[0].expected_text,'Original post');
  assert.ok(!JSON.stringify(outcome).includes('Corrected post'));
  const second=await wrapped({...args,expected_text:'Original post',
    replacement_text:'Corrected post',commit:true},{telegramApi:api});
  assert.equal(second.status,'already_applied');
  assert.equal(calls.length,1);
});

test('post edits with failed read-back or ambiguous server errors never retry blindly',async()=>{
  for(const mode of ['server_changed_other_text','api_timeout']){
    let calls=0;
    const api={
      getPost:async()=>{
        if(!calls)return {...post};
        return {...post,text:mode==='server_changed_other_text'?'Other text':'Edited post'};
      },
      editPost:async()=>{
        calls++;
        if(mode==='api_timeout')throw Error('timeout after request');
        return {ok:true};
      },
    };
    const result=await wrapped({...args,expected_text:post.text,
      replacement_text:'Edited post',commit:true},{telegramApi:api});
    assert.equal(result.status,'outcome_unknown');
    assert.equal(result.verified,false);
    assert.equal(calls,1);
  }
});

test('read-only Telegram Web inspector pins exact trusted tab and never edits',async()=>{
  const postRef=telegramPostReference(ref);
  let pageFunctions=0;
  const response=await inspectTelegramWebPost(postRef,{target_id:'trusted-tab'},{
    browserTabs:async()=>({structuredContent:[
      {id:'trusted-tab',target_id:'trusted-tab',url:'https://web.telegram.org/k/',title:'Telegram'},
      {id:'evil',target_id:'evil',url:'https://web.telegram.org.evil.com',title:'Impostor'},
    ]}),
    withTarget:async (_args,callback)=>callback({id:'test-session'},
      {url:'https://web.telegram.org/k/',id:'trusted-tab'}),
    callPageFunction:async (_session,source,values)=>{
      pageFunctions++;
      assert.equal(source,PAGE_TELEGRAM_POST_READ);
      assert.equal(values[0].url,ref);
      assert.doesNotMatch(source,/\.click\(|\.submit\(|fetch\(|XMLHttpRequest/);
      return {status:'located',current_text:'Hello'};
    },
  });
  assert.equal(response.status,'located');
  assert.equal(response.target_id,'trusted-tab');
  assert.equal(response.verified_origin,true);
  assert.equal(pageFunctions,1);
});

test('web post inspection rejects origin change before page-side code',async()=>{
  let calls=0;
  const result=await inspectTelegramWebPost(telegramPostReference(ref),{},{
    browserTabs:async()=>({structuredContent:[{
      id:'t1',target_id:'t1',url:'https://web.telegram.org/k/',title:'Telegram'}]}),
    withTarget:async (_,f)=>f({}, {url:'https://web.telegram.org.evil.com/'}),
    callPageFunction:async()=>{calls++;return {status:'located'};},
  });
  assert.equal(result.status,'unavailable');
  assert.equal(result.reason,'browser_origin_changed');
  assert.equal(calls,0);
});
