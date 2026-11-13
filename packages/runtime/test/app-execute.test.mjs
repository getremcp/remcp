import test from 'node:test';
import assert from 'node:assert/strict';
import {appExecute,validateAppExecute} from '../src/extended/app-execute.mjs';

import {createAppExecuteJournal} from '../src/extended/app-execute-journal.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after} from 'node:test';

const testHome=mkdtempSync(path.join(tmpdir(),'remcp-execute-tests-'));
const operationJournal=createAppExecuteJournal({directory:path.join(testHome,'journal'),maxEntries:128});
const execute=(args,adapters={})=>appExecute(args,{operationJournal,...adapters});
after(()=>rmSync(testHome,{recursive:true,force:true}));

const origin='https://example.com';
const target='test-cdp-page';
const form=(operation_id,extras={})=>({mode:'browser_form',origin,target_id:target,
  fields:[{label:'Email',value:'private+new@example.test',expected_value:'before@example.test'}],
  commit:true,operation_id,...extras});
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'];

test('one-call form is guarded to exact origin and semantic label, with in-flight replay protection',async()=>{
 let dispatched=0;
 const run=async args=>{
  dispatched++;
  assert.equal(args.action,'fill_form');
  assert.equal(args.expected_origin,origin);
  assert.equal(args.target_id,target);
  assert.equal(args.fields[0].label,'Email');
  return {structuredContent:{target_id:target,action:'fill_form',result:{filled:1,verified:true,verified_fields:1,submitted:false}}};
 };
 const output=(await execute(form(ids[0]),{browserAction:run})).structuredContent;
 assert.equal(output.status,'completed');
 assert.equal(output.verified,true);
 assert.equal(output.via,'guarded_local_browser_dom');
 assert.equal(output.submitted,false);
 assert.ok(!JSON.stringify(output).includes('private+new@example.test'));
 const replay=(await execute(form(ids[0]),{browserAction:run})).structuredContent;
 assert.equal(replay.replayed,true);
 assert.equal(dispatched,1,'one operation id is never applied twice in the same worker');
 await assert.rejects(()=>execute(form(ids[0],{fields:[{label:'Email',value:'different'}]}),{browserAction:run}),/reused/);
});

test('preview never calls a real browser and never exposes text fields',async()=>{
 const preview=(await execute({...form(ids[1]),commit:false}, {
  browserAction:()=>assert.fail('preview must not mutate browser'),
 })).structuredContent;
 assert.equal(preview.status,'planned');
 assert.equal(preview.field_count,1);
 assert.equal(preview.executed,false);
 assert.ok(!JSON.stringify(preview).includes('before@example.test'));
 assert.ok(!JSON.stringify(preview).includes('private+new@example.test'));
});

test('browser mutation requires exact target, trusted origin and a caller operation UUID',async()=>{
 for (const bad of [
  {...form(ids[1]),origin:'https://example.com/hijack'},
  {...form(ids[1]),origin:'https://user:pass@example.com'},
  {...form(ids[1]),target_id:'../../relative'},
  {...form(ids[1]),fields:[{selector:'#field',label:'Ambiguous',value:'x'}]},
 ]) assert.throws(()=>validateAppExecute(bad),/origin|browser target_id|one CSS selector/);
 await assert.rejects(()=>execute({...form(ids[1]),operation_id:undefined}),/caller-supplied operation_id/);
});

test('ambiguous browser mutation cannot be retried blindly after an adapter failure',async()=>{
 let dispatched=0;
 const broken=async()=>{dispatched++;throw Error('Private page URL and secret input values must never escape')};
 const a=(await execute(form(ids[2]),{browserAction:broken})).structuredContent;
 assert.equal(a.status,'outcome_unknown');
 assert.equal(a.verified,false);
 assert.ok(!JSON.stringify(a).includes('Private page URL'));
 const b=(await execute(form(ids[2]),{browserAction:broken})).structuredContent;
 assert.equal(b.replayed,true);
 assert.equal(dispatched,1);
});

test('registered app APIs are read-only by default and writing requires commit',async()=>{
 let calls=0;
 const inspect=async args=>{
  calls++;
  assert.equal(args.app,'blender');
  return {structuredContent:{status:'inspected',executed:false,verified:true}};
 };
 const r=(await execute({mode:'app_task',task:{app:'blender',intent:'inspect'}},{appTask:inspect})).structuredContent;
 assert.equal(r.status,'inspected');
 assert.equal(r.verified,true);
 assert.equal(calls,1);
 const inspectPreview=(await execute({mode:'app_task',task:{app:'blender',intent:'inspect'},dry_run:true},{appTask:()=>assert.fail('dry run must not inspect even read-only app')})).structuredContent;
 assert.equal(inspectPreview.status,'planned');
 assert.equal(inspectPreview.requires_commit,false);
 assert.equal(calls,1);
 const preview=(await execute({mode:'app_task',task:{app:'telegram',intent:'edit_post',
  post_url:'https://t.me/examplechannel/123',expected_text:'old',replacement_text:'new'}},{appTask:inspect})).structuredContent;
 assert.equal(preview.status,'planned');
 assert.equal(calls,1);
});

test('native app action exposes no raw command or unsupported arbitrary handler',()=>{
 assert.throws(()=>validateAppExecute({mode:'app_task',task:{app:'blender',intent:'inspect',shell:'rm -rf /'}}),/closed task object/);
 assert.throws(()=>validateAppExecute({mode:'raw',code:'dangerous'}),/unsupported argument|mode/);
 assert.throws(()=>validateAppExecute({mode:'app_task',task:{app:'telegram',intent:'set_control_text'}}),/Generic control actions/);
});

test('browser tool error or unexpected submission never certifies a form mutation',async()=>{
 const reports=[
  {isError:true,structuredContent:{target_id:target,action:'fill_form',result:{filled:1,verified:true,verified_fields:1,submitted:false}}},
  {structuredContent:{target_id:target,action:'fill_form',result:{filled:1,verified:true,verified_fields:1,submitted:true}}},
 ];
 for(let i=0;i<reports.length;i++){
  const operation_id=i===0?'77777777-7777-4777-8777-777777777777':
    '88888888-8888-4888-8888-888888888888';
  const result=(await execute(form(operation_id),{browserAction:async()=>reports[i]})).structuredContent;
  assert.equal(result.status,'outcome_unknown');
  assert.equal(result.verified,false);
  assert.equal(result.submitted,null);
 }
});

test('browser readback requires matching target, action, field count and no-submit proof',async()=>{
 const valid={target_id:target,action:'fill_form',
  result:{filled:1,verified_fields:1,verified:true,submitted:false}};
 const cases=[
  {...valid,target_id:'wrong-tab'},
  {...valid,action:'click'},
  {...valid,result:{...valid.result,verified_fields:undefined}},
  {...valid,result:{...valid.result,verified_fields:0}},
  {...valid,result:{...valid.result,submitted:undefined}},
 ];
 for(let i=0;i<cases.length;i++){
  const operation_id='f0000000-0000-4000-8000-'+String(i+1).padStart(12,'0');
  const out=(await execute(form(operation_id),{
   browserAction:async()=>({structuredContent:cases[i]}),
  })).structuredContent;
  assert.equal(out.status,'outcome_unknown',`case ${i} must fail closed`);
  assert.equal(out.verified,false);
  assert.equal(out.submitted,null);
 }
});

test('read-only app find runs without a commit UUID and dry-run never searches',async()=>{
 let searches=0;
 const args={mode:'app_task',task:{app:'telegram',intent:'find',query:'needle'}};
 const adapter={appTask:async task=>{
  searches++;
  assert.equal(task.intent,'find');
  assert.equal(task.query,'needle');
  return {structuredContent:{status:'completed',executed:false,verified:true}};
 }};
 const result=(await execute(args,adapter)).structuredContent;
 assert.equal(result.status,'completed');
 assert.equal(result.verified,true);
 assert.equal(result.executed,false);
 assert.equal(searches,1);
 const preview=(await execute({...args,dry_run:true},adapter)).structuredContent;
 assert.equal(preview.status,'planned');
 assert.equal(preview.requires_commit,false);
 assert.equal(searches,1);
});

test('unverified app mutations cannot claim completed even if adapter reports success',async()=>{
 let mutations=0;
 const task={app:'telegram',intent:'edit_post',post_url:'https://t.me/examplechannel/123',
  expected_text:'old',replacement_text:'new'};
 for(const [operation_id,report] of [
  ['55555555-5555-4555-8555-555555555555',{status:'completed',executed:true,verified:false}],
  ['66666666-6666-4666-8666-666666666666',{status:'completed',executed:false,verified:true}],
 ]){
  const result=(await execute({mode:'app_task',task,commit:true,operation_id},{
   appTask:async()=>{mutations++;return {structuredContent:report}},
  })).structuredContent;
  assert.equal(result.status,'outcome_unknown');
  assert.equal(result.verified,false);
  assert.equal(result.reason,'app_mutation_readback_unverified');
 }
 assert.equal(mutations,2);
});

test('app-task tool errors cannot report a completed mutation or verified inspection',async()=>{
 const task={app:'telegram',intent:'edit_post',post_url:'https://t.me/examplechannel/123',
  expected_text:'old',replacement_text:'new'};
 const mutation=(await execute({mode:'app_task',task,commit:true,
  operation_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'},{
  appTask:async()=>({isError:true,structuredContent:{
   status:'completed',executed:true,verified:true}}),
 })).structuredContent;
 assert.equal(mutation.status,'outcome_unknown');
 assert.equal(mutation.verified,false);
 assert.equal(mutation.executed,null);
 const inspection=(await execute({mode:'app_task',
  task:{app:'blender',intent:'inspect'}},{
  appTask:async()=>({isError:true,structuredContent:{
   status:'inspected',executed:false,verified:true}}),
 })).structuredContent;
 assert.equal(inspection.status,'inspection_unavailable');
 assert.equal(inspection.verified,false);
 assert.equal(inspection.executed,false);
});

test('read-only completion requires an attested inspection or search',async()=>{
 for(const [intent,status] of [['inspect','inspected'],['find','completed']]){
  const task={app:'blender',intent,...(intent==='find'?{query:'needle'}:{})};
  const out=(await execute({mode:'app_task',task},{
   appTask:async()=>({structuredContent:{status,executed:false,verified:false}}),
  })).structuredContent;
  assert.equal(out.status,'inspection_unavailable');
  assert.equal(out.verified,false);
  assert.equal(out.executed,false);
  assert.equal(out.reason,'app_read_only_readback_unverified');
 }
 const contradiction=(await execute({mode:'app_task',
   task:{app:'blender',intent:'inspect'}},{
   appTask:async()=>({structuredContent:{status:'inspected',
     executed:true,verified:true}}),
 })).structuredContent;
 assert.equal(contradiction.status,'outcome_unknown');
 assert.equal(contradiction.executed,null);
 assert.equal(contradiction.verified,false);
 assert.equal(contradiction.reason,'read_only_adapter_reported_mutation');
});

test('blocked and failed adapter statuses cannot carry a verified success claim',async()=>{
 const cases=[
  {status:'blocked',executed:false,verified:true},
  {status:'outcome_unknown',executed:null,verified:true},
  {status:'ready_for_review',executed:false,verified:true},
  {status:'inspection_unavailable',executed:false,verified:true},
 ];
 for(const report of cases){
  const out=(await execute({mode:'app_task',task:{app:'blender',intent:'inspect'}},{
   appTask:async()=>({structuredContent:report}),
  })).structuredContent;
  assert.equal(out.verified,false,'unverified terminal status cannot certify success');
 }
 const task={app:'telegram',intent:'edit_post',post_url:'https://t.me/examplechannel/123',
  expected_text:'old',replacement_text:'new'};
 const out=(await execute({mode:'app_task',task,commit:true,
  operation_id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'},{
  appTask:async()=>({structuredContent:{status:'blocked',executed:true,verified:true}}),
 })).structuredContent;
 assert.equal(out.status,'outcome_unknown');
 assert.equal(out.executed,null);
 assert.equal(out.verified,false);
 assert.equal(out.reason,'app_mutation_status_contradiction');
});

test('already_applied is verified only when the adapter reports no write',async()=>{
 const task={app:'telegram',intent:'edit_post',post_url:'https://t.me/examplechannel/123',
  expected_text:'old',replacement_text:'new'};
 const first=(await execute({mode:'app_task',task,commit:true,
  operation_id:'abababab-cdcd-4aba-8aba-000000000001'},{
  appTask:async()=>({structuredContent:{status:'already_applied',executed:false,verified:true}}),
 })).structuredContent;
 assert.equal(first.status,'already_applied');
 assert.equal(first.executed,false);
 assert.equal(first.verified,true);
 const contradictory=(await execute({mode:'app_task',task,commit:true,
  operation_id:'abababab-cdcd-4aba-8aba-000000000002'},{
  appTask:async()=>({structuredContent:{status:'already_applied',executed:true,verified:true}}),
 })).structuredContent;
 assert.equal(contradictory.status,'outcome_unknown');
 assert.equal(contradictory.executed,null);
 assert.equal(contradictory.verified,false);
 assert.equal(contradictory.reason,'app_noop_status_contradiction');
});

test('mutating execution times out as unknown and replay cannot repeat a late action',async()=>{
 let invocations=0;
 let finish;
 const adapter={browserAction:()=>{
  invocations++;
  return new Promise(resolve=>{finish=resolve});
 }};
 const args=form('99999999-9999-4999-8999-999999999999',{timeout_ms:120});
 // A bounded delayed settlement makes the pre-fix behavior fail rather than hang.
 const release=setTimeout(()=>finish?.({structuredContent:{target_id:target,action:'fill_form',result:{
  filled:1,verified_fields:1,verified:true,submitted:false}}}),350);
 try{
  const result=(await execute(args,adapter)).structuredContent;
  assert.equal(result.status,'outcome_unknown');
  assert.equal(result.verified,false);
  assert.equal(result.reason,'operation_timed_out_reinspect_before_retry');
  const replay=(await execute(args,adapter)).structuredContent;
  assert.equal(replay.replayed,true);
  assert.equal(replay.status,'outcome_unknown');
  assert.equal(invocations,1,'never repeat a timed-out mutation');
 }finally{clearTimeout(release);finish?.({structuredContent:{target_id:target,action:'fill_form',result:{
  filled:1,verified_fields:1,verified:true,submitted:false}}})}
});

test('app-task mutation timeout is durable, and late success never upgrades its result',async()=>{
 let invocations=0;
 let finish;
 const args={mode:'app_task',task:{app:'telegram',intent:'edit_post',
   post_url:'https://t.me/examplechannel/123',expected_text:'old',
   replacement_text:'new'},commit:true,
   operation_id:'abababab-abab-4aba-8aba-abababababab',timeout_ms:120};
 const adapter={appTask:()=>{
  invocations++;
  return new Promise(resolve=>{finish=resolve});
 }};
 const result=(await execute(args,adapter)).structuredContent;
 assert.equal(result.status,'outcome_unknown');
 assert.equal(result.reason,'operation_timed_out_reinspect_before_retry');
 finish({structuredContent:{status:'completed',executed:true,verified:true}});
 await new Promise(resolve=>setImmediate(resolve));
 const replay=(await execute(args,adapter)).structuredContent;
 assert.equal(replay.replayed,true);
 assert.equal(replay.status,'outcome_unknown');
 assert.equal(replay.verified,false);
 assert.equal(invocations,1);
});

test('read-only inspection times out as unavailable without a mutation journal',async()=>{
 let inspections=0;
 const args={mode:'app_task',task:{app:'blender',intent:'inspect'},timeout_ms:120};
 const adapter={appTask:async()=>{
  inspections++;
  await new Promise(resolve=>setTimeout(resolve,350));
  return {structuredContent:{status:'inspected',executed:false,verified:true}};
 }};
 const out=(await execute(args,adapter)).structuredContent;
 assert.equal(out.status,'inspection_unavailable');
 assert.equal(out.executed,false);
 assert.equal(out.reason,'read_only_operation_timeout');
 assert.equal(inspections,1);
});

test('replay journal refuses capacity overflow rather than evicting unexpired mutation records',async()=>{
 let executed=0;
 const adapter={browserAction:async()=>{executed++;return {structuredContent:{target_id:target,action:'fill_form',result:{filled:1,verified:true,verified_fields:1,submitted:false}}};}};
 const first=form(ids[0]);
 const original=(await execute(first,adapter)).structuredContent;
 assert.equal(original.replayed,true,'earlier operation stays cached');
 let admitted=0,blocked=false;
 for(let i=0;i<130;i++){
  const operation_id='dddddddd-dddd-4ddd-8ddd-'+i.toString(16).padStart(12,'0');
  try{
   const out=(await execute(form(operation_id),adapter)).structuredContent;
   assert.equal(out.status,'completed');admitted++;
  }catch(e){
   assert.match(String(e),/journal is full/);blocked=true;break;
  }
 }
 assert.equal(blocked,true,'must fail closed before any unexpired id is evicted');
 assert.ok(admitted>100);
 const replay=(await execute(first,adapter)).structuredContent;
 assert.equal(replay.replayed,true,'old operation is not executed a second time');
 assert.equal(executed,admitted,'the old operation did not re-run');
});
