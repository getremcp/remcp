import test from 'node:test';
import assert from 'node:assert/strict';
import {eligibleWinFormsTextTarget,strictWinFormsText} from '../src/extended/desktop-windows-winforms-type.mjs';

const scope={id:'win:42.786838',pid:3816,
  window_id:'0x1D01D4',window_title:'ReMCP WinForms Native Input QA 2026',
  text:'Unicode QA 你好',clear:true,method:'accessibility'};
const root={id:'win:42.1901012',pid:3816,window_id:'0x1D01D4',
  window:'ReMCP WinForms Native Input QA 2026',active:true,role:'Window'};
const edit={id:'win:42.786838',pid:3816,
  window:'ReMCP WinForms Native Input QA 2026',role:'Edit',
  className:'WindowsForms10.EDIT.app.0.3ad42db_r8_ad1',
  name:'before',value:'before',password:false,enabled:true,offscreen:false,
  focusable:true,patterns:['value'],app:'powershell'};
async function simulate(args=scope, nodes=[root,edit], outcome={
  backend:'Win32WMSetText',foreground_after:true,value_matches_after:true,
}){
  let called=0,scoped=null;
  const result=await strictWinFormsText(args,{
    uiSnapshot:async ()=>({nodes}),
    uiAction:async requested=>{called++;scoped=requested;return outcome;},
    resultValue:value=>value,
  });
  return {called,scoped,result};
}

test('strict scoped native computer_type derives CAS from fresh UIA only',async()=>{
  assert.equal(eligibleWinFormsTextTarget(scope),true);
  const {called,scoped,result}=await simulate();
  assert.equal(called,1);
  assert.equal(scoped.strict_target_id,true);
  assert.equal(scoped.id,scope.id);
  assert.equal(scoped.window_id,scope.window_id);
  assert.equal(scoped.pid,scope.pid);
  assert.equal(scoped.expected_value,'before');
  assert.equal(scoped.role,'Edit');
  assert.equal(scoped.value,scope.text);
  assert.equal(result.verified,true);
  assert.equal(JSON.stringify(result).includes('Unicode QA'),false);
  assert.equal(JSON.stringify(result).includes('before'),false);
});

test('no explicit HWND, PID, native ID or clear means no cross-window fallback',()=>{
  for(const change of [
    {id:undefined},{window_id:undefined},{pid:undefined},
    {window_title:undefined},{clear:false},{method:'keys'},
    {press_enter:true},{role:'Pane'},
  ]){
    assert.equal(eligibleWinFormsTextTarget({...scope,...change}),false,
      JSON.stringify(change));
  }
});

test('background, forged or ambiguous native snapshots fail before the mutation',async()=>{
  const snapshots=[
    [{...root,active:false},edit],
    [root,{...edit,password:true}],
    [root,{...edit,value:null}],
    [root,{...edit,role:'Pane'}],
    [root,{...edit,className:'WindowsForms10.PASSWORD.app.0'}],
    [root,{...edit,name:'Account token'}],
    [root,{...edit,enabled:false}],
    [root,{...edit,focusable:false}],
    [root,{...edit,patterns:[]}],
    [root,{...edit,pid:3817}],
    [root,{...edit,id:'win:42.999'}],
    [root,edit,{...edit}],
    [{...root,window_id:'0x1D01D5'},edit],
  ];
  for(const nodes of snapshots){
    await assert.rejects(()=>simulate(scope,nodes),
      /not uniquely foreground verified|not verified ordinary editable/);
  }
});

test('only positive independent OS readback counts as a write',async()=>{
  for(const outcome of [
    {backend:'ValuePattern',foreground_after:true,value_matches_after:true},
    {backend:'Win32WMSetText',foreground_after:false,value_matches_after:true},
    {backend:'Win32WMSetText',foreground_after:true,value_matches_after:false},
    {backend:'Win32WMSetText',foreground_after:true},
    null,
  ]){
    await assert.rejects(()=>simulate(scope,[root,edit],outcome),
      /verified OS readback/);
  }
});

test('type payload and reported name must be bounded, single-line and non-sensitive',async()=>{
  for(const text of ['','A'.repeat(257),'a\nb','token\u202eoverride']){
    await assert.rejects(()=>simulate({...scope,text}),
      /bounded ordinary single-line/);
  }
  await assert.rejects(()=>simulate({...scope,name:'forged'}),/not verified ordinary/);
  await assert.rejects(()=>simulate(scope,[root,{...edit,name:'Password'}]),
    /not verified ordinary/);
});
