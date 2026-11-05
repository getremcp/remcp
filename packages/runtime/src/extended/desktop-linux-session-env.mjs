// A ReMCP user service can start before GNOME imports its graphical
// session into systemd --user. Restore only verified current-user Wayland
// environment keys; do not read arbitrary files or import secrets.
import process from 'node:process';
import { lstat, realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import { runFile } from './common.mjs';

const SESSION_KEYS=new Set([
  'DISPLAY','WAYLAND_DISPLAY','XDG_SESSION_TYPE','XDG_CURRENT_DESKTOP',
]);

function sessionKeys(text) {
  const result=Object.create(null);
  for(const line of String(text || '').split(/\r?\n/)){
    const idx=line.indexOf('=');
    if(idx<1)continue;
    const key=line.slice(0,idx);
    if(SESSION_KEYS.has(key))result[key]=line.slice(idx+1);
  }
  return result;
}

export async function hydrateLinuxDesktopEnv({
  platform=process.platform,
  uid=typeof process.getuid==='function'?process.getuid():null,
  env=process.env,
  runFileFn=runFile,
  lstatFn=lstat,
  realpathFn=realpath,
}={}){
  if(platform!=='linux'||env.DISPLAY||env.WAYLAND_DISPLAY||
     (env.XDG_SESSION_TYPE && env.XDG_SESSION_TYPE!=='wayland')||
     !env.DBUS_SESSION_BUS_ADDRESS||!env.XDG_RUNTIME_DIR||
     !Number.isSafeInteger(uid)||!posix.isAbsolute(env.XDG_RUNTIME_DIR)){
    return false;
  }
  // Snapshot the authenticated session context before any awaited operation.
  const runtimeDir=env.XDG_RUNTIME_DIR;
  const busAddress=env.DBUS_SESSION_BUS_ADDRESS;
  const sessionType=env.XDG_SESSION_TYPE;
  let result;
  try{
    result=await runFileFn('systemctl',['--user','show-environment'],{
      label:'user graphical session environment',allowFailure:true,
      timeout:1500,maxBuffer:64*1024,
    });
  }catch{return false;}
  if(result?.code!==0)return false;
  const values=sessionKeys(result.stdout);
  const socketName=values.WAYLAND_DISPLAY;
  if(values.XDG_SESSION_TYPE!=='wayland'||
     typeof socketName!=='string'||socketName.length<1||
     socketName.length>64||socketName.includes('..')||
     !/^[A-Za-z0-9_.-]+$/.test(socketName)){
    return false;
  }
  try{
    // A trailing slash makes lstat(path) follow a symlink on Linux. Resolve
    // the *whole* path first to reject aliases via the final component or
    // any parent directory; never import a display from an ambiguous root.
    if(await realpathFn(runtimeDir)!==posix.resolve(runtimeDir))return false;
    // The XDG runtime directory itself must be private (mode 0700),
    // user-owned and not a symlink, in addition to the socket's owner.
    const dir=await lstatFn(runtimeDir);
    if(!dir.isDirectory()||dir.uid!==uid||(dir.mode&0o777)!==0o700)
      return false;
    const socket=await lstatFn(posix.join(runtimeDir,socketName));
    if(!socket.isSocket()||socket.uid!==uid)return false;
  }catch{return false;}
  // A graphical login or session switch may complete during systemctl/lstat.
  // Never overwrite its newer environment with an earlier snapshot.
  if(env.DISPLAY||env.WAYLAND_DISPLAY||env.XDG_SESSION_TYPE!==sessionType||
     env.XDG_RUNTIME_DIR!==runtimeDir||env.DBUS_SESSION_BUS_ADDRESS!==busAddress)
    return false;
  env.XDG_SESSION_TYPE='wayland';
  env.WAYLAND_DISPLAY=socketName;
  if(/^:[0-9]{1,4}(?:\.[0-9]{1,2})?$/.test(values.DISPLAY||'')){
    env.DISPLAY=values.DISPLAY;
  }
  const desktop=values.XDG_CURRENT_DESKTOP;
  if(typeof desktop==='string'&&desktop.length<=96&&
     /^[A-Za-z0-9:_-]+$/.test(desktop)){
    env.XDG_CURRENT_DESKTOP=desktop;
  }
  return true;
}
