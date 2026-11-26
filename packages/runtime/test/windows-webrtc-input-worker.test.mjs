import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createWindowsWebRtcInput,windowsWebRtcInputScript} from '../src/extended/desktop-windows-webrtc-input.mjs';

const echoScript="const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const p=JSON.parse(line);console.log(JSON.stringify({seq:p.seq,ok:true}));})";
const move=seq=>({seq,kind:'pointer',op:'move',x:0.5,y:0.5});
test('reuses one private worker for ordered input, and closes it before another capture',async()=>{
 let spawned=0;
 const input=createWindowsWebRtcInput({spawnFn:()=>{spawned++;return spawn(process.execPath,['-e',echoScript],{stdio:['pipe','pipe','pipe']});},idleMs:5000});
 try{
   await input.dispatch(move(1));
   await input.dispatch(move(2));
   assert.equal(spawned,1);
   await input.close();
   await input.dispatch(move(1));
   assert.equal(spawned,2);
 }finally{await input.close();}
});
test('invalid input and a cancelled signal never launch a worker',async()=>{
 let spawned=0;
 const input=createWindowsWebRtcInput({spawnFn:()=>{spawned++;throw Error('must not spawn');}});
 await assert.rejects(input.dispatch({...move(1),kind:'shell'}),/invalid/i);
 const abort=new AbortController();abort.abort();
 await assert.rejects(input.dispatch(move(1),{signal:abort.signal}),/cancel/i);
 assert.equal(spawned,0);
});
test('incorrect native acknowledgement is rejected and never replayed',async()=>{
 let spawned=0;
 const input=createWindowsWebRtcInput({spawnFn:()=>{spawned++;return spawn(process.execPath,['-e',echoScript.replace('seq:p.seq','seq:p.seq+1')],{stdio:['pipe','pipe','pipe']});}});
 try{
   await assert.rejects(input.dispatch(move(1)),/acknowledgement/i);
   assert.equal(spawned,1);
 }finally{await input.close();}
});
test('the private worker contains a fresh interactive-session gate, native source loader and a closed operation switch',()=>{
 const script=windowsWebRtcInputScript();
 assert.match(script,/SessionId -eq 0/);
 assert.match(script,/UserInteractive/);
 assert.match(script,/\[RMMouse\]::InteractiveDesktop\(\)/);
 assert.match(script,/\[RMMouse\]::SendMouseClick/);
 assert.doesNotMatch(script,/\[RMMouse\]::mouse_event/);
 assert.match(script,/REMCP_WINDOWS_SOURCE_BLOCKED/);
 assert.match(script,/switch -CaseSensitive/);
 assert.doesNotMatch(script,/Invoke-Expression|ScriptBlock\]::Create/);
});


test('prewarming starts one child without sending any input, and closes it on Stop',async()=>{
 let spawned=0,writes=0;
 const input=createWindowsWebRtcInput({spawnFn:()=>{spawned++;const child=spawn(process.execPath,['-e',echoScript],{stdio:['pipe','pipe','pipe']});const write=child.stdin.write.bind(child.stdin);child.stdin.write=(...args)=>{writes++;return write(...args);};return child;}});
 try{
   input.prepare();
   input.prepare();
   assert.equal(spawned,1);
   assert.equal(writes,0);
   await input.dispatch(move(1));
   assert.equal(writes,1);
 }finally{await input.close();}
});

// Source-only Windows helper remains pinned and uses acknowledged native
// Unicode input, not a clipboard swap or a PowerShell command per key.
test('fast text and keyboard use native SendInput and preserve the clipboard',()=>{
 const script=windowsWebRtcInputScript();
 assert.match(script,/\[RMMouse\]::SendUnicodeText/);
 assert.match(script,/\[RMMouse\]::SendKeyChord/);
 assert.doesNotMatch(script,/Set-Clipboard|WScript\.Shell/);
 const worker=createWindowsWebRtcInput();
 assert.equal(worker.supports({kind:'text',text:'Привет'}),true);
 assert.equal(worker.supports({kind:'text',text:'a\nb'}),false,'multiline paste retains the existing paste path');
});

