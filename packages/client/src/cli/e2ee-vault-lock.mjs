// Serialize security-sensitive OS vault mutations across CLI and agent processes.
// Atomic mkdir is portable on Windows, macOS and Linux. Never steal a possibly
// live lock after a crash: failure to modify trust is safer than reviving a peer.
import {mkdir,rmdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const LOCK_NAME='.e2ee-vault-write.lock';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function withE2eeVaultMutation(directory,operation,{
  timeoutMs=15_000,pollMs=75,wait=sleep,now=Date.now,
}={}){
  if(typeof operation!=='function'||typeof directory!=='string'||!directory)
    throw new Error('Invalid E2EE vault mutation');
  const base=path.resolve(directory);
  await mkdir(base,{recursive:true,mode:0o700});
  const dirStat=await lstat(base);
  if(!dirStat.isDirectory()||dirStat.isSymbolicLink()||
      (typeof process.getuid==='function'&&
        (dirStat.uid!==process.getuid()||(dirStat.mode&0o077)!==0)))
    throw new Error('Unsafe E2EE vault directory; owner-private storage required');
  const lock=path.join(base,LOCK_NAME);
  const deadline=now()+timeoutMs;
  for(;;){
    try{await mkdir(lock,{mode:0o700});break;}
    catch(error){
      if(error?.code!=='EEXIST')throw error;
      if(now()>=deadline)throw new Error('E2EE vault write lock busy; refusing concurrent trust mutation');
      await wait(pollMs);
    }
  }
  try{return await operation();}
  finally{await rmdir(lock);}
}
