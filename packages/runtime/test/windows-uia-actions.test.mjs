import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uiAction } from '../src/extended/desktop-windows.mjs';
import { windowsUiRootScript } from '../src/extended/desktop-windows-msaa.mjs';
import { WINDOWS_INTEROP } from '../src/native/windows/manifest.mjs';

const cases = [
  { action:'invoke', name:'QA button' },
  { action:'focus', name:'QA text' },
  { action:'set_value', name:'QA text', value:"Привет 'Windows'" },
  { action:'set_value', name:'QA text', value:'Infinity' },
  { action:'set_range_value', name:'QA slider', value:47.5 },
];

async function scripts() {
  const captured = [];
  for (const args of cases) {
    await uiAction(args, { runPowerShellFn:async script => {
      captured.push(script);
      return { stdout:'{}' };
    } });
  }
  return captured;
}

test('non-range UI actions never embed non-finite numbers in their PowerShell program', async () => {
  const generated = await scripts();
  for (let i = 0; i < cases.length; i += 1) {
    assert.doesNotMatch(generated[i], /\[double\](?:NaN|-?Infinity)/, cases[i].action);
  }
  assert.match(generated.at(-1), /SetValue\(\[double\]47\.5\)/);
});

test('invalid range values fail before launching PowerShell', async () => {
  for (const value of [undefined, 'not a number', NaN, Infinity, -Infinity]) {
    await assert.rejects(() => uiAction({ action:'set_range_value', name:'QA', value }, {
      runPowerShellFn:async () => assert.fail('must not launch PowerShell'),
    }), /finite numeric value/);
  }
});

test('scoped UIA actions reject background windows before any SetFocus/ValuePattern/Invoke',async()=>{
  for(const action of ['focus','set_value','invoke']){
    let program='';
    await uiAction({
      action,id:'win:42.1.2',pid:42,app:'Notepad',name:'Search',
      window_id:'0x240',role:action==='invoke'?'Button':'Edit',strict_target_id:true,
      ...(action==='set_value'?{value:'confidential search'}:{})
    },{
      runPowerShellFn:async script=>{program=script;return {stdout:'{}'};},
    });
    const guard=program.indexOf("if($h -ne [RMFG]::GetForegroundWindow())");
    const dispatch=program.indexOf("switch('"+action+"')");
    assert.ok(guard>0 && dispatch>guard,'guarded '+action+' must check real HWND before mutation');
    assert.match(program,/Native guided action refused: target window is background/);
    assert.match(program,/Exact UI element identity changed before action/);
    assert.match(program,/GetForegroundWindow\(\)/);
  }
});

test('UIA snapshot no longer marks every scoped background window as active',()=>{
  const source=readFileSync(new URL('../src/extended/desktop-windows.mjs',import.meta.url),'utf8');
  assert.match(source,/\$windowForeground=\(\$h -eq \[RMFG\]::GetForegroundWindow\(\)\)/);
  assert.match(source,/active=\(\$d -eq 0 -and \$windowForeground\)/);
  assert.doesNotMatch(source,/active=\(\$d -eq 0\);/);
});

test('direct Windows UIA root refuses Session 0 before selecting a window',()=>{
  const variants=[
    windowsUiRootScript({}),
    windowsUiRootScript({pid:42,app:'Notepad',window_title:'QA'}),
  ];
  for(const program of variants){
    assert.match(program,/GetCurrentProcess\(\)\.SessionId -eq 0/);
    assert.match(program,/windows_session_0/);
    assert.match(program,/sign in and run the ReMCP user agent/);
    const guard=program.indexOf('if([System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0)');
    const selector=program.indexOf('$h=[IntPtr]::Zero');
    assert.ok(guard>=0&&selector>guard,
      'guard before foreground/window selection prevents accessing Session 0 desktop');
    assert.doesNotMatch(program,/^\s*\/\/\s/m,
      'generated PowerShell must use #, not JavaScript-style comments');
    assert.doesNotMatch(program,/Start-Process|SetFocus\(|Invoke\(|SetValue\(/);
  }
});

test('all generated UI action programs parse in Windows PowerShell 5.1', {
  skip:process.platform !== 'win32', timeout:30000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'remcp-uia-parser-'));
  t.after(() => rmSync(directory, { recursive:true, force:true }));
  const payload = join(directory, 'scripts.json');
  writeFileSync(payload, JSON.stringify(await scripts()), 'utf8');
  const escapedPath = payload.replace(/'/g, "''");
  const program = `$ErrorActionPreference='Stop';$scripts=[IO.File]::ReadAllText('${escapedPath}',[Text.Encoding]::UTF8)|ConvertFrom-Json;foreach($s in $scripts){$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseInput($s,[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors|Out-String)}};'UIA_PARSE_OK '+$scripts.Count`;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', program,
  ], { encoding:'utf8', timeout:25000, windowsHide:true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /UIA_PARSE_OK 5/);
});

test('Windows ValuePattern compare-and-swap checks exact old value before SetValue',async()=>{
  let script='';
  await uiAction({action:'set_value',id:'win:42.1.2',pid:42,
    app:'Notepad',name:'Search',role:'Edit',window_id:'0x240',strict_target_id:true,
    expected_value:"O'Connor",value:'new value'},{
    runPowerShellFn:async generated=>{
      script=generated;return {stdout:'{}'};
    },
  });
  const guard=script.indexOf("if(([System.Windows.Automation.ValuePattern]$p).Current.Value -cne");
  const mutate=script.indexOf(".SetValue('new value')");
  assert.ok(guard>0&&mutate>guard);
  assert.match(script,/O''Connor/);
  assert.match(script,/Native text value changed before write/);
});
test('strict Windows UIA readback attests foreground, focus and exact value without returning text',async()=>{
 let valueProgram='',focusProgram='';
 const base={id:'win:42.1.2',pid:42,app:'qa',name:'QA Exact Search',
   role:'Edit',window_id:'0x240',strict_target_id:true};
 await uiAction({...base,action:'set_value',value:"private O'Connor"},{
   runPowerShellFn:async script=>{
     valueProgram=script;return {stdout:JSON.stringify({action:'set_value',
       foreground_after:true,value_matches_after:true,focused_after:null})};
   },
 });
 await uiAction({...base,action:'focus'},{
   runPowerShellFn:async script=>{
     focusProgram=script;return {stdout:JSON.stringify({action:'focus',
       foreground_after:true,value_matches_after:null,focused_after:true})};
   },
 });
 const write=valueProgram.indexOf(".SetValue('private O''Connor')");
 const readback=valueProgram.lastIndexOf('GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)');
 assert.ok(write>0&&readback>write,'value must be read back after the setter');
 assert.match(valueProgram,/\$foregroundAfter=\(\$h -eq \[RMFG\]::GetForegroundWindow\(\)\)/);
 assert.match(valueProgram,/\$valueMatchesAfter=\(\[System.Windows.Automation.ValuePattern\]\$fresh\)\.Current\.Value -ceq 'private O''Connor'/);
 assert.match(valueProgram,/foreground_after=\$foregroundAfter/);
 assert.match(valueProgram,/value_matches_after=\$valueMatchesAfter/);
 assert.match(valueProgram,/focused_after=\$focusedAfter/);
 assert.doesNotMatch(valueProgram,/value_after=|readback_value=|text_after=/);
 assert.match(focusProgram,/\$focusedAfter=\[bool\]\$found\.Current\.HasKeyboardFocus/);
 assert.match(focusProgram,/focused_after=\$focusedAfter/);
});

test('strict click never downgrades to pointer input when InvokePattern is absent',async()=>{
  const args={action:'click',id:'win:42.1.2',pid:42,
    app:'QA',name:'Safe QA Button',role:'Button',
    window_id:'0x240',strict_target_id:true};
  let strict='';
  await uiAction(args,{runPowerShellFn:async program=>{
    strict=program;return {stdout:'{}'};
  }});
  const click=strict.slice(strict.indexOf(" 'click'{"),strict.indexOf(" 'set_value'{"));
  assert.match(click,/InvokePattern/);
  assert.match(click,/Strict Windows UIA click requires InvokePattern/);
  assert.doesNotMatch(click,/mouse_event|SetCursorPos|GetClickablePoint|BoundingRectangle/);
  assert.doesNotMatch(strict,/RMMouse/);
  assert.doesNotMatch(strict,/ui-mouse\.dll/,
    'strict UIA action must not install or load the coordinate-mouse helper');
  let legacy='';
  await uiAction({...args,strict_target_id:false},{
    runPowerShellFn:async program=>{legacy=program;return {stdout:'{}'};}
  });
  const legacyClick=legacy.slice(legacy.indexOf(" 'click'{"),legacy.indexOf(" 'set_value'{"));
  assert.match(legacyClick,/mouse_event/);
  const helper=WINDOWS_INTEROP['ui-mouse'].file;
  assert.match(legacy,helper.endsWith('.cs')?/ui-mouse\.cs/:/ui-mouse\.dll/,
    'legacy pointer fallback must load its integrity-checked helper');
});

test('strict Windows text mutation rejects sensitive semantic labels before dispatch',async()=>{
 for(const name of ['Password','Account OTP','Recovery code','API key','Secret token','PIN']){
  let dispatched=0;
  await assert.rejects(()=>uiAction({
    action:'set_value',id:'win:42.1.2',pid:42,
    app:'QA',name,role:'Edit',window_id:'0x240',
    strict_target_id:true,value:'secret',
  },{runPowerShellFn:async()=>{dispatched++;return {stdout:'{}'};}}),
  /Strict Windows GUI action refuses sensitive text field/);
  assert.equal(dispatched,0,'the OS must not receive a sensitive write');
 }
 let seen=0;
 await uiAction({action:'set_value',id:'win:42.1.2',pid:42,
   app:'QA',name:'Search in mail',role:'Edit',window_id:'0x240',
   strict_target_id:true,value:'safe text'},{
   runPowerShellFn:async()=>{seen++;return {stdout:'{}'};},
 });
 assert.equal(seen,1);
});

test('unscoped Windows value action never silently adds an expected-value guard',async()=>{
  let script='';
  await uiAction({action:'set_value',id:'win:42.1.2',name:'Search',
    role:'Edit',expected_value:'old',value:'new'},{
    runPowerShellFn:async generated=>{script=generated;return {stdout:'{}'};},
  });
  assert.doesNotMatch(script,/Native text value changed before write/);
});
