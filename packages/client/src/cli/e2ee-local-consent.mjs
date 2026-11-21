// Local OS-owner-scoped TTY consent, not a hardware presence guarantee.
// The hosted relay cannot call the private socket directly; processes able to
// execute as this OS user are already within the owner's OS-vault trust boundary.
import process from 'node:process';
import {createInterface} from 'node:readline/promises';
import {requestLocalE2eeApproval} from './e2ee-local-approval.mjs';
import {validEnrollmentCode} from '../e2ee-enrollment-code.mjs';

export async function approveE2eeFromTerminal({code,interactive=Boolean(process.stdin.isTTY&&process.stdout.isTTY),
  ask,request=requestLocalE2eeApproval}={}){
  if(!interactive)throw new Error('Local interactive terminal required for encrypted browser enrollment');
  let reader=null;
  if(!ask){
    reader=createInterface({input:process.stdin,output:process.stdout,terminal:true});
    ask=question=>reader.question(question);
  }
  try{
    const pending=await request('pending');
    if(!Array.isArray(pending.requests)||!pending.requests.length)
      throw new Error('No pending browser requests. Start enrollment in the workspace first.');
    const value=typeof code==='string'?code.trim().toUpperCase():
      String(await ask('Enter the four-part hexadecimal code shown in your browser: ')).trim().toUpperCase();
    if(!validEnrollmentCode(value))throw new Error('Verification code is invalid');
    const confirm=String(await ask('Approve ONLY read-only get_system_info? Type APPROVE: ')).trim();
    if(confirm!=='APPROVE')throw new Error('Enrollment was not approved');
    const result=await request('approve',{code:value});
    if(result?.ok!==true)throw new Error('Enrollment could not be approved. Retry with a fresh request.');
    return {approved:true,mode:'read',tools:['get_system_info']};
  }finally{reader?.close();}
}
