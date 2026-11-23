import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {desktopMediaEnvironment,desktopMediaPlatformEnvironment,desktopMediaNativeSource,prepareMacDesktopMediaRuntime} from '../src/cli/desktop-media-install.mjs';
test('explicit disabled or invalid media profile cannot inherit an old QA enablement',()=>{
  assert.equal(desktopMediaEnvironment({enabled:false},'').REMCP_WEBRTC_RUNTIME_PILOT,'0');
  assert.equal(desktopMediaEnvironment({enabled:true},'').REMCP_WEBRTC_RUNTIME_PILOT,'0');
  assert.deepEqual(desktopMediaEnvironment(undefined,''),{});
});
test('changed media source cannot become an enabled runtime, and test-source flags are cleared',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remcp-media-manifest-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'src/native/webrtc');fs.mkdirSync(source,{recursive:true});
  const files={};
  for(const name of ['worker_stdio.py','requirements.lock']){
    fs.writeFileSync(path.join(source,name),'reviewed source',{mode:0o600});
    files[name]=createHash('sha256').update('reviewed source').digest('hex');
  }
  fs.writeFileSync(path.join(source,'source-manifest.json'),JSON.stringify({version:1,protocol:'remcp-media-stdio-v1',files}));
  const profile={version:1,protocol:'remcp-media-stdio-v1',enabled:true,python:process.execPath};
  const entry=path.join(root,'src/index.mjs');
  const valid=desktopMediaEnvironment(profile,entry);
  assert.equal(valid.REMCP_WEBRTC_RUNTIME_PILOT,'1');
  assert.equal(valid.REMCP_WEBRTC_FROZEN_WORKER,'');
  assert.equal(valid.REMCP_WEBRTC_ALLOW_TEST_SOURCE,'0');
  fs.writeFileSync(path.join(source,'worker_stdio.py'),'changed source');
  assert.equal(desktopMediaEnvironment(profile,entry).REMCP_WEBRTC_RUNTIME_PILOT,'0');
});

test('Windows media preserves system paths across a case-sensitive environment spread',()=>{
  const env={SYSTEMROOT:'C:\\Windows',localappdata:'C:\\Users\\Owner\\AppData\\Local'};
  assert.deepEqual(desktopMediaPlatformEnvironment(env,'win32'),{SystemRoot:env.SYSTEMROOT,WINDIR:env.SYSTEMROOT,LOCALAPPDATA:env.localappdata});
  assert.deepEqual(desktopMediaPlatformEnvironment(env,'linux'),{});
});

test('X11 native source stays local and never overrides a Wayland session',()=>{
  assert.equal(desktopMediaNativeSource({DISPLAY:':0',XDG_SESSION_TYPE:'x11'},'linux'),'x11');
  assert.equal(desktopMediaNativeSource({DISPLAY:':0'},'linux'),'x11');
  for(const env of [{DISPLAY:'host:0'},{DISPLAY:':0',WAYLAND_DISPLAY:'wayland-0'},{DISPLAY:':0',XDG_SESSION_TYPE:'wayland'},{}])
    assert.equal(desktopMediaNativeSource(env,'linux'),'portal');
  assert.equal(desktopMediaNativeSource({},'win32'),'gdigrab');
  assert.equal(desktopMediaNativeSource({},'darwin'),'avfoundation');
});

test('Mac media setup repairs only existing owner-owned native paths',
  {skip:process.platform==='win32'},t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'remcp-mac-media-mode-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const dir=path.join(home,'Library','Application Support','ReMCP','webrtc-runtime');
  fs.mkdirSync(dir,{recursive:true,mode:0o755});
  fs.chmodSync(dir,0o755);
  const lock=path.join(dir,'remcp-webrtc-native-worker.lock');
  fs.writeFileSync(lock,'owned-native-lock',{mode:0o755});
  assert.equal(prepareMacDesktopMediaRuntime({home,platform:'darwin'}),dir);
  assert.equal(fs.statSync(dir).mode&0o777,0o700);
  assert.equal(fs.statSync(lock).mode&0o777,0o600);
  assert.equal(fs.readFileSync(lock,'utf8'),'owned-native-lock');
  assert.equal(prepareMacDesktopMediaRuntime({home,platform:'darwin'}),dir);
  assert.equal(fs.statSync(lock).nlink,1);
});

test('Mac media setup creates private directory without inventing a worker lock',
  {skip:process.platform==='win32'},t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'remcp-mac-media-new-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const dir=prepareMacDesktopMediaRuntime({home,platform:'darwin'});
  assert.equal(fs.statSync(dir).mode&0o777,0o700);
  assert.equal(fs.existsSync(path.join(dir,'remcp-webrtc-native-worker.lock')),false);
});

test('Mac media setup denies symlinks, foreign ownership, and hardlinked locks',
  {skip:process.platform==='win32'},t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'remcp-mac-media-guard-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const dir=path.join(home,'Library','Application Support','ReMCP','webrtc-runtime');
  fs.mkdirSync(path.dirname(dir),{recursive:true,mode:0o700});
  assert.throws(()=>prepareMacDesktopMediaRuntime({home,platform:'darwin',
    uid:process.getuid()+1}),/Unsafe native media parent/);
  const unrelated=path.join(home,'unrelated');
  fs.mkdirSync(unrelated,{mode:0o700});
  fs.symlinkSync(unrelated,dir,'dir');
  assert.throws(()=>prepareMacDesktopMediaRuntime({home,platform:'darwin'}));
  fs.unlinkSync(dir);
  fs.mkdirSync(dir,{mode:0o700});
  const lock=path.join(dir,'remcp-webrtc-native-worker.lock');
  fs.writeFileSync(lock,'secret',{mode:0o644});
  fs.linkSync(lock,path.join(dir,'another-link'));
  assert.throws(()=>prepareMacDesktopMediaRuntime({home,platform:'darwin'}),
    /Unsafe native media worker lock/);
  assert.equal(fs.statSync(lock).mode&0o777,0o644,
    'denied hardlinked lock must not be modified');
});

test('non-Mac native runtime remediation is a no-op',()=>{
  assert.equal(prepareMacDesktopMediaRuntime({platform:'linux',home:'/never/exist'}),null);
  assert.equal(prepareMacDesktopMediaRuntime({platform:'win32',home:'C:\\Invalid'}),null);
});
