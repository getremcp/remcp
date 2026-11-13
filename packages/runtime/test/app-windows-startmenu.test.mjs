import test from 'node:test';
import assert from 'node:assert/strict';
import {jsonResult} from '../src/extended/common.mjs';
import {windowsStartMenuScript,parseWindowsShortcutInventory,
  windowsGuiInventory,windowsShortcutPidVerified}
  from '../src/extended/app-windows-startmenu.mjs';
import {detectedAppRows,detectedApps,inspectDetectedApp}
  from '../src/extended/app-dynamic-discovery.mjs';
import {resultValue} from '../src/extended/desktop-core.mjs';

const original={name:'Widget Deluxe',
  shortcut_id:'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Widget Deluxe.lnk',
  target_path:"C:\\Program Files\\Widget\\Widget.EXE",
  source:'windows_startmenu_shortcut'};

test('generated PowerShell enumerates only Start Menu shortcuts without executing them',()=>{
  const script=windowsStartMenuScript();
  assert.match(script,/GetFolderPath\('Programs'\)/);
  assert.match(script,/GetFolderPath\('CommonPrograms'\)/);
  assert.match(script,/CreateShortcut/);
  assert.match(script,/ReparsePoint/);
  assert.match(script,/\.lnk/);
  assert.match(script,/\.TargetPath/);
  assert.match(script,/Get-ChildItem -LiteralPath/);
  assert.match(script,/scanned -lt 800/);
  assert.doesNotMatch(script,/\.Save\s*\(|Start-Process|Invoke-Item|Invoke-Expression|\.Run\s*\(/i);
});
test('shortcut inventory accepts only local .lnk files with direct local exe targets',()=>{
  const rows=[
    original,{...original,shortcut_id:original.shortcut_id.toLowerCase()},
    {...original,name:'Network shortcut',shortcut_id:'\\\\server\\link.lnk'},
    {...original,name:'Web shortcut',target_path:'https://malicious.invalid/launch'},
    {...original,name:'Command script',target_path:'C:\\Windows\\System32\\cmd.bat'},
    {...original,name:'Relative path',target_path:'..\\Widget.exe'},
    {...original,name:'Parent escape',target_path:'C:\\Temp\\..\\Widget.exe'},
    {...original,name:'Bidi',name:'Hidden\u202eExecutable'},
    {...original,name:'Other',shortcut_id:'C:\\Temp\\foo.url'},
  ];
  const r=parseWindowsShortcutInventory({data:rows,scanned:13,truncated:false});
  assert.equal(r.backend,'windows_startmenu_shortcuts');
  assert.equal(r.data.length,1);
  assert.equal(r.data[0].process_hint,'Widget');
  assert.equal(r.inspected_files,13);
  assert.equal(JSON.stringify(detectedAppRows(r.data,{
    backend:r.backend})).includes('Program Files'),false);
});
test('read-only GUI source returns typed backend without invoking shortcuts',async()=>{
  let scanned=0;
  const r=resultValue(await windowsGuiInventory({
    runPowerShellFn:async script=>{
      scanned++;assert.match(script,/CreateShortcut/);
      return {stdout:JSON.stringify({data:[original],scanned:1,truncated:false})};
    },
  }));
  assert.equal(scanned,1);
  assert.equal(r.count,1);
  assert.equal(r.data[0].name,'Widget Deluxe');
  assert.equal(r.backend,'windows_startmenu_shortcuts');
});
test('Windows GUI catalog assigns one opaque ID to one Start Menu shortcut',async()=>{
  const get=async()=>jsonResult({backend:'windows_startmenu_shortcuts',
    data:[original],count:1,returned:1});
  const detected=await detectedApps({filter:'widget'},{platform:'win32',guiApps:get});
  assert.equal(detected.total,1);
  assert.equal(detected.apps[0].source,'windows_startmenu_shortcut');
  assert.equal(detected.apps[0].installation,'start_menu_shortcut');
  assert.equal(detected.apps[0].destinations.length,0);
  assert.match(detected.apps[0].id,/^local-[0-9a-f]{20}$/);
  assert.doesNotMatch(JSON.stringify(detected.apps),/C:\\\\|Program Files/);
});
test('Windows PID process verification requires precise target executable',async()=>{
  let calls=0;
  const r=await windowsShortcutPidVerified("C:\\O'Connor\\Widget.exe",123,{
    runPowerShellFn:async(script)=>{
      calls++;assert.match(script,/Get-Process -Id 123 -ErrorAction Stop/);
      assert.match(script,/O''Connor/);
      assert.match(script,/StringComparison\]::OrdinalIgnoreCase/);
      assert.match(script,/OpenProcess\(4096,\$false,123\)/);
      assert.match(script,/try\{\$actual=\[string\]\$process\.Path\}catch/);
      assert.match(script,/QueryFullProcessImageName/);
      assert.match(script,/CloseHandle\(\$h\)/);
      assert.doesNotMatch(script,/SeDebugPrivilege|PROCESS_VM_READ/);
      return {stdout:'{"verified":true}'};
    },
  });
  assert.equal(r,true);
  assert.equal(calls,1);
  assert.equal(await windowsShortcutPidVerified('\\\\server\\bad.exe',123,
    {runPowerShellFn:async()=>{throw Error('must not call')}}),false);
  assert.equal(await windowsShortcutPidVerified(original.target_path,0,
    {runPowerShellFn:async()=>{throw Error('must not call')}}),false);
  assert.equal(await windowsShortcutPidVerified(original.target_path,123,
    {runPowerShellFn:async()=>({stdout:'{"verified":false}'})}),false);
});
test('Windows generic GUI never reads UIA until the selected PID matches shortcut executable',async()=>{
  const parsed=parseWindowsShortcutInventory({data:[original]});
  const get=async()=>jsonResult(parsed);
  const app=detectedAppRows(parsed.data,{backend:parsed.backend}).apps[0].id;
  let checks=0,reads=0;
  const adapters={platform:'win32',guiApps:get,
    assertWindowsInteractiveDesktop:async()=>{},
    listWindows:async()=>jsonResult([{id:'0x123',pid:501,
      app:'Widget',title:'Widget window',active:true}]),
    windowsShortcutPidVerified:async(target,pid)=>{
      checks++;assert.equal(pid,501);
      assert.equal(target,original.target_path);return false;
    },
    uiSnapshot:async()=>{reads++;throw Error('must not inspect incorrect process')},
  };
  const refused=await inspectDetectedApp({app,intent:'inspect'},adapters);
  assert.equal(refused.status,'blocked');
  assert.equal(refused.reason,'windows_shortcut_process_identity_unverified');
  assert.equal(checks,1);assert.equal(reads,0);
  const good=await inspectDetectedApp({app,intent:'inspect'},{
    ...adapters,windowsShortcutPidVerified:async()=>true,
    uiSnapshot:async()=>jsonResult({nodes:[{
      id:'win:501:0',pid:501,app:'Widget',window:'Widget window',
      role:'Window',name:'Widget window',
    }]}),
  });
  assert.equal(good.status,'inspected');
  assert.equal(good.verified,true);
});
test('Windows duplicate shortcut names refuse ambiguous UI even when IDs differ',async()=>{
  const second={...original,shortcut_id:'C:\\Users\\Me\\Start Menu\\Programs\\Widget Deluxe.lnk'};
  const rows=[original,second];
  const list=detectedAppRows(rows,{backend:'windows_startmenu_shortcuts'});
  assert.equal(list.apps.length,2);
  assert.notEqual(list.apps[0].id,list.apps[1].id);
  let calls=0;
  const refused=await inspectDetectedApp({app:list.apps[0].id,intent:'inspect'},{
    platform:'win32',guiApps:async()=>jsonResult({backend:'windows_startmenu_shortcuts',
      data:rows,count:2,returned:2}),
    assertWindowsInteractiveDesktop:async()=>{},
    listWindows:async()=>{calls++;throw Error('must not enumerate')},
  });
  assert.equal(refused.status,'blocked');
  assert.equal(refused.reason,'ambiguous_windows_shortcut_display_name');
  assert.equal(calls,0);
});
test('Windows registry packages cannot authorize generic GUI without executable provenance',async()=>{
  const registry=[{name:'Widget',path:'C:\\Apps\\Widget'}];
  const app=detectedAppRows(registry).apps[0].id;
  let calls=0;
  const refused=await inspectDetectedApp({app,intent:'inspect'},{
    platform:'win32',installedApps:async()=>jsonResult({backend:'windows-registry',
      data:registry,count:1,returned:1}),
    assertWindowsInteractiveDesktop:async()=>{},
    listWindows:async()=>{calls++;throw Error('must not open registry-only GUI')},
  });
  assert.equal(refused.status,'blocked');
  assert.equal(refused.reason,'windows_process_installation_provenance_unverified');
  assert.equal(calls,0);
});

test('Windows source fails closed with typed empty catalog when COM unavailable',async()=>{
  const found=await detectedApps({filter:'Widget'},{
    platform:'win32',guiApps:async()=>{throw Error('No COM or locked session')},
  });
  assert.equal(found.inventory_status,'unavailable');
  assert.equal(found.total,0);
  assert.deepEqual(found.apps,[]);
  assert.equal(found.backend,'windows_startmenu_shortcuts');
});
test('Windows shortcut parser rejects shell interpreter targets and excessive rows',()=>{
  const rows=[
    {...original,shortcut_id:'C:\\Start Menu\\cmd.lnk',
      target_path:'C:\\Windows\\System32\\cmd.exe'},
    {...original,shortcut_id:'C:\\Start Menu\\PowerShell.lnk',
      target_path:'C:\\Windows\\System32\\powershell.EXE'},
    ...Array.from({length:805},(_,i)=>({
      name:'App '+i,shortcut_id:'C:\\Start Menu\\App'+i+'.lnk',
      target_path:'C:\\Apps\\Widget.exe',
    })),
  ];
  const parsed=parseWindowsShortcutInventory({data:rows,scanned:900});
  assert.equal(parsed.inventory_truncated,true);
  assert.equal(parsed.data.length,798);
  assert.equal(parsed.data.some(x=>x.name==='cmd'||x.name==='PowerShell'),false);
  const script=windowsStartMenuScript();
  assert.match(script,/IsNullOrWhiteSpace\(\[string\]\$lnk.Arguments\)/);
  assert.match(script,/directories -lt 200/);
  assert.match(script,/Select-Object -First 501/);
  assert.match(script,/FileAttributes\]::Hidden/);
  assert.match(script,/cmd\|powershell\|pwsh/);
});
test('Windows shortcut identity is case-insensitive but tied to full link path',()=>{
  const a=detectedAppRows([original],{backend:'windows_startmenu_shortcuts'}).apps[0].id;
  const b=detectedAppRows([{...original,
    shortcut_id:original.shortcut_id.toUpperCase()}],
    {backend:'windows_startmenu_shortcuts'}).apps[0].id;
  assert.equal(a,b);
  const moved=detectedAppRows([{...original,
    shortcut_id:'C:\\Other\\Widget Deluxe.lnk'}],
    {backend:'windows_startmenu_shortcuts'}).apps[0].id;
  assert.notEqual(a,moved);
});

test('QueryFullProcessImageName fallback does not grant access after an OS denial',async()=>{
  let calls=0;
  const denied=await windowsShortcutPidVerified(original.target_path,567,{
    runPowerShellFn:async script=>{
      calls++;assert.match(script,/if\(\[string\]::IsNullOrEmpty\(\$actual\)\)/);
      assert.match(script,/Add-Type -TypeDefinition \$source/);
      assert.match(script,/finally\{\[void\]\[RemcpGuiProcessImage\]::CloseHandle\(\$h\)\}/);
      return {stdout:'{"verified":false}'};
    },
  });
  assert.equal(denied,false);
  assert.equal(calls,1);
});

test('native executable fallback uses read-only Win32 API and fails closed',async()=>{
  let calls=0;
  const result=await windowsShortcutPidVerified(original.target_path,5320,{
    runPowerShellFn:async script=>{
      calls++;
      assert.match(script,/if\(\[string\]::IsNullOrEmpty\(\$actual\)\)/);
      assert.match(script,/QueryFullProcessImageName/);
      assert.match(script,/OpenProcess\(4096,\$false/);
      assert.match(script,/CloseHandle\(\$h\)/);
      assert.match(script,/\$actual=\$buf\.ToString\(\)/);
      assert.match(script,/\[pscustomobject\]@\{verified=\$verified\}/);
      assert.doesNotMatch(script,/SeDebugPrivilege|Start-Process|Invoke-Expression/);
      return {stdout:'garbage'};
    },
  });
  assert.equal(result,false);
  assert.equal(calls,1);
  assert.equal(await windowsShortcutPidVerified(original.target_path,5320,{
    runPowerShellFn:async()=>{throw Error('Access denied')},
  }),false);
  assert.equal(await windowsShortcutPidVerified('\\\\server\\share\\app.exe',5320,{
    runPowerShellFn:async()=>{throw Error('must not execute')},
  }),false);
});
