import test from 'node:test';
import assert from 'node:assert/strict';
import {uiAction} from '../src/extended/desktop-windows.mjs';
import {strictWindowsActionGate} from '../src/extended/desktop-windows-action-guard.mjs';

const input={
  action:'set_value',id:'win:7.1268.61490222',pid:1268,
  app:'powershell',window_title:"ReMCP QA O'Connor",window_id:'0x100240',
  name:'Search',role:'Edit',strict_target_id:true,
  expected_value:'qa-initial',value:'qa-updated',
};

async function script(args=input){
  let generated;
  await uiAction(args,{runPowerShellFn:async p=>{
    generated=p;return {stdout:'{}'};
  }});
  assert.ok(generated);
  return generated;
}

test('strict Windows UIA requires native ID, explicit PID and semantic identity',async()=>{
  for(const patch of [
    {id:''},{id:'win:malformed'},{id:'linux:1268:r.2'},
    {pid:0},{pid:undefined},{name:''},{role:''},
    {window_id:''},{window_id:'win:123'},{window_id:'0x0'},
    {window_id:'0xFFFFFFFFFFFFFFFF'},{window_id:'0xBADG'},
    {name:'Hidden\u202eValue'},{role:'Edit\nCustom'},
    {window_title:'bad\nname'},
  ]){
    await assert.rejects(()=>uiAction({...input,...patch},{
      runPowerShellFn:async()=>assert.fail('OS should not be called'),
    }),/Strict Windows GUI action/);
  }
  assert.equal(strictWindowsActionGate({action:'set_value'}),'');
});

test('strict Windows root selects the exact HWND, never first MainWindowHandle',async()=>{
  const source=await script();
  const handle=source.indexOf('$h=[IntPtr]::new(1049152)');
  const owner=source.indexOf('$selectedPid=[uint32]0');
  const root=source.indexOf('$root=[System.Windows.Automation.AutomationElement]::FromHandle($h)');
  const access=source.indexOf('$q=New-Object System.Collections.Queue');
  assert.ok(handle>0&&owner>handle&&root>owner&&access>root);
  assert.match(source,/Native guided action refused: HWND not found/);
  assert.match(source,/Native guided action refused: HWND owner changed/);
  assert.match(source,/\[RMFG\]::GetWindowText\(\$h,\$windowCaption,\$windowCaption.Capacity\)/);
  assert.match(source,/\$windowName=if\(\$true\)\{\$nativeWindowName\}/);
  assert.doesNotMatch(source,/MainWindowHandle/);
});

test('strict HWND selection also applies to focused native dialog, without title lookup',async()=>{
  const source=await script({...input,action:'focus',window_title:undefined});
  assert.match(source,/\$h=\[IntPtr\]::new\(1049152\)/);
  assert.doesNotMatch(source,/Get-Process\|Where-Object\{\$_.MainWindowHandle/);
  assert.match(source,/\[RMFG\]::GetWindowThreadProcessId\(\$h,\[ref\]\$selectedPid\)/);
});

test('strict root PID and exact window title are validated before traversing AX tree',async()=>{
  const source=await script();
  const hwnd=source.indexOf('if($h.ToInt64() -ne 1049152)');
  const owner=source.indexOf("if($osPid -ne 1268)");
  const root=source.indexOf("if($rootPid -ne 1268)");
  const title=source.indexOf("$windowName -cne 'ReMCP QA O''Connor'");
  const traverse=source.indexOf('$q=New-Object System.Collections.Queue');
  assert.ok(hwnd>0&&owner>hwnd&&root>owner&&title>root&&traverse>title);
  assert.match(source,/\[RMFG\]::IsWindow\(\$h\)/);
  assert.match(source,/GetWindowThreadProcessId\(\$h,\[ref\]\$osPid\)/);
  assert.match(source,/Native guided action refused: HWND changed/);
  assert.match(source,/Native guided action refused: HWND owner changed/);
  assert.match(source,/Native guided action refused: root process changed/);
  assert.match(source,/Native guided action refused: root window title changed/);
  assert.match(source,/if\(\$found.Current.ProcessId -ne \$rootPid\)/);
});

test('strict action verifies foreground again immediately before native SetValue',async()=>{
  const source=await script();
  const first=source.indexOf("if($h -ne [RMFG]::GetForegroundWindow())");
  const compare=source.indexOf('Native text value changed before write');
  const second=source.indexOf('Native guided action refused: target window became background');
  const mutation=source.indexOf(".SetValue('qa-updated')");
  assert.ok(first>0&&compare>first&&second>compare&&mutation>second);
  assert.match(source,/if\(\$found.Current.IsPassword\)/);
  assert.match(source,/if\(\(\[System.Windows.Automation.ValuePattern\]\$p\).Current.IsReadOnly\)/);
  assert.match(source,/Native text mutation refused for protected control/);
});

test('strict guard permits absent title only with verified PID, not fuzzy title equality',async()=>{
  const source=await script({...input,window_title:undefined});
  assert.match(source,/if\('' -ne '' -and \$windowName -cne ''\)/);
  assert.match(source,/if\(\$rootPid -ne 1268\)/);
});

test('legacy unscoped actions preserve their existing contract',async()=>{
  const source=await script({action:'focus',name:'Search',role:'Edit'});
  assert.doesNotMatch(source,/Native guided action refused: root process changed/);
  assert.match(source,/if\(\$false -and \$h -ne \[RMFG\]::GetForegroundWindow\(\)\)/);
});

test('strict Windows UIA PowerShell parses in signed-in Windows PowerShell 5.1', {
  skip:process.platform!=='win32',timeout:30000,
},async()=>{
  const {spawnSync}=await import('node:child_process');
  const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const dir=mkdtempSync(join(tmpdir(),'remcp-strict-winuia-'));
  try{
    const source=await script();
    const file=join(dir,'strict-uia.ps1');
    writeFileSync(file,source,'utf8');
    const quoted=file.replace(/'/g,"''");
    const program="$ErrorActionPreference='Stop';$s=[IO.File]::ReadAllText('"+
      quoted+"',[Text.Encoding]::UTF8);$t=$null;$e=$null;[void][Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e);if($e.Count){throw ($e|Out-String)};'STRICT_UIA_PARSE_OK'";
    const result=spawnSync('powershell.exe',
      ['-NoProfile','-NonInteractive','-Command',program],
      {encoding:'utf8',timeout:25000,windowsHide:true});
    assert.equal(result.error,undefined);
    assert.equal(result.status,0,result.stderr||result.stdout);
    assert.match(result.stdout,/STRICT_UIA_PARSE_OK/);
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test('window ID survives the native app inspection summary',async()=>{
  const {summarizeAppWindow}=await import('../src/extended/app-workflow-inspect-core.mjs');
  const root={id:'win:7.42.1',parent_id:null,depth:0,
    pid:42,app:'notepad',window:'QA Notepad',role:'Window',
    name:'QA Notepad',active:true,width:450,height:230,
    window_id:'0xB009A'};
  const result=summarizeAppWindow({nodes:[root]},['notepad']);
  assert.equal(result.matched,true);
  assert.equal(result.foreground_verified,true);
  assert.equal(result.window_id,'0xB009A');
  assert.equal(result.pid,42);
  const hwndSelection=summarizeAppWindow({nodes:[root]},['notepad'],
    {window_id:'0xB009A'});
  assert.equal(hwndSelection.matched,true);
  assert.equal(hwndSelection.window_id,'0xB009A');
  const stale=summarizeAppWindow({nodes:[root]},['notepad'],
    {window_id:'0xB009B'});
  assert.equal(stale.matched,false);
  assert.equal(stale.reason,'requested_window_not_found');
});
