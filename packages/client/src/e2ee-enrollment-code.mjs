// Short authentication string binds both public identities, device, boot epoch and a
// fresh browser nonce and permission. Compare in the owner-local OS dialog.
// A relay-controlled fingerprint or a displayed server response is not trust.
import {e2eeFingerprint} from './agent-e2ee-crypto.mjs';

export const ENROLL_VERSION='remcp-e2ee-enroll-v1';
export const ENROLL_TTL_MS=180_000;
const codePattern=/^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/;
const fields=['createdAt','device','deviceFingerprint','devicePublicKey','epoch',
  'fingerprint','nonce','publicKey','version'];
const text=new TextEncoder();
const denied=()=>{throw new Error('e2ee_enrollment_rejected');};

export function validEnrollmentCode(value){
  return typeof value==='string'&&codePattern.test(value);
}
export async function checkEnrollmentIntent(intent,{device,publicKey,fingerprint,epoch,now=Date.now()}={}){
  if(!intent||typeof intent!=='object'||Array.isArray(intent)||
      Object.keys(intent).sort().join(',')!==[...fields,...(intent.permission===undefined?[]:['permission'])].sort().join(',')||
      (intent.permission!==undefined&&!['read','desktop','assistant'].includes(intent.permission))||
      intent.version!==ENROLL_VERSION||intent.device!==device||
      !/^[0-9a-f-]{36}$/i.test(intent.device||'')||
      intent.devicePublicKey!==publicKey||intent.deviceFingerprint!==fingerprint||
      intent.epoch!==epoch||typeof intent.epoch!=='string'||intent.epoch.length>128||
      !/^[A-Za-z0-9_-]{22}$/.test(intent.nonce||'')||
      !Number.isSafeInteger(intent.createdAt)||!Number.isSafeInteger(now)||
      intent.createdAt>now+15_000||intent.createdAt+ENROLL_TTL_MS<=now||
      !/^[0-9a-f]{64}$/.test(intent.fingerprint||'')||
      !/^[0-9a-f]{64}$/.test(intent.deviceFingerprint||''))denied();
  try{
    if(await e2eeFingerprint(intent.publicKey)!==intent.fingerprint||
        await e2eeFingerprint(intent.devicePublicKey)!==intent.deviceFingerprint)denied();
  }catch{denied();}
  const transcript=JSON.stringify([ENROLL_VERSION,intent.device,intent.epoch,
    intent.deviceFingerprint,intent.fingerprint,intent.nonce,intent.createdAt,
    ...(intent.permission===undefined?[]:[intent.permission])]);
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',text.encode(transcript)));
  const raw=Array.from(hash.subarray(0,8),byte=>byte.toString(16).padStart(2,'0')).join('').toUpperCase();
  return raw.match(/.{4}/g).join('-');
}
export async function createEnrollmentIntent({browser,descriptor,device,permission,now=Date.now()}){
  if(!browser?.publicKey||!descriptor?.publicKey)denied();
  const nonce=new Uint8Array(16);crypto.getRandomValues(nonce);
  const intent={version:ENROLL_VERSION,device,devicePublicKey:descriptor.publicKey,
    deviceFingerprint:descriptor.fingerprint,epoch:descriptor.epoch,
    publicKey:browser.publicKey,fingerprint:browser.fingerprint,
    nonce:BufferlessBase64(nonce),createdAt:now,...(permission===undefined?{}:{permission})};
  const code=await checkEnrollmentIntent(intent,{
    device,publicKey:descriptor.publicKey,fingerprint:descriptor.fingerprint,epoch:descriptor.epoch,now});
  return {intent,code};
}
function BufferlessBase64(bytes){
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
