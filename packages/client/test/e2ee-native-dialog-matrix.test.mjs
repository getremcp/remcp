import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {nativeEnrollmentDialog} from '../src/cli/e2ee-native-enrollment.mjs';

const code='1234-ABCD-5678-EF90';
function fakeSpawn({exit=0,stdout='',throwCode=null}={}){
  const calls=[];
  const spawnChild=(binary,args,options)=>{
    const child=new EventEmitter(),out=new EventEmitter();
    const record={binary,args,options,input:null,killed:false};
    calls.push(record);
    child.stdout=out;
    child.stderr={resume(){}};
    child.stdin={on(){},end(value=''){record.input=value;}};
    child.kill=()=>{record.killed=true;queueMicrotask(()=>child.emit('close',null));};
    queueMicrotask(()=>{
      if(throwCode){
        const error=new Error('dialog startup denied');
        error.code=throwCode;child.emit('error',error);
      }else{
        if(stdout)out.emit('data',Buffer.from(stdout));
        child.emit('close',exit);
      }
    });
    return child;
  };
  return {spawnChild,calls};
}
const run=(platform,fake,options={})=>nativeEnrollmentDialog(code,{
  platform,spawnChild:fake.spawnChild,environment:{SystemRoot:'C:\\Windows',HOME:'/home/owner'},...options,
});
test('GNOME dialog is owner-confirmed and Cancel is default; no implicit authorization',async()=>{
  const yes=fakeSpawn(),no=fakeSpawn({exit:1});
  assert.equal(await run('linux',yes,{canExecute:async p=>p==='/usr/bin/zenity',desktop:true}),true);
  assert.equal(yes.calls.length,1);
  assert.equal(yes.calls[0].binary,'/usr/bin/zenity');
  assert.ok(yes.calls[0].args.includes('--default-cancel'));
  assert.ok(yes.calls[0].args.some(a=>a.includes('mouse and keyboard')));
  assert.ok(yes.calls[0].args.includes('--ok-label=Allow browser'));
  const ai=fakeSpawn();
  assert.equal(await run('linux',ai,{canExecute:async p=>p==='/usr/bin/zenity',assistant:true}),true);
  assert.ok(ai.calls[0].args.includes('--ok-label=Allow AI client'));
  assert.ok(ai.calls[0].args.some(a=>a.includes('Allow this AI desktop client')));
  assert.equal(await run('linux',no,{canExecute:async()=>true}),false);
});
test('KDE Plasma uses fixed kdialog when zenity is absent, and denial remains denial',async()=>{
  const yes=fakeSpawn(),no=fakeSpawn({exit:1});
  const kde=async p=>p==='/usr/bin/kdialog';
  assert.equal(await run('linux',yes,{canExecute:kde,assistant:true}),true);
  const {binary,args}=yes.calls[0];
  assert.equal(binary,'/usr/bin/kdialog');
  assert.ok(args.includes('--yesno'));
  assert.ok(args.some(v=>v.includes(code)));
  assert.equal(args[args.indexOf('--no-label')+1],'Decline');
  assert.equal(args[args.indexOf('--yes-label')+1],'Allow AI client');
  assert.ok(args.some(v=>v.includes('Allow this AI desktop client')));
  assert.ok(args.some(v=>v.includes('Compare this code with the AI desktop client')));
  assert.equal(await run('linux',no,{canExecute:kde}),false);
});
test('Linux headless or missing GUI dialog cannot approve a remote enrollment',async()=>{
  const mock=fakeSpawn();
  assert.equal(await run('linux',mock,{canExecute:async()=>false}),false);
  assert.equal(mock.calls.length,0);
});
test('macOS AppleScript requires affirmative output, not merely a zero process exit',async()=>{
  const yes=fakeSpawn({stdout:'approved\n'}),no=fakeSpawn();
  assert.equal(await run('darwin',yes,{assistant:true}),true);
  assert.equal(yes.calls[0].binary,'/usr/bin/osascript');
  assert.ok(yes.calls[0].args.some(v=>v.includes(code)));
  assert.equal(yes.calls[0].args[3],'Allow AI client');
  assert.ok(yes.calls[0].args[2].includes('Allow this AI desktop client'));
  assert.match(yes.calls[0].input,/default button "Decline"/);
  assert.match(yes.calls[0].input,/giving up after 120/);
  assert.equal(await run('darwin',no),false);
  const browser=fakeSpawn({stdout:'approved'});
  assert.equal(await run('darwin',browser),true);
  assert.equal(browser.calls[0].args[3],'Allow browser');
  assert.ok(browser.calls[0].args[2].includes('Allow this browser'));
});
test('Windows PowerShell GUI requires explicit Yes via output and reads prompt only from stdin',async()=>{
  const yes=fakeSpawn({stdout:'approved'}),no=fakeSpawn();
  assert.equal(await run('win32',yes,{desktop:true}),true);
  assert.ok(yes.calls[0].binary.endsWith('WindowsPowerShell\\v1.0\\powershell.exe'));
  assert.ok(yes.calls[0].args.includes('-NoProfile'));
  assert.ok(yes.calls[0].args.every(arg=>!arg.includes(code)));
  const message=Buffer.from(yes.calls[0].input,'base64').toString('utf8');
  assert.ok(message.includes(code)&&message.includes('clipboard'));
  assert.ok(yes.calls[0].args.join(' ').includes("'No'"));
  assert.equal(await run('win32',no),false);
  const assistant=fakeSpawn({stdout:'approved'});
  assert.equal(await run('win32',assistant,{assistant:true}),true);
  const assistantText=Buffer.from(assistant.calls[0].input,'base64').toString('utf8');
  assert.match(assistantText,/Allow this AI desktop client/);
  assert.doesNotMatch(assistantText,/Allow this browser/);
});
test('unsupported OS, invalid code, subprocess failure and aborted requests never approve',async()=>{
  const mock=fakeSpawn();
  assert.equal(await run('freebsd',mock),false);
  await assert.rejects(nativeEnrollmentDialog('BAD',{spawnChild:mock.spawnChild}),/Invalid enrollment code/);
  assert.equal(mock.calls.length,0);
  const failure=fakeSpawn({throwCode:'EACCES'});
  assert.equal(await run('darwin',failure),false);
  const abort=new AbortController();abort.abort();
  assert.equal(await run('darwin',fakeSpawn(),{signal:abort.signal}),false);
});


test('client comparison explicitly identifies paired-device code and defaults to decline',async()=>{
  const linux=fakeSpawn();
  assert.equal(await run('linux',linux,{comparison:true,canExecute:async()=>true}),true);
  assert.ok(linux.calls[0].args.includes('--ok-label=Codes match'));
  assert.ok(linux.calls[0].args.includes('--default-cancel'));
  assert.ok(linux.calls[0].args.some(a=>a.includes('paired device')&&a.includes(code)));
  const mac=fakeSpawn({stdout:'approved'});
  assert.equal(await run('darwin',mac,{comparison:true}),true);
  assert.equal(mac.calls[0].args[3],'Codes match');
  const win=fakeSpawn({stdout:'approved'});
  assert.equal(await run('win32',win,{comparison:true}),true);
  assert.match(Buffer.from(win.calls[0].input,'base64').toString(),/paired device/);
  assert.equal(await run('linux',fakeSpawn({exit:1}),{comparison:true,canExecute:async()=>true}),false);
});
