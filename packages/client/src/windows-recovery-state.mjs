import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const directory=()=>process.env.REMCP_CONFIG_DIR||path.join(os.homedir(),'.config','remcp');
const stateFile=root=>path.join(root,'windows-recovery-hold.json');
export function recoveryTargetHeld(target, root=directory()){
 try{
  const stat=fs.lstatSync(stateFile(root));if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)return true;
  const state=JSON.parse(fs.readFileSync(stateFile(root),'utf8'));
  if(typeof state.target!=='string'||state.reason!=='payload-validation-failed')return true;
  return state.target===target;
 }catch(error){return error.code==='ENOENT'?false:true;}
}
export function holdRecoveryTarget(target,root=directory()){
 if(typeof target!=='string'||target.length>256)throw new Error('Invalid recovery target');
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const temporary=stateFile(root)+'.'+process.pid+'.tmp';
 fs.writeFileSync(temporary,JSON.stringify({target,reason:'payload-validation-failed',at:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});
 try{fs.renameSync(temporary,stateFile(root));}finally{try{fs.unlinkSync(temporary);}catch{}}
}
export function clearRecoveryHold(root=directory()){
 try{fs.unlinkSync(stateFile(root));}catch(error){if(error.code!=='ENOENT')throw error;}
}
