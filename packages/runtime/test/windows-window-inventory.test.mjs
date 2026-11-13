import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const native=readFileSync(new URL('../src/native/windows/window-list.cs',import.meta.url),'utf8');
import {listWindows} from '../src/extended/desktop-windows-list.mjs';
import {WINDOWS_INTEROP} from '../src/native/windows/manifest.mjs';

const rows=[
 {id:'0xD0234',pid:7012,app:'powershell',title:'ReMCP HWND Primary QA',
  active:false,minimized:false,maximized:false,x:100,y:120,width:370,height:170},
 {id:'0xE022A',pid:7012,app:'powershell',title:'ReMCP HWND Secondary QA',
  active:false,minimized:false,maximized:false,x:520,y:180,width:430,height:220},
];
async function source(){
 let script;
 await listWindows({}, {runPowerShellFn:async s=>{
  script=s;return {stdout:'[]'};
 }});
 return script;
}

test('Win32 inventory enumerates multiple top-level HWNDs, not one process main window',async()=>{
 const script=await source();
 assert.match(native,/EnumWindows\(\(hwnd,param\)=>/);
 assert.match(native,/GetWindowThreadProcessId\(hwnd,out owner\)/);
 assert.match(native,/IsWindowVisible\(hwnd\)/);
 assert.match(native,/GetWindowRect\(hwnd,out bounds\)/);
 assert.match(native,/GetWindowText\(hwnd,title,title.Capacity\)/);
 assert.match(native,/GetForegroundWindow/);
 assert.match(script,/\[RemcpWindowInventory\]::Read\(\)/);
 assert.match(script,WINDOWS_INTEROP['window-list'].file.endsWith('.cs')?
  /REMCP_WINDOWS_SOURCE_BLOCKED/:/REMCP_WINDOWS_PAYLOAD_BLOCKED/);
 assert.doesNotMatch(script,/Add-Type @'/);
 assert.doesNotMatch(script,/\.MainWindowHandle|SetForegroundWindow|ShowWindow\(/);
 assert.doesNotMatch(native,/\.Path\b|ExecutablePath|GetCommandLine/);
 assert.doesNotMatch(script,/ExecutablePath|GetCommandLine/);
});

test('Win32 window inventory bounds enumerated HWNDs and refuses partial results',async()=>{
 const script=await source();
 assert.match(native,/visited>3000/);
 assert.match(native,/rows.Count>=500/);
 assert.match(native,/if\(overflow\|\|!complete\)throw/);
 assert.match(native,/new StringBuilder\(513\)/);
 assert.match(script,/SessionId -eq 0/);
 assert.match(script,/processes\[\[int\]\$_\.Id\]/);
});

test('multiple HWNDs from one PID are returned independently with exact IDs',async()=>{
 const result=await listWindows({include_monitor:false},{
  runPowerShellFn:async()=>({stdout:JSON.stringify(rows)}),
 });
 const data=result.structuredContent.data;
 assert.equal(Array.isArray(data),true);
 assert.equal(data.length,2);
 assert.deepEqual(data.map(x=>x.id),['0xD0234','0xE022A']);
 assert.deepEqual(data.map(x=>x.pid),[7012,7012]);
 assert.equal(data[0].title,'ReMCP HWND Primary QA');
 assert.equal(data[1].title,'ReMCP HWND Secondary QA');
});

test('empty or invalid Win32 window enumeration never fabricates windows',async()=>{
 const empty=await listWindows({},{
  runPowerShellFn:async()=>({stdout:''}),
 });
 assert.deepEqual(empty.structuredContent.data,[]);
 await assert.rejects(listWindows({},{
  runPowerShellFn:async()=>({stdout:'malformed'}),
 }));
 await assert.rejects(listWindows({},{
  runPowerShellFn:async()=>{throw Error('partial enumeration')},
 }),/partial enumeration/);
});

test('native EnumWindows source parses on Windows PowerShell 5.1', {
 skip:process.platform!=='win32',timeout:30000,
},async()=>{
 const {spawnSync}=await import('node:child_process');
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
 const {join}=await import('node:path');
 const {tmpdir}=await import('node:os');
 const dir=mkdtempSync(join(tmpdir(),'remcp-enumwindow-'));
 try{
  const file=join(dir,'enum-window.ps1');
  writeFileSync(file,await source(),'utf8');
  const quoted=file.replace(/'/g,"''");
  const command="$ErrorActionPreference='Stop';$s=[IO.File]::ReadAllText('"+
    quoted+"',[Text.Encoding]::UTF8);$t=$null;$e=$null;[void][Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e);if($e.Count){throw ($e|Out-String)};'ENUMWINDOWS_PARSE_OK'";
  const result=spawnSync('powershell.exe',
    ['-NoProfile','-NonInteractive','-Command',command],
    {encoding:'utf8',timeout:25000,windowsHide:true});
  assert.equal(result.error,undefined);
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stdout,/ENUMWINDOWS_PARSE_OK/);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
