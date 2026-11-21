// Owner-local confirmation transport; never exposed through the hosted relay.
// UNIX socket is reachable only through the current user's private config dir.
// Windows named-pipe security is not yet verified, so this pilot fails closed.
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import {configDir} from './env.mjs';
import {manageE2eePeer} from './e2ee-identity.mjs';
import {validEnrollmentCode} from '../e2ee-enrollment-code.mjs';

const socketName='e2ee-enroll.sock',LIMIT=2048,WINDOW_MS=8000;
const unavailable=()=>new Error('Local E2EE approval socket unavailable. Unlock OS vault and restart the paired agent.');
function socketPath(directory){
  if(process.platform==='win32')throw unavailable();
  const dest=path.resolve(directory);
  if(!path.isAbsolute(dest)||dest.length>180)throw unavailable();
  return path.join(dest,socketName);
}
async function ownerDirectory(directory){
  const stat=await fs.lstat(directory),uid=process.getuid?.();
  if(!Number.isSafeInteger(uid)||!stat.isDirectory()||stat.isSymbolicLink()||
      stat.uid!==uid||(stat.mode&0o077)!==0)throw unavailable();
}
export async function startLocalE2eeApprovalServer({endpoint,config,directory=configDir,
  grant=manageE2eePeer}={}){
  if(!endpoint?.offerEnrollment||!endpoint?.approveEnrollment||!config?.deviceId)throw unavailable();
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  await ownerDirectory(directory);
  const filename=socketPath(directory);
  // Never unlink an existing path: it may be another live agent's socket or
  // a malicious symlink. An owner must resolve a stale socket explicitly.
  try{await fs.lstat(filename);throw unavailable();}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const server=net.createServer(conn=>{
    let text='',settled=false;
    conn.setTimeout(WINDOW_MS);
    const finish=(result)=>{
      if(settled)return;settled=true;
      try{conn.end(JSON.stringify(result)+'\n');}catch{conn.destroy();}
    };
    conn.on('timeout',()=>conn.destroy());
    conn.on('error',()=>conn.destroy());
    conn.on('data',part=>{
      if(settled)return;
      text+=part.toString('utf8');
      if(Buffer.byteLength(text)>LIMIT){conn.destroy();return;}
      if(!text.includes('\n'))return;
      const input=text.slice(0,text.indexOf('\n'));
      void (async()=>{
        try{
          const parsed=JSON.parse(input);
          if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw unavailable();
          if(parsed.operation==='pending'&&Object.keys(parsed).join(',')==='operation'){
            finish({ok:true,requests:endpoint.pendingEnrollments()});return;
          }
          if(parsed.operation!=='approve'||Object.keys(parsed).sort().join(',')!=='code,operation'||
              !validEnrollmentCode(parsed.code))throw unavailable();
          const answer=await endpoint.approveEnrollment(parsed.code,(intent,approval)=>grant(config,'trust',{
            fingerprint:intent.fingerprint,'public-key':intent.publicKey,
            mode:'read',tools:'get_system_info',label:'Browser (local approval)',
          },{directory,expectedDeviceKey:intent.devicePublicKey,...approval}));
          finish({ok:answer.approved===true});
        }catch{finish({ok:false,error:'enrollment_not_authorized'});}
      })();
    });
  });
  try{
    await new Promise((resolve,reject)=>{
      const failure=e=>{server.off('listening',ready);reject(e);};
      const ready=()=>{server.off('error',failure);resolve();};
      server.once('error',failure);server.once('listening',ready);server.listen(filename);
    });
    await fs.chmod(filename,0o600);
    const stat=await fs.lstat(filename);
    if(!stat.isSocket()||stat.uid!==process.getuid()||
        (stat.mode&0o077)!==0)throw unavailable();
    endpoint.setEnrollmentListening(true);
    return {path:filename,close:async()=>{
      endpoint.setEnrollmentListening(false);
      await new Promise(resolve=>server.close(()=>resolve()));
      try{
        const current=await fs.lstat(filename);
        if(current.dev===stat.dev&&current.ino===stat.ino&&current.isSocket())
          await fs.unlink(filename);
      }catch(error){if(error.code!=='ENOENT')throw error;}
    }};
  }catch(error){
    endpoint.setEnrollmentListening(false);
    server.close();
    throw error;
  }
}
export async function requestLocalE2eeApproval(operation,{directory=configDir,code}={}){
  const filename=socketPath(directory);
  await ownerDirectory(directory);
  const stat=await fs.lstat(filename);
  if(!stat.isSocket()||stat.uid!==process.getuid()||
      (stat.mode&0o077)!==0)throw unavailable();
  if(!['approve','pending'].includes(operation)||operation==='approve'&&!validEnrollmentCode(code))
    throw unavailable();
  return new Promise((resolve,reject)=>{
    const client=net.createConnection(filename),payload={operation,
      ...(operation==='approve'?{code}:{})};
    let received='',done=false;
    const finish=(error,value)=>{
      if(done)return;done=true;client.destroy();error?reject(error):resolve(value);
    };
    client.setTimeout(WINDOW_MS);
    client.on('connect',()=>client.write(JSON.stringify(payload)+'\n'));
    client.on('data',chunk=>{
      received+=chunk.toString('utf8');
      if(received.length>LIMIT)return finish(unavailable());
      if(!received.includes('\n'))return;
      try{
        const response=JSON.parse(received.slice(0,received.indexOf('\n')));
        if(!response?.ok)throw unavailable();
        finish(null,response);
      }catch{finish(unavailable());}
    });
    client.on('error',()=>finish(unavailable()));
    client.on('timeout',()=>finish(unavailable()));
    client.on('end',()=>{if(!done)finish(unavailable());});
  });
}
