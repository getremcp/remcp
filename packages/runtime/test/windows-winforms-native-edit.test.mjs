import test from 'node:test';
import assert from 'node:assert/strict';
import { uiAction, uiSnapshot } from '../src/extended/desktop-windows.mjs';
import { winFormsEditInterop } from '../src/extended/desktop-windows-winforms-edit.mjs';

const scoped = {
  id:'win:42.1769530',pid:6224,app:'powershell',
  window_title:'ReMCP WinForms Native Input QA 2026',
  window_id:'0x4EF00AA',name:'before',role:'Edit',
  strict_target_id:true,
};

async function captureAction(args){
  let program='';
  await uiAction(args,{runPowerShellFn:async source=>{
    program=source;
    return {stdout:JSON.stringify({action:args.action})};
  }});
  return program;
}

test('WinForms EDIT disclosure requires OS style, HWND/root and PID, never UIA Pane alone',async()=>{
  let source='';
  await uiSnapshot({window_title:'ReMCP WinForms Native Input QA 2026'},{
    runPowerShellFn:async program=>{
      source=program;
      return {stdout:JSON.stringify({nodes:[]})};
    },
  });
  assert.match(source,/RMWinFormsEdit]::IsOrdinary/);
  assert.match(source,/RMWinFormsEdit]::Read\(\[IntPtr\]::new\(\[int\]\$e\.Current\.NativeWindowHandle\)\)/);
  assert.match(source,/\$e\.Current\.IsPassword/);
  assert.match(source,/privateField=\(\$c\.IsPassword/);
  assert.match(source,/\$nativeWinForms -and -not \$verifiedPlainEdit/);
  assert.match(source,/role=\$\(if\(\$verifiedPlainEdit -and -not \$privateField\)\{'Edit'\}/);
  assert.match(source,/focusable=\(\$c\.IsKeyboardFocusable -or/);
  assert.match(source,/if\(\$verifiedPlainEdit -and -not \$privateField -and \$null -eq \$value\)/);
  assert.match(winFormsEditInterop, /GetWindowThreadProcessId/);
  assert.match(winFormsEditInterop, /GetAncestor\(edit,2\)!=root/);
  assert.match(winFormsEditInterop, /GetClassName\(edit,cls,cls.Capacity\)/);
  assert.match(winFormsEditInterop, /reportedClass.StartsWith\("WindowsForms10.EDIT."/);
  assert.match(winFormsEditInterop, /\(style&0x20\)==0/);
  assert.match(winFormsEditInterop, /\(style&0x08000000\)==0/);
  assert.match(winFormsEditInterop, /GetWindowLong\(edit,-16\)&0x800\)==0/);
});

test('strict WinForms write is old-value CAS, same-process and foreground only',async()=>{
  const script=await captureAction({...scoped,action:'set_value',
    expected_value:'before',value:'new QA text'});
  assert.match(script,/Native guided action refused: target window is background/);
  assert.match(script,/Exact UI element identity changed before action/);
  assert.match(script,/Native text mutation refused for unverified WinForms edit/);
  assert.match(script,/if\(-not \$nativePlainEdit\)\{throw 'ValuePattern unavailable'\}/);
  const oldCheck=script.indexOf("$oldNativeText -cne 'before'");
  const foreground=script.indexOf("target window became background");
  const mutation=script.indexOf('::Write($editHandle,$h,[uint32]$rootPid');
  assert.match(script,/'before','new QA text'\)/);
  assert.ok(oldCheck>0 && foreground>oldCheck && mutation>foreground);
  assert.match(script,/Win32WMSetText/);
  assert.match(script,/RMWinFormsEdit]::Read/);
  assert.match(script,/value_matches_after=\$valueMatchesAfter/);
  assert.doesNotMatch(script,/SendKeys|SetCursorPos|mouse_event|Clipboard/);
  assert.match(script,/name=\$\(if\(\$used -eq 'Win32WMSetText'\)\{''\}/);
});

test('unscoped edits never inherit the WinForms native fallback',async()=>{
  const script=await captureAction({action:'set_value',name:'Search',
    role:'Pane',value:'test'});
  assert.match(script,/\$nativePlainEdit=\$false/);
  assert.match(script,/if\(\$found\.Current\.ClassName -match/);
  assert.match(script,/Native text mutation refused for unverified WinForms edit/);
  assert.match(script,/ValuePattern unavailable/);
  const editOnly=script.slice(script.indexOf(" 'set_value'{"),script.indexOf(" 'select'{"));
  assert.doesNotMatch(editOnly,/RMMouse|SendKeys|Clipboard/);
});

test('native Unicode text write is bounded and read-back text never returns in action JSON',async()=>{
  assert.match(winFormsEditInterop, /value.Length>256/);
  assert.match(winFormsEditInterop, /MsgNumber\(edit,0x000E/);
  assert.match(winFormsEditInterop, /MsgGet\(edit,0x000D/);
  assert.match(winFormsEditInterop, /MsgSet\(edit,0x000C/);
  assert.match(winFormsEditInterop, /400,out result/);
  assert.match(winFormsEditInterop, /value.Length>256/);
  const script=await captureAction({...scoped,action:'set_value',
    expected_value:"O'Connor",value:'Защищённый тест 你好'});
  assert.match(script,/O''Connor/);
  assert.match(script,/::Write\(\$editHandle,\$h,\[uint32\]\$rootPid/);
  assert.match(script,/'O''Connor','Защищённый тест 你好'\)/);
  assert.match(winFormsEditInterop,/string.Equals\(Read\(edit\),expected,StringComparison.Ordinal\)/);
  assert.match(script,/valueMatchesAfter=/);
  assert.doesNotMatch(script,/value_after=|readback_value=|text_after=/);
});
