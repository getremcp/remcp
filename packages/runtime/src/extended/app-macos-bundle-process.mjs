// Read-only macOS bundle/process provenance for same-name .app copies.
// A displayed name or AppleScript AX window is not proof of a selected bundle.
import {runFile} from './common.mjs';

const isBundlePath=value=>typeof value==='string'&&
  value.length<1024&&value.startsWith('/')&&value.endsWith('.app')&&
  !/[\u0000-\u001f\u007f]/u.test(value)&&!value.split('/').includes('..');

export function macBundleMatchesExecutable(bundlePath,executable){
  if(!isBundlePath(bundlePath)||typeof executable!=='string')return false;
  const observed=executable.trim();
  // Not a substring/dirname match: /Applications/App.app2 must not match.
  return observed.startsWith(bundlePath+'/Contents/')&&
    observed.length>bundlePath.length+'/Contents/'.length;
}

export async function macBundlePidVerified(bundlePath,pid,{runFileFn=runFile}={}){
  if(!isBundlePath(bundlePath)||!Number.isSafeInteger(pid)||pid<=0)
    return false;
  try{
    const result=await runFileFn('/bin/ps',['-p',String(pid),'-o','comm='],{
      label:'macOS app bundle process provenance',timeout:3000,
      maxBuffer:16*1024,allowFailure:true,
    });
    if(result.code!==0)return false;
    const output=String(result.stdout||'').trim();
    return !output.includes('\n')&&macBundleMatchesExecutable(bundlePath,output);
  }catch{return false}
}
