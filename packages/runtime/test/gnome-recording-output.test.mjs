import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function record({ format = 'mp4', extension = '', outside = false, symlink = false, noDestination = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remcp-gnome-record-test-'));
  const bin = path.join(root, 'bin');fs.mkdirSync(bin);
  const destination = path.join(root, 'result' + extension);
  const external = path.join(root, 'outside.mp4');
  fs.writeFileSync(external, 'KEEP_OUTSIDE');
  if (extension) fs.writeFileSync(destination, 'KEEP_DESTINATION');
  fs.writeFileSync(path.join(bin, 'gjs'), `#!${process.execPath}
const fs=require('node:fs');
if(process.argv[2]==='-c'){console.log('true');process.exit(0);}
const requested=process.argv[3];
const actual=${outside ? JSON.stringify(external) : "requested.replace(/\\.webm$/,'." + format + "')"};
${symlink ? `fs.symlinkSync(${JSON.stringify(external)},actual);` : outside ? '' : "fs.writeFileSync(actual,'SYNTHETIC_VIDEO');"}
console.log(JSON.stringify({destination:actual,stopped:true}));
`, { mode:0o755 });
  const url = new URL('../src/extended/diagnostics-recording.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module','-e', `
    import {recordScreen} from ${JSON.stringify(url)};
    try {const r=await recordScreen({duration_seconds:1,destination:${noDestination ? 'undefined' : JSON.stringify(destination)}});
      console.log(JSON.stringify({ok:true,payload:JSON.parse(r.content[0].text)}));}
    catch(e){console.log(JSON.stringify({ok:false,error:e.message}));}`], {
    encoding:'utf8',timeout:8000,env:{...process.env,
      PATH:bin + path.delimiter + process.env.PATH,
      XDG_SESSION_TYPE:'wayland',WAYLAND_DISPLAY:'wayland-test',
      XDG_CURRENT_DESKTOP:'GNOME',DBUS_SESSION_BUS_ADDRESS:'unix:path=/synthetic-qa-bus',
      TMPDIR:root,REMCP_RUNTIME_CONFIG_DIR:path.join(root,'config'),REMCP_RUNTIME_ALLOWED_ROOTS:root,
    },
  });
  try {
    assert.equal(result.status,0,result.stderr || String(result.error));
    const parsed = JSON.parse(result.stdout);
    return { ...parsed,
      stagedContent:noDestination && parsed.ok ? fs.readFileSync(parsed.payload.path,'utf8') : null,
      content:fs.existsSync(destination) ? fs.readFileSync(destination,'utf8') : null,
      outside:fs.readFileSync(external,'utf8'),
      remaining:fs.readdirSync(root).filter(name=>name.startsWith('remcp-screen-')),
    };
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}

for (const format of ['mp4','webm']) {
  test(`GNOME's actual ${format} file is copied and reported`, {skip:process.platform!=='linux'}, () => {
    const r=record({format});assert.equal(r.ok,true,r.error);
    assert.equal(r.payload.format,format);assert.equal(r.payload.bytes,15);
    assert.equal(r.content,'SYNTHETIC_VIDEO');assert.deepEqual(r.remaining,[]);
  });
}
test('actual format mismatch leaves the requested file unchanged', {skip:process.platform!=='linux'}, () => {
  const r=record({extension:'.webm'});assert.equal(r.ok,false);
  assert.match(r.error,/produces \.mp4/);assert.equal(r.content,'KEEP_DESTINATION');
  assert.deepEqual(r.remaining,[]);
});
test('an explicit MP4 destination accepts GNOME MP4 output', {skip:process.platform!=='linux'}, () => {
  const r=record({extension:'.mp4'});assert.equal(r.ok,true,r.error);
  assert.equal(r.payload.format,'mp4');assert.equal(r.content,'SYNTHETIC_VIDEO');
});
test('default destination retains and reports the actual GNOME staging file', {skip:process.platform!=='linux'}, () => {
  const r=record({noDestination:true});assert.equal(r.ok,true,r.error);
  assert.equal(r.payload.format,'mp4');assert.match(r.payload.path,/\.mp4$/);
  assert.equal(r.stagedContent,'SYNTHETIC_VIDEO');assert.equal(r.remaining.length,1);
});
test('GNOME cannot redirect the recording outside its private staging directory', {skip:process.platform!=='linux'}, () => {
  const r=record({outside:true});assert.equal(r.ok,false);assert.equal(r.content,null);
  assert.match(r.error,/invalid screen recording staging path/);
  assert.equal(r.outside,'KEEP_OUTSIDE');assert.deepEqual(r.remaining,[]);
});
test('GNOME recording staging symlinks are rejected', {skip:process.platform!=='linux'}, () => {
  const r=record({symlink:true});assert.equal(r.ok,false);assert.equal(r.content,null);
  assert.match(r.error,/non-empty regular file/);
  assert.equal(r.outside,'KEEP_OUTSIDE');assert.deepEqual(r.remaining,[]);
});

test('GNOME helper stops on the original sender after normal completion, signal or exception',()=>{
  const source=fs.readFileSync(new URL('../src/extended/diagnostics-recording.mjs',import.meta.url),'utf8');
  const helper=source.split('const GNOME_SCREENCAST_HELPER = `')[1].split('`')[0];
  assert.ok(helper);
  for(const scenario of ['normal','signal','error','start-denied','stop-denied']){
    const events=[],callbacks=new Map(),removed=[],reports=[];
    let seq=0;
    const id=fn=>{callbacks.set(++seq,fn);return seq;};
    const GLib={Variant:class{},VariantType:class{},PRIORITY_HIGH:-100,PRIORITY_DEFAULT:0,
      SOURCE_CONTINUE:true,SOURCE_REMOVE:false,unix_signal_add:(_priority,_signal,fn)=>id(fn),
      timeout_add:(_priority,ms,fn)=>{assert.equal(ms,120_000);return id(fn);},
      source_remove:source=>removed.push(source),
      MainLoop:{new:()=>({quit(){},run(){
        if(scenario==='error')throw Error('synthetic loop failure');
        if(scenario==='signal')callbacks.get(1)();else callbacks.get(3)();
      }})}};
    const bus={call_sync(...args){
      const method=args[3];events.push(method);
      return {deepUnpack:()=>method==='Get'?[{deepUnpack:()=>true}]:
        method==='Screencast'?[scenario!=='start-denied','/tmp/test.webm']:[scenario!=='stop-denied']};
    }};
    const run=()=>vm.runInNewContext(helper,{imports:{gi:{GLib,Gio:{bus_get_sync:()=>bus,
      BusType:{SESSION:1},DBusCallFlags:{NONE:0}}}},ARGV:['/tmp/test.webm','120','15'],
      print:message=>reports.push(JSON.parse(message))});
    if(scenario==='normal'){run();assert.equal(reports[0].stopped,true);}
    else assert.throws(run,/cancelled|loop failure|refused|did not stop/);
    assert.deepEqual(events,scenario==='start-denied'?['Get','Screencast']:['Get','Screencast','StopScreencast']);
    assert.ok(removed.includes(1)&&removed.includes(2));
    if(scenario==='signal'||scenario==='error')assert.ok(removed.includes(3));
  }
});


test('recording cancellation waits for the helper to exit after its cleanup', {skip:process.platform==='win32'},async t=>{
  const {runFile}=await import('../src/extended/common.mjs');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remcp-record-cancel-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const ready=path.join(root,'ready'),stopped=path.join(root,'stopped');
  const controller=new AbortController();
  const completion=runFile(process.execPath,['-e',`
    const fs=require('node:fs');
    process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(process.argv[2],'stopped');process.exit(0)},60));
    fs.writeFileSync(process.argv[1],'ready');
    setInterval(()=>{},100);
  `,ready,stopped],{timeout:5000,recordingFinalization:true,signal:controller.signal});
  const rejection=assert.rejects(completion,/cancelled/);
  try {
    for(let i=0;i<200&&!fs.existsSync(ready);i++)await new Promise(r=>setTimeout(r,10));
    assert.ok(fs.existsSync(ready),'helper started');
  } finally {controller.abort();}
  await rejection;
  assert.equal(fs.readFileSync(stopped,'utf8'),'stopped','return only after cleanup');
});


test('a signalled recorder is not treated as a successful allowed exit', {skip:process.platform==='win32'},async()=>{
  const {runFile}=await import('../src/extended/common.mjs');
  await assert.rejects(runFile(process.execPath,['-e','process.kill(process.pid,"SIGTERM")'],
    {timeout:5000,recordingFinalization:true,allowFailure:true}),/terminated without a valid exit code/);
});


test('recording rejects promptly if a descendant keeps inherited output open',{skip:process.platform==='win32',timeout:6000},async()=>{
  const {runFile}=await import('../src/extended/common.mjs');
  const started=performance.now();
  await assert.rejects(runFile(process.execPath,['-e',`
    const {spawn}=require('node:child_process');
    const c=spawn(process.execPath,['-e','setTimeout(()=>{},2500)'],{stdio:['ignore','inherit','inherit']});
    c.unref();
  `],{timeout:5000,recordingFinalization:true}),/output streams did not close/);
  assert.ok(performance.now()-started<2200,'recorder exit must not wait for descendant pipes');
});

test('recording cancellation signals its owned POSIX child group',{skip:process.platform==='win32',timeout:8000},async t=>{
  const {runFile}=await import('../src/extended/common.mjs');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remcp-record-group-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const ready=path.join(root,'ready'),stopped=path.join(root,'stopped');
  const controller=new AbortController();
  const script=`
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',process.argv[1],process.argv[2],process.argv[3]],{stdio:['ignore','inherit','inherit']});
    process.on('SIGTERM',()=>{});
    child.on('exit',()=>process.exit(0));
  `;
  const descendant=`
    const fs=require('node:fs');
    process.on('SIGTERM',()=>{fs.writeFileSync(process.argv[2],'stopped');process.exit(0);});
    fs.writeFileSync(process.argv[1],'ready');
    setTimeout(()=>process.exit(2),5000);
  `;
  const completion=runFile(process.execPath,['-e',script,descendant,ready,stopped],
    {timeout:5000,recordingFinalization:true,signal:controller.signal});
  const rejection=assert.rejects(completion,/cancelled/);
  try{
    for(let i=0;i<200&&!fs.existsSync(ready);i++)await new Promise(r=>setTimeout(r,10));
    assert.ok(fs.existsSync(ready));
  }finally{controller.abort();}
  await rejection;
  assert.equal(fs.readFileSync(stopped,'utf8'),'stopped');
});


test('GNU timeout forwards scheduled SIGINT in the recorder-owned process group',{
  skip:process.platform!=='linux'||spawnSync('timeout',['--version']).status!==0,timeout:8000
},async()=>{
  const {runFile}=await import('../src/extended/common.mjs');
  const r=await runFile('timeout',['--foreground','--signal=INT','--kill-after=2s','1s',process.execPath,'-e',
    'process.on("SIGINT",()=>{console.log("finalized");process.exit(0)});setInterval(()=>{},100)'],
    {timeout:5000,recordingFinalization:true,allowFailure:true});
  assert.equal(r.code,124);
  assert.match(r.stdout,/finalized/);
  const source=fs.readFileSync(new URL('../src/extended/diagnostics-recording.mjs',import.meta.url),'utf8');
  assert.ok(source.includes("runFile('timeout', ['--foreground', '--signal=INT'"));
});
