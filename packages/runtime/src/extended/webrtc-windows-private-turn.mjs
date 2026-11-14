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
    // Verify all parents, owner SID and DACL BEFORE touching contents.
    if(!verify(filename,{env,extension:'.json',timeoutMs:10_000}))
      throw new Error('Untrusted Windows private TURN file');
    const before=lstat(filename);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||
       before.size<2||before.size>WINDOWS_PRIVATE_TURN_MAX_BYTES)
      throw new Error('Unsafe Windows private TURN file');
    fd=open(filename,constants.O_RDONLY);
    const info=stat(fd);
    if(!info.isFile()||info.nlink!==1||info.size!==before.size||
       info.mtimeMs!==before.mtimeMs||info.ino!==before.ino)
      throw new Error('Windows private TURN file changed');
    const data=Buffer.allocUnsafe(info.size);
    let n=0;
    while(n<info.size){
      const k=read(fd,data,n,info.size-n,n);
      if(!Number.isInteger(k)||k<=0)throw new Error('Truncated private TURN file');
      n+=k;
    }
    const after=stat(fd);
    if(after.size!==info.size||after.mtimeMs!==info.mtimeMs)
      throw new Error('Windows private TURN file changed');
    const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
    if(parsed===null||typeof parsed!=='object'||Array.isArray(parsed))
      throw new Error('Malformed private TURN file');
    // The worker applies the strict URL, short TTL, credential and expiry
    // contract before opening native screen capture.
    return parsed;
  }catch{
    throw new Error('Windows private TURN unavailable');
  }finally{
    if(fd!==null){try{close(fd);}catch{}}
  }
}
