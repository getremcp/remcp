import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createMacE2eeStore} from '../src/cli/e2ee-keychain.mjs';
import {createE2eeVault} from '../src/cli/e2ee-vault.mjs';

const macVaultTest=process.platform==='win32'?test.skip:test;
const unavailable=()=>new Error('vault unavailable');
async function fixture(t,{duplicate=false,findCode=null,storeCode=0,account='a'.repeat(64),service='site.remcp.e2ee'}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'remcp-keychain-contract-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const calls=[];let key=null;
 const run=async(command,args,input='')=>{
  calls.push({command,args,input});
  if(args[0]==='find-generic-password')return findCode!==null?{code:findCode,output:''}
   :key?{code:0,output:key+'\n'}:{code:44,output:''};
  if(args[0]==='-i'){
   assert.equal(command,'/usr/bin/security');
   const match=input.match(/ -w ([A-Za-z0-9_-]{43})\n$/);
   assert.ok(match,'one explicit wrapping key in stdin, never a getpass request');
   if(duplicate||storeCode===0)key=duplicate?randomBytes(32).toString('base64url'):match[1];
   return {code:duplicate?45:storeCode,output:''};
  }
  if(args[0]==='delete-generic-password'){key=null;return {code:0,output:''};}
  throw new Error('Unexpected Keychain command');
 };
 const store=createMacE2eeStore({run,account,service,directory,profile:'client',unavailable});
 return {directory,calls,store,get key(){return key;}};
}

macVaultTest('Mac wrapping key uses a single stdin command with no secret in argv or encrypted file',async t=>{
 const f=await fixture(t),value={marker:'synthetic-data-'.repeat(200)};
 await f.store.write(value);assert.deepEqual(await f.store.read(),value);
 const create=f.calls.find(c=>c.args[0]==='-i');
 assert.deepEqual(create.args,['-i']);
 assert.equal(create.input.split('\n').length,2);
 assert.ok(!f.calls.some(c=>c.args.includes(f.key)));
 assert.ok(!create.input.includes(' -A')&&!create.input.includes(' -U'));
 const disk=await fs.readFile(path.join(f.directory,'e2ee-client.keychain'),'utf8');
 assert.ok(!disk.includes(f.key)&&!disk.includes(value.marker));
 const first=JSON.parse(disk);
 await f.store.write({marker:'updated'});assert.deepEqual(await f.store.read(),{marker:'updated'});
 assert.equal(f.calls.filter(c=>c.args[0]==='-i').length,1,'existing identity is not rotated');
 assert.notEqual(JSON.parse(await fs.readFile(path.join(f.directory,'e2ee-client.keychain'),'utf8')).iv,first.iv);
 await f.store.remove();assert.equal(await f.store.read(),null);
});

macVaultTest('Mac Keychain rejects command injection before any subprocess',async t=>{
 for(const value of ['account; quit','account\nexit','service\rnext','bad\0value','x'.repeat(513)]){
  const f=await fixture(t,{account:value});
  await assert.rejects(f.store.write({marker:'denied'}),/unavailable/);
  assert.equal(f.calls.length,0);
 }
 const f=await fixture(t,{service:'site.remcp.e2ee\nquit'});
 await assert.rejects(f.store.write({marker:'denied'}),/unavailable/);
 assert.equal(f.calls.length,0);
});

macVaultTest('Mac duplicate initializer adopts the existing Keychain key without overwriting it',async t=>{
 const f=await fixture(t,{duplicate:true});await f.store.write({marker:'duplicate'});
 assert.deepEqual(await f.store.read(),{marker:'duplicate'});
 assert.ok(f.calls.every(c=>!c.args.includes('-U')));
});

macVaultTest('Mac locked or failed Keychain never creates a ciphertext or downgrades to a file key',async t=>{
 for(const options of [{findCode:51},{storeCode:53}]){
  const f=await fixture(t,options);await assert.rejects(f.store.write({marker:'denied'}),/unavailable/);
  assert.deepEqual(await fs.readdir(f.directory),[]);
 }
});

macVaultTest('Mac missing key with existing ciphertext refuses a new wrapping key',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.directory,'e2ee-client.keychain'),
  JSON.stringify({version:1,iv:'invalid',tag:'invalid',ciphertext:'preserve'}),{mode:0o600});
 const before=await fs.readFile(path.join(f.directory,'e2ee-client.keychain'),'utf8');
 await assert.rejects(f.store.write({marker:'must-not-replace'}),/unavailable/);
 assert.ok(!f.calls.some(c=>c.args[0]==='-i'));
 assert.equal(await fs.readFile(path.join(f.directory,'e2ee-client.keychain'),'utf8'),before);
});

test('native Mac Keychain creates and reads from a controlling TTY without asking for item data',{
 skip:process.platform!=='darwin'||process.env.REMCP_E2EE_NATIVE_VAULT_QA!=='1'
  ?'Requires macOS owner Keychain and explicit native QA':false,
},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'remcp-keychain-native-tty-'));
 const vault=createE2eeVault({directory,profile:'client'});
 const childCode=`import{createE2eeVault}from ${JSON.stringify(new URL('../src/cli/e2ee-vault.mjs',import.meta.url).href)};
  const v=createE2eeVault({directory:process.env.REMCP_TTY_TEST_DIRECTORY,profile:'client'});
  try{await v.write({marker:'native-tty-check'});const r=await v.read();
   if(r?.marker!=='native-tty-check')throw Error('roundtrip failed');console.log('TTY_KEYCHAIN_OK');}
  finally{await v.remove();}`;
 const python=String.raw`import os,pty,select,signal,time,json
pid,fd=pty.fork()
if pid==0:os.execv(os.environ['REMCP_TTY_TEST_NODE'],[os.environ['REMCP_TTY_TEST_NODE'],'--input-type=module','-e',os.environ['REMCP_TTY_TEST_CODE']])
output=b'';status=None
try:
 deadline=time.monotonic()+20
 while time.monotonic()<deadline:
  ready,_,_=select.select([fd],[],[],.1)
  if ready:
   try:chunk=os.read(fd,65536)
   except OSError:break
   if not chunk:break
   output+=chunk
   if b'password data for new item:' in output:break
  done,st=os.waitpid(pid,os.WNOHANG)
  if done:status=st;break
 if status is None:
  for _ in range(20):
   done,st=os.waitpid(pid,os.WNOHANG)
   if done:status=st;break
   time.sleep(.05)
 print(json.dumps({'ok':b'TTY_KEYCHAIN_OK' in output,'prompt':b'password data for new item:' in output,'status':status}))
finally:
 if status is None:
  try:os.killpg(pid,signal.SIGKILL)
  except ProcessLookupError:pass
  try:os.waitpid(pid,0)
  except ChildProcessError:pass
 os.close(fd)
`;
 try{
  const child=spawnSync('/usr/bin/python3',['-c',python],{encoding:'utf8',timeout:25000,
   env:{...process.env,REMCP_TTY_TEST_NODE:process.execPath,REMCP_TTY_TEST_CODE:childCode,REMCP_TTY_TEST_DIRECTORY:directory}});
  assert.equal(child.status,0,'native PTY harness exited successfully');
  const result=JSON.parse(child.stdout.trim());
  assert.equal(result.prompt,false,'Keychain creation must never read item data from the owner TTY');
  assert.equal(result.ok,true,'actual native write/read completed under TTY');
  assert.equal(result.status,0,'native child completed cleanup and exited successfully');
 }finally{await vault.remove();await fs.rm(directory,{recursive:true,force:true});}
});
