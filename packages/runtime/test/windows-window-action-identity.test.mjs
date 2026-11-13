import test from 'node:test';
import assert from 'node:assert/strict';
import { windowAction } from '../src/extended/desktop-windows.mjs';
import { windowsWindowSelector } from '../src/extended/desktop-windows-window-selector.mjs';
import { WINDOWS_INTEROP } from '../src/native/windows/manifest.mjs';

async function program(args) {
  let script;
  await windowAction(args,{runPowerShellFn:async code=>{
    script=code;return {stdout:''};
  }});
  assert.ok(script);
  return script;
}

test('native HWND window commands verify owner before any close or movement',async()=>{
  const script=await program({
    action:'close',id:'0x000F0234',pid:6124,
    app:'powershell',title:'ReMCP QA Secondary',
  });
  const selected=script.indexOf('$h=[IntPtr]::new(983604)');
  const owner=script.indexOf('GetWindowThreadProcessId($h,[ref]$nativePid)');
  const pid=script.indexOf('if($nativePid -ne 6124)');
  const title=script.indexOf('Native window action title does not exist');
  const close=script.indexOf('PostMessage($h,0x0010');
  assert.ok(selected>0 && owner>selected && pid>owner && close>pid);
  assert.match(script,/HWND owner changed/);
  assert.match(script,/Windows window action refused: title changed/);
  assert.match(script,/Windows window action refused: application changed/);
  assert.match(script,/\[RMFG\]::IsWindow\(\$h\)/);
  assert.match(script,WINDOWS_INTEROP['window-action'].file.endsWith('.cs')?
    /REMCP_WINDOWS_SOURCE_BLOCKED/:/REMCP_WINDOWS_PAYLOAD_BLOCKED/);
  assert.doesNotMatch(script,/Add-Type @'/);
  assert.equal(title,-1);
});

test('native HWND parser rejects invalid IDs, PIDs and tainted selectors before execution',async()=>{
  for (const changes of [
    {id:'0xNO'}, {id:'0x0'}, {id:'0xFFFFFFFFFFFFFFFF'},
    {id:'0x123nothex'}, {pid:0}, {pid:-1}, {pid:1.5},
    {pid:'not-a-number'}, {title:'bad\nname'}, {app:'bad\u202efoo'},
  ]) {
    const args={action:'close',id:'0x10024',pid:6124,...changes};
    await assert.rejects(
      ()=>windowAction(args,{runPowerShellFn:async()=>assert.fail('OS must not run')}),
      /Windows window action refused/,
    );
  }
});

test('exact title and process filters are safely quoted and checked against the live HWND',()=>{
  const code=windowsWindowSelector({
    id:'0x2100',pid:111,app:"O'Connor",title:"ReMCP O'Connor",
  });
  assert.match(code,/GetWindowText\(\$h,\$nativeCaption,\$nativeCaption.Capacity\)/);
  assert.match(code,/IndexOf\('ReMCP O''Connor'/);
  assert.match(code,/IndexOf\('O''Connor'/);
  assert.match(code,/if\(\$nativePid -ne 111\)/);
  assert.doesNotMatch(code,/SetForegroundWindow|PostMessage|MoveWindow/);
});

test('id-only focus keeps legacy contract while rejecting nonexistent HWNDs',async()=>{
  const script=await program({action:'focus',id:'0x10024'});
  assert.match(script,/Windows window action refused: HWND is invalid/);
  assert.doesNotMatch(script,/\$nativePid -ne \d+/);
  assert.match(script,/\[RM\]::FocusWindow\(\$h\)/);
});

test('PID-scoped legacy MainWindowHandle lookup must also pass the native owner check',async()=>{
  const script=await program({action:'restore',pid:444,title:'QA'});
  assert.match(script,/MainWindowHandle/);
  assert.match(script,/\$nativePid -ne 444/);
});

test('direct native window adapter refuses Session 0 before HWND resolution',()=>{
  const code=windowsWindowSelector({id:'0x10024'});
  assert.ok(code.indexOf('SessionId -eq 0')>=0);
  assert.ok(code.indexOf('SessionId -eq 0')<code.indexOf('$h=[IntPtr]::new'));
  assert.match(code,/Environment\]::UserInteractive/);
});

test('native window mutations do not mask OS rejections as success',async()=>{
  const close=await program({action:'close',id:'0x120222',pid:7244});
  const move=await program({action:'move',id:'0x120222',pid:7244,x:40,y:60});
  const resize=await program({action:'resize',id:'0x120222',pid:7244,width:400,height:200});
  const combined=await program({action:'move_resize',id:'0x120222',pid:7244,x:40,y:60,width:400,height:200});
  assert.match(close,/if\(-not \[RM\]::PostMessage/);
  assert.match(move,/if\(-not \[RM\]::MoveWindow/);
  assert.match(resize,/if\(-not \[RM\]::MoveWindow/);
  assert.match(combined,/if\(-not \[RM\]::MoveWindow/);
  assert.match(close,/Windows refused window close message/);
  assert.match(move,/Windows refused window move/);
});
