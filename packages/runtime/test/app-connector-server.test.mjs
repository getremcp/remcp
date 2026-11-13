import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,chmodSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startAppConnectorServer} from '../src/extended/app-connector-server.mjs';
import {connectedTelegramAppProvider,appConnectorRequest,appConnectorSocket}
  from '../src/extended/app-task-transport.mjs';
import {appTask} from '../src/extended/app-task.mjs';

const unix=process.platform==='linux'||process.platform==='darwin';
const ref='https://t.me/examplechannel/123';
const baseline={post_url:ref,message_id:'123',chat_id:'-1009871',
  account_id:'qa-user',is_own_post:true,can_edit:true,text:'First draft',
  content_kind:'text',has_text_entities:false,has_media:false,
  has_link_preview:false,revision:'first',
};

async function boot(t,handlers){
  const home=mkdtempSync(path.join(tmpdir(),'remcp-bridge-sdk-'));
  const options={home,uid:process.getuid(),platform:process.platform};
  let instance=null;
  t.after(async()=>{
    if(instance)await instance.close();
    rmSync(home,{recursive:true,force:true});
  });
  instance=await startAppConnectorServer('telegram',handlers,options);
  return {instance,options};
}

test('generic SDK uses strict user-only socket and supports one-shot app API routing',
  {skip:!unix},async t=>{
  let state={...baseline},editCount=0;
  const {instance,options}=await boot(t,{
    get_post:async()=>({...state}),
    edit_post:async ({expected_text,new_text,expected_revision})=>{
      assert.equal(expected_text,state.text);
      assert.equal(expected_revision,state.revision);
      editCount++;
      state={...state,text:new_text,revision:'second'};
      return {ok:true};
    },
    find_posts:async ()=>({results:[{post_url:ref,is_own_post:true,message_id:'123'}]}),
    find:async ()=>({ok:true,results:[]}),
    inspect:async ()=>({ok:true,available:true,capabilities:['find_posts']}),
  });
  assert.ok(lstatSync(instance.socket_path).isSocket());
  assert.equal(lstatSync(instance.socket_path).mode&0o077,0);
  assert.equal(appConnectorSocket('telegram',options),instance.socket_path);
  const candidates=(await appTask({app:'telegram',intent:'find_post',
    query:'First',channel:'examplechannel'},{connectorOptions:options})).structuredContent;
  assert.equal(candidates.status,'candidate_found');
  assert.equal(candidates.results[0].post_url,ref);
  assert.equal(candidates.verified,false);
  const result=(await appTask({app:'telegram',intent:'edit_post',post_url:ref,
    expected_text:'First draft',replacement_text:'Improved post',
    commit:true},{connectorOptions:options})).structuredContent;
  assert.equal(result.status,'completed');
  assert.equal(result.verified,true);
  assert.equal(editCount,1);
  assert.equal(state.text,'Improved post');
});

test('the same connector SDK supports Blender app search with no GUI, CDP or screenshot',
  {skip:!unix},async t=>{
  const home=mkdtempSync(path.join(tmpdir(),'remcp-blender-bridge-'));
  const options={home,uid:process.getuid(),platform:process.platform};
  let server;
  t.after(async()=>{
    if(server)await server.close();
    rmSync(home,{recursive:true,force:true});
  });
  server=await startAppConnectorServer('blender',{
    find:async ({query})=>({ok:true,results:[
      {id:'scene/object/007',label:'Cylinder',preview:'Matched: '+query},
    ]}),
    inspect:async ()=>({ok:true,available:true,capabilities:['find']}),
  },options);
  const result=(await appTask({app:'blender',intent:'find',query:'Cylinder'},
    {connectorOptions:options})).structuredContent;
  assert.equal(result.status,'completed');
  assert.equal(result.search_results_verified,true);
  assert.equal(result.via,'user_local_app_connector');
  assert.equal(result.screenshot_used,false);
  assert.equal(result.results[0].label,'Cylinder');
});

test('the server refuses invalid edit preconditions before invoking the companion',
  {skip:!unix},async t=>{
  let edits=0;
  const {options}=await boot(t,{
    get_post:async()=>baseline,
    edit_post:async()=>{edits++;return {ok:true}},
  });
  const api=connectedTelegramAppProvider(options);
  const valid={post_url:ref,message_id:'123',chat_id:baseline.chat_id,
    account_id:baseline.account_id,expected_text:baseline.text,
    expected_revision:baseline.revision,
    expected_content_kind:'text',expected_has_text_entities:false,
    expected_has_media:false,expected_has_link_preview:false,
    new_text:'Replacement'};
  await assert.rejects(()=>api.editPost({...valid,expected_text:'stale'}),
    /unsuccessful/);
  await assert.rejects(()=>api.editPost({...valid,expected_content_kind:'caption'}),
    /unsuccessful/);
  await assert.rejects(()=>api.editPost({...valid,message_id:'124'}),/unsuccessful/);
  assert.equal(edits,0);
});

test('server locks a post while one edit remains in flight',
  {skip:!unix},async t=>{
  let unblock;
  let entered;
  const started=new Promise(done=>{entered=done});
  const hold=new Promise(done=>{unblock=done});
  let edits=0;
  const {options}=await boot(t,{
    get_post:async()=>baseline,
    edit_post:async()=>{edits++;entered();await hold;return {ok:true}},
  });
  const api=connectedTelegramAppProvider(options);
  const params={post_url:ref,message_id:'123',chat_id:baseline.chat_id,
    account_id:baseline.account_id,expected_text:baseline.text,
    expected_content_kind:'text',expected_has_text_entities:false,
    expected_has_media:false,expected_has_link_preview:false,
    new_text:'Updated'};
  const first=api.editPost(params);
  await started;
  await assert.rejects(()=>api.editPost(params),/unsuccessful/);
  unblock();
  assert.equal((await first).ok,true);
  assert.equal(edits,1);
});

test('server rejects unregistered names and refuses to replace live sockets',
  {skip:!unix},async t=>{
  const {options}=await boot(t,{inspect:async()=>({ok:true})});
  await assert.rejects(()=>startAppConnectorServer('../arbitrary',{},{...options}),
    /Unregistered/);
  await assert.rejects(()=>startAppConnectorServer('telegram',{},{...options}),
    /already exists/);
});

test('private connector directory cannot be group readable',
  {skip:!unix},async t=>{
  const {instance,options}=await boot(t,{inspect:async()=>({ok:true})});
  const dir=path.dirname(instance.socket_path);
  chmodSync(dir,0o755);
  await assert.rejects(()=>startAppConnectorServer('blender',{inspect:async()=>({ok:true})},options),
    /private/);
  chmodSync(dir,0o700);
});
