// First enrollment is confirmed on the owner's desktop, never by a relay reply.
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {access} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {manageE2eePeer} from './e2ee-identity.mjs';
import {validEnrollmentCode,ENROLL_TTL_MS} from '../e2ee-enrollment-code.mjs';

export const DESKTOP_E2EE_TOOLS=Object.freeze(['get_system_info','desktop_webrtc_offer',
  'desktop_webrtc_status','desktop_webrtc_control','desktop_webrtc_heartbeat','desktop_webrtc_stop']);

export const AI_DESKTOP_E2EE_TOOLS=Object.freeze([...DESKTOP_E2EE_TOOLS,
  'computer_snapshot','computer_action','list_windows','window_action','launch_app',
  'ui_snapshot','ui_find','ui_action','type_text','keyboard','pointer','drag_drop','scroll',
  'wait_for_ui','clipboard','display_inventory','screenshot_region','take_screenshot']);

export async function nativeEnrollmentDialog(code,{platform=process.platform,environment=process.env,
  signal,spawnChild=spawn,desktop=false,assistant=false,comparison=false,
  canExecute=async binary=>{try{await access(binary,constants.X_OK);return true;}catch{return false;}},
}={}){
  if(!validEnrollmentCode(code))return Promise.reject(new Error('Invalid enrollment code'));
  const permission=assistant?'Allow an AI client to read the screen and operate applications using mouse, keyboard and clipboard':desktop?'View screen, use mouse and keyboard, and transfer clipboard text':
    'Read basic system information only';
  const target=assistant?'AI desktop client':'browser',allowLabel=comparison?'Codes match':assistant?'Allow AI client':'Allow browser';
  const message=comparison?'Connect your AI client securely to ReMCP?\n\nCompare this code with the ReMCP window on the paired device:\n'+code+'\n\nThis request allows the AI client to read the screen and operate applications using mouse, keyboard and clipboard. No direct terminal or file API is granted.\n\nApprove on the paired device only if the codes match, then confirm here.\nDecline if you did not request this.':'Allow this '+target+' to connect securely to ReMCP?\n\nCompare this code with the '+target+':\n'+
    code+'\n\n'+permission+'.\nNo direct terminal or file API is granted.\nDecline if you did not request this.';
  let executable,args,input='';
  if(platform==='darwin'){
    executable='/usr/bin/osascript';args=['-','ReMCP encrypted connection',message,allowLabel];
    input='on run argv\ntry\ndisplay dialog (item 2 of argv) with title (item 1 of argv) buttons {"Decline", item 3 of argv} default button "Decline" cancel button "Decline" giving up after 120\nif gave up of result then return "denied"\nreturn "approved"\non error\nreturn "denied"\nend try\nend run\n';
  }else if(platform==='linux'){
    // GNOME and KDE do not share a guaranteed installed dialog helper.
    // Check only fixed system binaries: never execute a shell or PATH lookup.
    if(await canExecute('/usr/bin/zenity')){
      executable='/usr/bin/zenity';args=['--question','--no-markup','--title=ReMCP encrypted connection',
        '--text='+message,'--ok-label='+allowLabel,'--cancel-label=Decline','--default-cancel','--timeout=120','--width=430'];
    }else if(await canExecute('/usr/bin/kdialog')){
      executable='/usr/bin/kdialog';args=['--title','ReMCP encrypted connection','--yesno',message,
        '--yes-label',allowLabel,'--no-label','Decline'];
    }else return false; // Headless desktop: explicit owner-local CLI remains available.
  }else if(platform==='win32'){
    executable=path.win32.join(environment.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    // The script is fixed; the message is data read through private stdin.
    args=['-NoLogo','-NoProfile','-NonInteractive','-Command',
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName PresentationFramework; "+
      "$m=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); "+
      "$r=[Windows.MessageBox]::Show($m,'ReMCP encrypted connection','YesNo','Question','No'); "+
      "if($r -eq 'Yes'){[Console]::Out.Write('approved')}else{exit 1}"];
    input=Buffer.from(message).toString('base64');
  }else return Promise.resolve(false);
  return new Promise(resolve=>{
    if(signal?.aborted){resolve(false);return;}
    let child,output='',finished=false;
    const finish=value=>{
      if(finished)return;finished=true;clearTimeout(timer);
      signal?.removeEventListener('abort',cancel);resolve(value);
    };
    const cancel=()=>{try{child?.kill();}catch{}finish(false);};
    const timer=setTimeout(cancel,Math.min(120_000,ENROLL_TTL_MS));
    try{
      child=spawnChild(executable,args,{env:environment,stdio:['pipe','pipe','pipe'],windowsHide:true});
      child.stdin.on('error',()=>{});child.stdin.end(input);
      child.stderr.resume();
      child.stdout.on('data',part=>{output+=part;if(output.length>64)cancel();});
      child.once('error',()=>finish(false));
      child.once('close',exit=>finish(exit===0&&(platform==='linux'||output.trim()==='approved')));
      signal?.addEventListener('abort',cancel,{once:true});
    }catch{finish(false);}
  });
}

export function startNativeE2eeEnrollment({endpoint,config,directory,
  confirm=nativeEnrollmentDialog,grant=manageE2eePeer}={}){
  let active=null,activeCode=null,closed=false;
  endpoint.setEnrollmentCancelHandler(code=>{
    if(activeCode===code)active?.abort();
  });
  endpoint.setEnrollmentHandler(async({intent,code})=>{
    // One visible request at a time. Never queue invisible approvals.
    if(closed||active){endpoint.rejectEnrollment(code);return;}
    const controller=new AbortController();active=controller;activeCode=code;
    const timer=setTimeout(()=>controller.abort(),Math.max(1,intent.createdAt+ENROLL_TTL_MS-Date.now()));
    try{
      const assistant=intent.permission==='assistant',desktop=assistant||intent.permission==='desktop';
      if(!await confirm(code,{signal:controller.signal,desktop,assistant})||controller.signal.aborted||closed)return;
      await endpoint.approveEnrollment(code,(request,approval)=>grant(config,'trust',{
        fingerprint:request.fingerprint,'public-key':request.publicKey,
        mode:desktop?'control':'read',tools:(assistant?AI_DESKTOP_E2EE_TOOLS:desktop?DESKTOP_E2EE_TOOLS:['get_system_info']).join(','),
        label:assistant?'AI desktop client (local approval)':desktop?'Browser desktop (local approval)':'Browser (local approval)',
      },{directory,expectedDeviceKey:request.devicePublicKey,...approval}));
    }catch{/* No authorization on failed dialog, expiry or locked OS vault. */}
    finally{
      clearTimeout(timer);endpoint.rejectEnrollment(code);
      if(active===controller){active=null;activeCode=null;}
    }
  });
  endpoint.setEnrollmentListening(true);
  return {close(){closed=true;active?.abort();endpoint.setEnrollmentListening(false);
    endpoint.setEnrollmentHandler(null);endpoint.setEnrollmentCancelHandler(null);}};
}
