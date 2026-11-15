// Explicitly isolated QA admission for an unsigned one-file Windows worker.
// Production must use publisher-verified signing and process-tree containment;
// this local pilot is not an installer or a remote code-execution capability.
import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync} from 'node:fs';
import path from 'node:path';
import {windowsNativeWorkerTrusted} from './webrtc-windows-trust.mjs';

const SHA256=/^[a-f0-9]{64}$/i;
const MAX_FROZEN_BYTES=160*1024*1024;
const HASH_CHUNK_BYTES=64*1024;

function trustedFileStat(info){
  return info?.isFile?.()===true&&info?.isSymbolicLink?.()!==true&&
    info.nlink===1&&Number.isSafeInteger(info.size)&&
    info.size>0&&info.size<=MAX_FROZEN_BYTES&&
    Number.isSafeInteger(info.dev)&&Number.isSafeInteger(info.ino)&&info.ino>0;
}

function sameFileIdentity(a,b){
  return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&
    a.mtimeMs===b.mtimeMs;
}

export function windowsFrozenQaTrusted(filename,{
  env=process.env,checkAcl=windowsNativeWorkerTrusted,
  open=openSync,close=closeSync,stat=fstatSync,lstat=lstatSync,read=readSync,
}={}){
  if(env.REMCP_WEBRTC_RUNTIME_PILOT!=='1'||
     env.REMCP_WEBRTC_ALLOW_UNSIGNED_FROZEN_QA!=='1'||
     env.REMCP_WEBRTC_FROZEN_QA_MODE!=='1'||
     typeof filename!=='string'||!path.win32.isAbsolute(filename)||
     path.win32.extname(filename).toLowerCase()!=='.exe'||
     !SHA256.test(env.REMCP_WEBRTC_FROZEN_SHA256||''))return false;

  let fd;
  try{
    // Verify Windows ACL/owner before opening the executable. Preserve the
    // bounded 10s ARM64 PowerShell owner check used by this opt-in QA pilot.
    const policy={env,extension:'.exe',timeoutMs:10_000};
    if(!checkAcl(filename,policy))return false;
    const before=lstat(filename);
    if(!trustedFileStat(before))return false;
    // Pin the file once. Do not hash by reopening filename after stat/ACL.
    fd=open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    const initial=stat(fd);
    if(!trustedFileStat(initial)||!sameFileIdentity(before,initial))return false;

    const hash=createHash('sha256');
    const chunk=Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let position=0;
    while(position<initial.size){
      const wanted=Math.min(chunk.length,initial.size-position);
      const count=read(fd,chunk,0,wanted,position);
      if(!Number.isInteger(count)||count<=0||count>wanted)return false;
      hash.update(chunk.subarray(0,count));
      position+=count;
    }
    // Reject append/truncation or replacement before accepting a pinned hash.
    if(read(fd,chunk,0,1,position)!==0)return false;
    const final=stat(fd);
    const atPath=lstat(filename);
    if(!trustedFileStat(final)||!trustedFileStat(atPath)||
       !sameFileIdentity(initial,final)||
       !sameFileIdentity(initial,atPath))return false;
    // Rechecking ACL after the pinned read prevents accepting persistent
    // ownership/permission changes during the validation window.
    if(!checkAcl(filename,policy))return false;
    const valid=hash.digest('hex')===env.REMCP_WEBRTC_FROZEN_SHA256.toLowerCase();
    close(fd);
    fd=undefined;
    return valid;
  }catch{return false;}
  finally{
    if(fd!==undefined){try{close(fd);}catch{/* Already rejecting the candidate. */}}
  }
}
