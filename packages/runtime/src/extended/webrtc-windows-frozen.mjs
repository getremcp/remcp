// Explicitly isolated QA admission for an unsigned one-file Windows worker.
// Production must use publisher-verified signing and process-tree containment;
// this local pilot is not an installer or a remote code-execution capability.
import {createHash} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {windowsNativeWorkerTrusted} from './webrtc-windows-trust.mjs';

const SHA256=/^[a-f0-9]{64}$/i;
const MAX_FROZEN_BYTES=160*1024*1024;

export function windowsFrozenQaTrusted(filename,{
  env=process.env,checkAcl=windowsNativeWorkerTrusted,
  read=readFileSync,stat=statSync,
}={}){
  if(env.REMCP_WEBRTC_RUNTIME_PILOT!=='1'||
     env.REMCP_WEBRTC_ALLOW_UNSIGNED_FROZEN_QA!=='1'||
     env.REMCP_WEBRTC_FROZEN_QA_MODE!=='1'||
     typeof filename!=='string'||!path.win32.isAbsolute(filename)||
     path.win32.extname(filename).toLowerCase()!=='.exe'||
     !SHA256.test(env.REMCP_WEBRTC_FROZEN_SHA256||''))return false;
  try{
    // Windows ACL must be verified *before* reading any candidate executable.
    // Windows ARM64 PowerShell ACL enumeration can cold-start slowly under
    // AV/VM load. Still fail closed, but allow a bounded 10-second QA probe.
    if(!checkAcl(filename,{env,extension:'.exe',timeoutMs:10_000}))return false;
    const info=stat(filename);
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||
       info.size<=0||info.size>MAX_FROZEN_BYTES)return false;
    const actual=createHash('sha256').update(read(filename)).digest('hex');
    return actual===env.REMCP_WEBRTC_FROZEN_SHA256.toLowerCase();
  }catch{return false;}
}
