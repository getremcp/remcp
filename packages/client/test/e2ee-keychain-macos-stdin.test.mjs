import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createMacE2eeStore} from '../src/cli/e2ee-keychain.mjs';

const macVaultTest=process.platform==='win32'?test.skip:test;
const account='a'.repeat(64),service='site.remcp.e2ee';
const unavailable=()=>new Error('QA vault unavailable');
async function fixture(t,{acceptWrite=true,accountValue=account}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'remcp-macos-keychain-qa-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  let key=null,interactiveCalls=0;
  const run=async(command,args,input='')=>{
    assert.equal(command,'/usr/bin/security');
    if(args[0]==='find-generic-password'){
      assert.deepEqual(args.slice(1),['-a',accountValue,'-s',service,'-w']);
      return key?{code:0,output:key+'\n'}:{code:44,output:''};
    }
    if(args[0]==='-i'){
      interactiveCalls++;
      assert.deepEqual(args,['-i'],'wrapping key must not appear in argv');
      const match=/^add-generic-password -a ([a-f0-9]{64}) -s (site\.remcp\.e2ee) -w ([A-Za-z0-9_-]{43})\n$/.exec(input);
      assert.ok(match,'security -i receives one validated stdin command');
      assert.equal(match[1],accountValue);
      if(acceptWrite)key=match[3];
      return {code:1,output:''}; // security(1) can return 1 on EOF after success.
    }
    if(args[0]==='delete-generic-password'){
      key=null;
      return {code:0,output:''};
    }
    throw new Error('unexpected keychain operation: '+args[0]);
  };
  return {store:createMacE2eeStore({run,service,account:accountValue,directory,profile:'device',unavailable}),
    directory,getInteractiveCalls:()=>interactiveCalls};
}

macVaultTest('macOS Keychain creates E2EE key without terminal prompts or secret argv',async t=>{
  const {store,directory,getInteractiveCalls}=await fixture(t);
  const initial={qa:true,value:'first'};
  await store.write(initial);
  assert.deepEqual(await store.read(),initial);
  assert.equal(getInteractiveCalls(),1);
  const encrypted=await fs.readFile(path.join(directory,'e2ee-device.keychain'),'utf8');
  assert.doesNotMatch(encrypted,/first/);
  await store.write({qa:true,value:'second'});
  assert.deepEqual(await store.read(),{qa:true,value:'second'});
  assert.equal(getInteractiveCalls(),1,'existing wrapping key must be reused');
  await store.remove();
  assert.equal(await store.read(),null);
});

macVaultTest('macOS Keychain fails closed if interactive command did not create a key',async t=>{
  const {store,directory}=await fixture(t,{acceptWrite:false});
  await assert.rejects(store.write({qa:true}),/QA vault unavailable/);
  await assert.rejects(fs.stat(path.join(directory,'e2ee-device.keychain')),{code:'ENOENT'});
});

macVaultTest('macOS Keychain rejects unsafe account input before invoking security -i',async t=>{
  const {store,getInteractiveCalls}=await fixture(t,{accountValue:'bad account; quit'});
  await assert.rejects(store.write({qa:true}),/QA vault unavailable/);
  assert.equal(getInteractiveCalls(),0);
});
