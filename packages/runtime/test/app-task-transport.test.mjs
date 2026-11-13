import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,chmodSync,rmSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {appConnectorSocket,connectedTelegramAppProvider,connectedApplicationProvider,
  appConnectorRequest,APP_CONNECTOR_PROTOCOL} from '../src/extended/app-task-transport.mjs';
import {appTask} from '../src/extended/app-task.mjs';
import {appConnectorLocation} from '../src/extended/app-connector-path.mjs';

async function socketFixture(t,replyHandler){
  const root=mkdtempSync(path.join(tmpdir(),'remcp-app-adapter-'));
  const location=appConnectorLocation('telegram',{home:root,uid:process.getuid(),platform:'linux'});
  const dir=location.dir;
  mkdirSync(dir,{recursive:true,mode:0o700});
  chmodSync(dir,0o700);
  const sock=location.socket;
  const requests=[];
  const server=createServer(client=>{
    let data='';
    client.on('data',chunk=>{
      data+=String(chunk);
      if(!data.includes('\n'))return;
      let request;
      try{request=JSON.parse(data.slice(0,data.indexOf('\n')));}catch{client.destroy();return}
      requests.push(request);
      const response=replyHandler(request);
      if(response?.__split_utf8) {
        const {__split_utf8,...reply}=response;
        const bytes=Buffer.from(JSON.stringify(reply)+'\n');
        const marker=Buffer.from('€','utf8');
        const split=bytes.indexOf(marker);
        if(split<0){client.destroy();return}
        client.write(bytes.subarray(0,split+1));
        setImmediate(()=>client.end(bytes.subarray(split+1)));
      }else if(response)client.end(JSON.stringify(response)+'\n');
    });
  });
  await new Promise((resolve,reject)=>server.listen(sock,err=>err?reject(err):resolve()));
  chmodSync(sock,0o600);
  const options={home:root,uid:process.getuid(),platform:'linux'};
  t.after(async()=>{
    await new Promise(done=>server.close(()=>done()));
    if(location.short)rmSync(location.dir,{recursive:true,force:true});
    rmSync(root,{recursive:true,force:true});
  });
  return {root,dir,sock,server,requests,options};
}
const post={
  post_url:'https://t.me/examplechannel/123',message_id:'123',
  chat_id:'-1004242',account_id:'self',is_own_post:true,can_edit:true,
  text:'Before',revision:7,content_kind:'text',
  has_text_entities:false,has_media:false,has_link_preview:false,
};

test('authenticated local Unix app connector supports read, edit and readback without browser screenshots',
  {skip:process.platform!=='linux'&&process.platform!=='darwin'},async t=>{
  let current={...post};
  const fixture=await socketFixture(t,request=>{
    const base={protocol:APP_CONNECTOR_PROTOCOL,request_id:request.request_id,ok:true};
    if(request.operation==='get_post')return {...base,result:current};
    if(request.operation==='edit_post'){
      if(request.params.expected_text!==current.text)return {...base,ok:false};
      current={...current,text:request.params.new_text,revision:8};
      return {...base,result:{ok:true}};
    }
    return {...base,ok:false};
  });
  const api=connectedTelegramAppProvider(fixture.options);
  assert.ok(api);
  const before=await api.getPost({url:post.post_url});
  assert.equal(before.text,'Before');
  const output=(await appTask({app:'telegram',intent:'edit_post',
    post_url:post.post_url,expected_text:'Before',
    replacement_text:'After',commit:true},{connectorOptions:fixture.options})).structuredContent;
  assert.equal(output.status,'completed');
  assert.equal(output.verified,true);
  assert.equal(fixture.requests.filter(r=>r.operation==='edit_post').length,1);
  assert.deepEqual(fixture.requests.map(r=>r.operation),['get_post','get_post','edit_post','get_post']);
  assert.ok(fixture.requests.every(r=>r.protocol===APP_CONNECTOR_PROTOCOL));
  assert.ok(fixture.requests.every(r=>!JSON.stringify(r).includes('api_hash')));
  assert.ok(!JSON.stringify(output).includes('After'));
});

test('Telegram find_posts uses the same owner-only socket without opening a UI',
  {skip:process.platform!=='linux'&&process.platform!=='darwin'},async t=>{
  const fixture=await socketFixture(t,request=>{
    assert.equal(request.app,'telegram');
    assert.equal(request.operation,'find_posts');
    assert.equal(request.params.query,'release');
    assert.equal(request.params.channel,'examplechannel');
    return {protocol:APP_CONNECTOR_PROTOCOL,request_id:request.request_id,ok:true,
      result:{results:[{post_url:'https://t.me/examplechannel/123',
        message_id:'123',is_own_post:true,can_edit:true}]}};
  });
  const api=connectedTelegramAppProvider(fixture.options);
  const out=await api.findPosts('release','examplechannel');
  assert.equal(out.results.length,1);
  assert.equal(fixture.requests.length,1);
});

test('socket connector rejects world-readable socket and insecure directory',
  {skip:process.platform!=='linux'&&process.platform!=='darwin'},async t=>{
  const fixture=await socketFixture(t,req=>({
    protocol:APP_CONNECTOR_PROTOCOL,request_id:req.request_id,ok:true,result:post,
  }));
  assert.ok(appConnectorSocket('telegram',fixture.options));
  chmodSync(fixture.sock,0o666);
  assert.equal(appConnectorSocket('telegram',fixture.options),null);
  chmodSync(fixture.sock,0o600);
  chmodSync(fixture.dir,0o755);
  assert.equal(appConnectorSocket('telegram',fixture.options),null);
  chmodSync(fixture.dir,0o700);
  assert.equal(appConnectorSocket('telegram',{...fixture.options,uid:process.getuid()+1}),null);
  assert.equal(appConnectorSocket('other-app',fixture.options),null);
  assert.equal(appConnectorSocket('telegram',{...fixture.options,platform:'win32'}),null);
});

test('fragmented UTF-8 Unicode from a local app remains readable across socket chunks',
  {skip:process.platform!=='linux'&&process.platform!=='darwin'},async t=>{
  const fixture=await socketFixture(t,request=>({
    protocol:APP_CONNECTOR_PROTOCOL,request_id:request.request_id,ok:true,
    result:{ok:true,results:[{id:'symbol-1',label:'€ znak 𐀀'}]},
    __split_utf8:true,
  }));
  const provider=connectedApplicationProvider('telegram',fixture.options);
  const result=await provider.find('symbol');
  assert.equal(result.results[0].label,'€ znak 𐀀');
});

test('wrong response ID or version and unsupported operations are rejected',
  {skip:process.platform!=='linux'&&process.platform!=='darwin'},async t=>{
  const fixture=await socketFixture(t,request=>({
    protocol:'other.app.v1',request_id:'wrong',ok:true,result:{ok:true},
  }));
  await assert.rejects(()=>appConnectorRequest(fixture.sock,'get_post',{post_url:post.post_url}),/unauthenticated|unsuccessful/);
  assert.throws(()=>appConnectorRequest(fixture.sock,'execute_script',{}),/Unsupported/);
});

test('one unified connector protocol is reusable for another registered application',
  {skip:process.platform!=='linux'&&process.platform!=='darwin'},async t=>{
  const fixture=await socketFixture(t,request=>({
    protocol:APP_CONNECTOR_PROTOCOL,request_id:request.request_id,ok:true,
    result:{ok:true,results:[{id:'asset-1',label:'Scene object'}]},
  }));
  const other=path.join(fixture.dir,'blender.sock');
  const {renameSync}=await import('node:fs');
  renameSync(fixture.sock,other);
  chmodSync(other,0o600);
  assert.ok(appConnectorSocket('blender',fixture.options));
  const provider=connectedApplicationProvider('blender',fixture.options);
  const result=await provider.find('scene');
  assert.equal(result.results[0].label,'Scene object');
  assert.equal(fixture.requests[0].app,'blender');
  assert.equal(fixture.requests[0].operation,'find');
  assert.throws(()=>appConnectorRequest(other,'edit_post',{},{
    ...fixture.options,app:'blender'}),/Unsupported/);
});

test('real post edit receives a provider disconnect as uncertain, with no retry',
  {skip:process.platform!=='linux'&&process.platform!=='darwin'},async t=>{
  let edits=0;
  const fixture=await socketFixture(t,request=>{
    const base={protocol:APP_CONNECTOR_PROTOCOL,request_id:request.request_id,ok:true};
    if(request.operation==='get_post')return {...base,result:post};
    if(request.operation==='edit_post'){edits++;return null}
    return null;
  });
  const data=(await appTask({app:'telegram',intent:'edit_post',
    post_url:post.post_url,expected_text:'Before',
    replacement_text:'After',commit:true},{connectorOptions:fixture.options})).structuredContent;
  assert.equal(data.status,'outcome_unknown');
  assert.equal(data.verified,false);
  assert.equal(edits,1);
});
