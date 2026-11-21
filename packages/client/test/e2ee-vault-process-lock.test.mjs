import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {withE2eeVaultMutation} from '../src/cli/e2ee-vault-lock.mjs';

async function waitBounded(promise,ms,label){
  const abort=new AbortController();
  try{return await Promise.race([promise,sleep(ms,undefined,{signal:abort.signal})
    .then(()=>{throw new Error(label);})]);}
  finally{abort.abort();}
}

test('different processes cannot concurrently mutate the same E2EE OS vault',{
  timeout:15000,
},async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'remcp-e2ee-process-lock-'));
  const helper=new URL('../src/cli/e2ee-vault-lock.mjs',import.meta.url).href;
  const code='import {withE2eeVaultMutation} from '+JSON.stringify(helper)+';\n'+
    'await withE2eeVaultMutation('+JSON.stringify(directory)+',async()=>{\n'+
    'process.stdout.write("LOCKED\\n");\n'+
    'await new Promise(resolve=>process.stdin.once("data",resolve));\n'+
    '});\n';
  const child=spawn(process.execPath,['--input-type=module','-e',code],{
    stdio:['pipe','pipe','pipe'],
  });
  let entered=false;
  try{
    const ready=new Promise((resolve,reject)=>{
      child.stdout.once('data',chunk=>{
        if(chunk.toString().includes('LOCKED'))resolve();
        else reject(new Error('Child did not acquire lock'));
      });
      child.once('error',reject);
      child.once('exit',exit=>reject(new Error('Child exited before acquiring lock: '+exit)));
    });
    await waitBounded(ready,4500,'Child lock timeout');
    await assert.rejects(withE2eeVaultMutation(directory,async()=>{entered=true;},
      {timeoutMs:140,pollMs:15}),/vault write lock busy/);
    assert.equal(entered,false,'No cross-process grant/revoke may bypass the lock');
    child.stdin.end('release\n');
    const [exit]=await waitBounded(once(child,'exit'),4500,'Child lock release timeout');
    assert.equal(exit,0);
    await withE2eeVaultMutation(directory,async()=>{entered=true;});
    assert.equal(entered,true,'Owner may retry safely after the lock is released');
  }finally{
    if(child.exitCode===null){child.kill();await waitBounded(
      once(child,'exit').catch(()=>{}),1000,'Child teardown timeout').catch(()=>{});}
    await rm(directory,{recursive:true,force:true});
  }
});

test('OS vault write lock is released after a rejected owner operation',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'remcp-e2ee-lock-exception-'));
  try{
    await assert.rejects(withE2eeVaultMutation(directory,async()=>{
      throw new Error('owner vault write failed');
    }),/owner vault write failed/);
    let retried=false;
    await withE2eeVaultMutation(directory,async()=>{retried=true;},
      {timeoutMs:200,pollMs:10});
    assert.equal(retried,true,'a failed write must not block subsequent owner recovery');
  }finally{await rm(directory,{recursive:true,force:true});}
});
