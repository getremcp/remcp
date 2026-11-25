// Experimental Windows-only local TURN handoff for native desktop capture.
// No caller-provided URL or credential can cross the device RPC boundary.
// A separately provisioned, owner-private short-lived JSON file is read
// locally, ACL/owner verified and transmitted over the worker's private stdio.
// No environment variables, argv, logs or server HTTP responses carry secrets.
import path from 'node:path';
import {constants,openSync,closeSync,fstatSync,lstatSync,readSync} from 'node:fs';
import {windowsNativeWorkerTrusted} from './webrtc-windows-trust.mjs';

export const WINDOWS_PRIVATE_TURN_NAME='remcp-webrtc-turn.json';
export const WINDOWS_PRIVATE_TURN_MAX_BYTES=4096;

function trustedTurnFile(info){
  return info?.isFile?.()===true&&info?.isSymbolicLink?.()!==true&&
    info.nlink===1n&&typeof info.size==='bigint'&&
    info.size>=2n&&info.size<=BigInt(WINDOWS_PRIVATE_TURN_MAX_BYTES)&&
    typeof info.dev==='bigint'&&info.dev>=0n&&
    typeof info.ino==='bigint'&&info.ino>0n&&
    typeof info.mtimeNs==='bigint'&&typeof info.ctimeNs==='bigint';
}

function sameTurnFile(a,b){
  return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&
    a.nlink===b.nlink&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
}

export function readWindowsPrivateTurn({
  env=process.env,platform=process.platform,
  verify=windowsNativeWorkerTrusted,open=openSync,close=closeSync,
  stat=fstatSync,lstat=lstatSync,read=readSync,
}={}){
  if(platform!=='win32'||env.REMCP_WEBRTC_RUNTIME_PILOT!=='1'||
     env.REMCP_WEBRTC_FROZEN_QA_MODE!=='1'||
     env.REMCP_WEBRTC_WINDOWS_PRIVATE_TURN_QA!=='1'||
     typeof env.LOCALAPPDATA!=='string'||!path.win32.isAbsolute(env.LOCALAPPDATA))
    throw new Error('Windows private TURN not enabled');
  const filename=path.win32.join(env.LOCALAPPDATA,'ReMCP','webrtc-runtime',
    WINDOWS_PRIVATE_TURN_NAME);
  let fd=null;
  try{
    // The ACL/owner check is path-based and must precede opening secrets.
    // A second verification below prevents trusting permissions revoked
    // during a pinned-descriptor read.
    const policy={env,extension:'.json',timeoutMs:10_000};
    if(!verify(filename,policy))
      throw new Error('Untrusted Windows private TURN file');
    // Preserve exact NTFS file identity, including IDs above 2^53.
    const before=lstat(filename,{bigint:true});
    if(!trustedTurnFile(before))throw new Error('Unsafe Windows private TURN file');

    // Pin a single descriptor and never reopen the filename to read secrets.
    // O_NOFOLLOW is platform-dependent; identity and ACL rechecks below are
    // mandatory even when it is unsupported on Windows.
    fd=open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    const info=stat(fd,{bigint:true});
    if(!trustedTurnFile(info)||!sameTurnFile(before,info))
      throw new Error('Windows private TURN file changed');

    // The size has already passed the strict 4096-byte bound.
    const size=Number(info.size);
    const data=Buffer.allocUnsafe(size);
    let n=0;
    try{
      while(n<size){
        const k=read(fd,data,n,size-n,n);
        if(!Number.isInteger(k)||k<=0||k>size-n)
          throw new Error('Truncated private TURN file');
        n+=k;
      }
      // A growing or replaced source must not be accepted by this reader.
      if(read(fd,Buffer.allocUnsafe(1),0,1,n)!==0)
        throw new Error('Windows private TURN file grew');
      const after=stat(fd,{bigint:true});
      const atPath=lstat(filename,{bigint:true});
      if(!trustedTurnFile(after)||!trustedTurnFile(atPath)||
         !sameTurnFile(info,after)||!sameTurnFile(info,atPath)||
         !verify(filename,policy))
        throw new Error('Windows private TURN file changed');
      const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
      if(parsed===null||typeof parsed!=='object'||Array.isArray(parsed))
        throw new Error('Malformed private TURN file');
      // URL, TTL and expiry validation happens in the private worker.
      return parsed;
    }finally{data.fill(0);}
  }catch{
    throw new Error('Windows private TURN unavailable');
  }finally{
    if(fd!==null){try{close(fd);}catch{}}
  }
}
