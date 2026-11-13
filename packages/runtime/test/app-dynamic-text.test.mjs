import test from 'node:test';
import assert from 'node:assert/strict';
import {jsonResult} from '../src/extended/common.mjs';
import {appTask} from '../src/extended/app-task.mjs';
import {detectedAppRows} from '../src/extended/app-dynamic-discovery.mjs';
const name='Future Widget App';
const app=detectedAppRows([{name}]).apps[0].id;
const root={pid:321,app:name,window:name,role:'Window',name};
const field={id:'linux:321:r.0',pid:321,app:name,window:name,
  name:'Search',role:'entry',value:'hello',enabled:true};
const args={app,intent:'set_control_text',window_id:'win-1',pid:321,
  control_id:field.id,expected_name:'Search',expected_role:'entry',
  expected_text:'hello',replacement_text:'world',commit:true};
function adapter(options={}){
  let reads=0;
  return {platform:'linux',
    installedApps:async()=>jsonResult({data:[{name}],count:1,returned:1}),
    listWindows:async()=>jsonResult([{id:'win-1',pid:321,app:name,title:name}]),
    uiSnapshot:async()=>jsonResult({nodes:[root,{...field,value:(++reads>=2)?'world':'hello'}]}),
    uiAction:async()=>jsonResult({action:'set_value',backend:'test'}),
    ...options};
}
test('exact text mutation has CAS, strict native target, and second AX readback',async()=>{
  const sent=[];let reads=0;
  const result=(await appTask(args,adapter({
    uiSnapshot:async()=>jsonResult({nodes:[root,{...field,value:(++reads>=2)?'world':'hello'}]}),
    uiAction:async x=>{sent.push(x);return jsonResult({action:'set_value'})},
  }))).structuredContent;
  assert.equal(result.status,'completed');
  assert.equal(result.verified,true);
  assert.equal(result.verification,'native_text_readback');
  assert.equal(sent.length,1);
  assert.equal(sent[0].action,'set_value');
  assert.equal(sent[0].id,field.id);
  assert.equal(sent[0].strict_target_id,true);
  assert.equal(sent[0].window_id,'win-1');
  assert.equal(sent[0].semantic_only,true);
  assert.equal(sent[0].expected_value,'hello');
  assert.equal(sent[0].value,'world');
  assert.equal(JSON.stringify(result).includes('world'),false);
});
test('requires explicit commit, exact target and safe one-line values',async()=>{
  for(const patch of [{commit:false},{expected_text:undefined},
    {replacement_text:'hi\nthere'},{replacement_text:''},
    {replacement_text:'x'.repeat(257)},{replacement_text:'a\u202eb'},
    {app:'telegram'},{window_id:undefined},{control_id:undefined}]){
    await assert.rejects(()=>appTask({...args,...patch},adapter()));
  }
  const planned=(await appTask({...args,commit:false,dry_run:true},adapter())).structuredContent;
  assert.equal(planned.status,'planned');
  assert.equal(planned.executed,false);
  assert.equal(JSON.stringify(planned).includes('world'),false);
});
test('stale values, protected fields, and wrong roles reject before mutation',async()=>{
  for(const patch of [{value:'updated'},{enabled:false},
    {role:'Button'},{subrole:'AXSecureTextField'},{name:'password entry'},
    {readonly:true},{password:true},{readOnly:true}]){
    let writes=0;
    const result=(await appTask(args,adapter({
      uiSnapshot:async()=>jsonResult({nodes:[root,{...field,...patch}]}),
      uiAction:async()=>{writes++;throw Error('unexpected write')},
    }))).structuredContent;
    assert.equal(result.status,'blocked');
    assert.equal(writes,0);
  }
});
test('successful dispatch without value readback remains unverified',async()=>{
  const result=(await appTask(args,adapter({
    uiSnapshot:async()=>jsonResult({nodes:[root,field]}),
  }))).structuredContent;
  assert.equal(result.status,'dispatched_unverified');
  assert.equal(result.verified,false);
});
test('uncertain OS status never retries mutation',async()=>{
  let writes=0;
  const result=(await appTask(args,adapter({
    uiAction:async()=>{writes++;throw Error('connection lost')},
  }))).structuredContent;
  assert.equal(writes,1);
  assert.equal(result.status,'outcome_unknown');
  assert.equal(result.executed,null);
});
test('negative native acknowledgement cannot be promoted to success',async()=>{
  const result=(await appTask(args,adapter({
    uiAction:async()=>jsonResult({ok:false}),
  }))).structuredContent;
  assert.equal(result.status,'outcome_unknown');
  assert.equal(result.verified,false);
});
test('already applied update must not write again',async()=>{
  let writes=0;
  const result=(await appTask({...args,expected_text:'world'},adapter({
    uiSnapshot:async()=>jsonResult({nodes:[root,{...field,value:'world'}]}),
    uiAction:async()=>{writes++;throw Error('unexpected')},
  }))).structuredContent;
  assert.equal(result.status,'already_applied');
  assert.equal(writes,0);
});
test('inspect produces a blinded field-version token, not the old text',async()=>{
  const info=(await appTask({app,intent:'inspect'},adapter())).structuredContent;
  assert.equal(info.status,'inspected');
  const candidate=info.controls.find(x=>x.name==='Search');
  assert.match(candidate.value_token,/^av1\.\d{10}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(info).includes('"hello"'),false);
});
test('blind token from visible find can authorize one exact text change',async()=>{
  const found=(await appTask({app,intent:'find',query:'Search'},adapter())).structuredContent;
  assert.equal(found.status,'completed');
  const token=found.results.find(x=>x.name==='Search').value_token;
  assert.ok(token);
  const result=(await appTask({...args,expected_text:undefined,
    expected_value_token:token},adapter())).structuredContent;
  assert.equal(result.status,'completed');
  assert.equal(result.verified,true);
  assert.equal(JSON.stringify(result).includes('hello'),false);
  assert.equal(JSON.stringify(result).includes('world'),false);
});
test('altered, mismatched or already-replaced token never writes',async()=>{
  const inspected=(await appTask({app,intent:'inspect'},adapter())).structuredContent;
  const token=inspected.controls.find(x=>x.name==='Search').value_token;
  const altered=token.slice(0,-1)+(token.endsWith('A')?'B':'A');
  for(const patch of [
    {expected_value_token:altered},
    {expected_value_token:token,expected_text:'hello'},
  ]){
    let calls=0;
    if(patch.expected_text!=null){
      await assert.rejects(()=>appTask({...args,...patch},adapter()));
    }else{
      const result=(await appTask({...args,expected_text:undefined,...patch},
        adapter({uiAction:async()=>{calls++;throw Error('must not write')}}))).structuredContent;
      assert.equal(result.status,'blocked');
      assert.equal(calls,0);
    }
  }
  let calls=0;
  const stale=(await appTask({...args,expected_text:undefined,expected_value_token:token},
    adapter({uiSnapshot:async()=>jsonResult({nodes:[root,{...field,value:'changed'}]}),
      uiAction:async()=>{calls++;throw Error('must not write')}}))).structuredContent;
  assert.equal(stale.status,'blocked');
  assert.equal(calls,0);
});
test('a known background window is rejected before native text dispatch',async()=>{
  let calls=0;
  const result=(await appTask(args,adapter({
    listWindows:async()=>jsonResult([{id:'win-1',pid:321,app:name,title:name,active:false}]),
    uiAction:async()=>{calls++;throw Error('must not write')},
  }))).structuredContent;
  assert.equal(result.reason,'target_window_background');
  assert.equal(result.verified,false);
  assert.equal(calls,0);
});
test('secret and unsupported field labels never yield edit capabilities',async()=>{
  for(const name of ['Password','PIN','Recovery code','API token']){
    const result=(await appTask({app,intent:'inspect'},adapter({
      uiSnapshot:async()=>jsonResult({nodes:[root,{...field,name}]}),
    }))).structuredContent;
    assert.equal(result.controls.some(x=>x.name===name),false,name);
  }
});
