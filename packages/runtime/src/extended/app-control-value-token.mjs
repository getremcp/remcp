// Short-lived, process-local blinded version attestations for native text
// controls. No user-visible raw field text, persistent cache, or server secret.
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';

const key=randomBytes(32);
const ageMs=90_000;
const futureSkewMs=5_000;
const tokenShape=/^av1\.(\d{10,13})\.([a-zA-Z0-9_-]{43})$/;

function fields(value){
  const {app,pid,window_id,control_id,name,role,text}=value||{};
  if(typeof app!=='string'||!app||!Number.isSafeInteger(pid)||pid<=0||
    ![window_id,control_id,name,role,text].every(x=>typeof x==='string'))
    return null;
  return JSON.stringify([app,pid,window_id,control_id,name,role,text]);
}

function signature(payload,issuedSec){
  return createHmac('sha256',key).update('remcp-app-control-v1\0')
    .update(String(issuedSec)).update('\0').update(payload).digest();
}

export function issueControlValueToken(value,{nowMs=Date.now()}={}){
  const payload=fields(value);
  if(!payload||!Number.isSafeInteger(nowMs))return null;
  const issuedSec=Math.floor(nowMs/1000);
  return 'av1.'+issuedSec+'.'+signature(payload,issuedSec).toString('base64url');
}

export function verifyControlValueToken(token,value,{nowMs=Date.now()}={}){
  const payload=fields(value);
  const parsed=typeof token==='string'?token.match(tokenShape):null;
  if(!payload||!parsed||!Number.isSafeInteger(nowMs))return false;
  const issuedSec=Number(parsed[1]);
  const age=nowMs-issuedSec*1000;
  if(!Number.isSafeInteger(issuedSec)||age>ageMs||age< -futureSkewMs)
    return false;
  const provided=Buffer.from(parsed[2],'base64url');
  const expected=signature(payload,issuedSec);
  return provided.length===expected.length&&timingSafeEqual(expected,provided)&&
    parsed[2]===expected.toString('base64url');
}
