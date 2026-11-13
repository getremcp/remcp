// Explicit isolated Windows UIA E2E. Not part of the ordinary npm test suite.
// Opens only its own WPF fixture; never touches an existing user app.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {uiSnapshot,uiAction} from '../src/extended/desktop-windows.mjs';

if(process.platform!=='win32')throw Error('This QA fixture requires a real Windows interactive session');
const title='ReMCP Windows UIA Verified QA';
const fieldName='ReMCP QA Exact Field';
const base=mkdtempSync(path.join(os.tmpdir(),'remcp-windows-uia-qa-'));
const fixture=String.raw`Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
$window=New-Object System.Windows.Window
$window.Title='ReMCP Windows UIA Verified QA'
$window.Width=475
$window.Height=260
$window.WindowStartupLocation='CenterScreen'
$panel=New-Object System.Windows.Controls.StackPanel
$panel.Margin=New-Object System.Windows.Thickness(18)
$label=New-Object System.Windows.Controls.TextBlock
$label.Text='ReMCP QA Exact Field'
$label.Margin=New-Object System.Windows.Thickness(0,0,0,12)
$field=New-Object System.Windows.Controls.TextBox
$field.Name='QAExactField'
$field.Text='before'
$field.Height=28
[System.Windows.Automation.AutomationProperties]::SetName($field,'ReMCP QA Exact Field')
$check=New-Object System.Windows.Controls.CheckBox
$check.Content='ReMCP QA Do Not Touch'
$check.Margin=New-Object System.Windows.Thickness(0,18,0,0)
[void]$panel.Children.Add($label)
[void]$panel.Children.Add($field)
[void]$panel.Children.Add($check)
$window.Content=$panel
$window.Add_ContentRendered({$window.Activate();$field.Focus()})
[void]$window.ShowDialog()`;
const script=path.join(base,'fixture.ps1');
writeFileSync(script,fixture,{mode:0o600});
const child=spawn('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',script],{
  stdio:['ignore','ignore','pipe'],windowsHide:false,
});
let stderr='';
child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-900)});
const pid=child.pid;
assert.ok(Number.isSafeInteger(pid)&&pid>0);
try{
  let field=null,root=null,seen=null,lastObserved='no snapshot';
  for(let attempt=0;attempt<18;attempt++){
    if(child.exitCode!==null)throw Error('Isolated QA window exited unexpectedly');
    try{
      const tree=(await uiSnapshot({pid,window_title:title,max_nodes:90,max_depth:8})).structuredContent;
      const nodes=tree?.nodes||[];
      const matches=nodes.filter(n=>n.pid===pid&&n.name===fieldName&&n.role==='Edit');
      const roots=nodes.filter(n=>n.pid===pid&&n.name===title&&
        n.role==='Window'&&typeof n.window_id==='string'&&n.window_id.startsWith('0x'));
      lastObserved=JSON.stringify({pid,root_count:roots.length,
        active:roots[0]?.active,field_count:matches.length,
        fixture_roles:nodes.filter(n=>n.pid===pid).slice(0,10)
          .map(n=>[n.role,n.name===title?'qa_root':
            n.name===fieldName?'qa_field':n.name==='ReMCP QA Do Not Touch'?'qa_checkbox':'other'])});
      if(matches.length===1&&roots.length===1&&roots[0].active===true){
        field=matches[0];root=roots[0];seen=nodes;break;
      }
    }catch(error){lastObserved=String(error.message||error).slice(0,200);}
    await sleep(250);
  }
  assert.ok(field&&root,'one exact, active WPF QA target must be accessible: '+lastObserved);
  assert.equal(field.value,'before');
  assert.match(field.id,/^win:-?\d+(?:\.-?\d+)*$/);
  console.log('WIN_UIA_EXACT_ACTIVE_FIXTURE_FOUND');
  const target={action:'set_value',id:field.id,pid,window_title:title,
    window_id:root.window_id,name:fieldName,role:'Edit',strict_target_id:true};
  const read=async()=>{
    const tree=(await uiSnapshot({pid,window_title:title,max_nodes:90,max_depth:8})).structuredContent;
    const exact=(tree.nodes||[]).filter(n=>n.pid===pid&&n.id===field.id&&
      n.name===fieldName&&n.role==='Edit');
    assert.equal(exact.length,1,'QA element disappeared or its identity changed');
    return exact[0].value;
  };
  // Do the positive write first, while the fixture has just been observed
  // foreground. Never force-focus another app if the desktop switches.
  let outcome;
  try{
    outcome=(await uiAction({...target,expected_value:'before',value:'after'})).structuredContent;
  }catch(error){
    if(/target window (?:is|became) background/i.test(String(error))){
      assert.equal(await read(),'before',
        'background refusal must not change the QA fixture');
      console.log('WIN_UIA_BACKGROUND_WRITE_REFUSED');
      throw Error('QA fixture lost foreground; positive native write not verified');
    }
    throw error;
  }
  assert.equal(outcome.foreground_after,true);
  assert.equal(outcome.value_matches_after,true);
  assert.equal(Object.hasOwn(outcome,'value_after'),false);
  assert.equal(await read(),'after');
  console.log('WIN_UIA_NATIVE_TEXT_READBACK_OK');
  await assert.rejects(uiAction({...target,expected_value:'before',value:'unexpected'}),
    /Native text value changed before write/);
  assert.equal(await read(),'after');
  console.log('WIN_UIA_STALE_CAS_BLOCKED');
  await assert.rejects(uiAction({...target,id:'win:999999.9',expected_value:'after',value:'unexpected'}),
    /UI element not found/);
  assert.equal(await read(),'after');
  console.log('WIN_UIA_WRONG_ID_BLOCKED');
  console.log('WIN_UIA_REPLAY_CAS_BLOCKED');
  assert.ok(seen.some(n=>n.name==='ReMCP QA Do Not Touch'&&/check/i.test(n.role)));
  console.log('WIN_UIA_UNRELATED_CONTROL_UNCHANGED');
  console.log('WIN_UIA_NATIVE_E2E_OK');
}finally{
  if(child.exitCode===null){
    child.kill();
    await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(1500)]);
  }
  rmSync(base,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
