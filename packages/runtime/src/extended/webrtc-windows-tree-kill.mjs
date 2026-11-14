// Emergency Windows process-tree termination for the private frozen worker.
// No native addon or bundled DLL: use the Windows built-in taskkill /T /F.
// Admission policy must already have pinned the executable and its owner.
import {spawn} from 'node:child_process';
import path from 'node:path';

export function windowsKillWorkerTree(pid,{
  env=process.env,spawnChild=spawn,timeoutMs=10000,
}={}){
  const root=env.SystemRoot;
  if(!Number.isSafeInteger(pid)||pid<4||pid>0xFFFFFFFF||
     typeof root!=='string'||!path.win32.isAbsolute(root)||
     !Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>10000)
    return Promise.resolve(false);
  return new Promise(resolve=>{
    const executable=path.win32.join(root,'System32','taskkill.exe');
    let helper;
    try{
      helper=spawnChild(executable,['/PID',String(pid),'/T','/F'],{
        windowsHide:true,shell:false,stdio:'ignore',
        env:{SystemRoot:root,WINDIR:root,
          PATH:path.win32.join(root,'System32')},
      });
    }catch{return resolve(false);}
    let finished=false;
    const finish=ok=>{
      if(finished)return;
      finished=true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer=setTimeout(()=>{
      try{helper.kill('SIGKILL');}catch{}
      finish(false);
    },timeoutMs);
    timer.unref?.();
    helper.once('error',()=>finish(false));
    helper.once('close',code=>finish(code===0));
  });
}
