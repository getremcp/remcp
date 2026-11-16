// Secrets are held by the current OS user: Keychain, Secret Service, or DPAPI.
// Never place a secret in process arguments or fall back to a plaintext file.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {configDir} from './env.mjs';
import {createMacE2eeStore} from './e2ee-keychain.mjs';

const SERVICE='site.remcp.e2ee', LIMIT=128*1024;
const unavailable=()=>new Error('E2EE OS vault unavailable or locked; unlock Keychain/Secret Service, or sign in as the Windows owner.');

// MCP stdio hosts commonly inherit only HOME, PATH and USER. Recover the
// current Linux user's own session bus without contacting another user's bus
// or falling back to a plaintext identity file.
export async function linuxSecretServiceEnvironment({
  environment=process.env,uid=process.getuid?.(),lstat=fs.lstat,
}={}){
  if(environment.DBUS_SESSION_BUS_ADDRESS)return environment;
  if(!Number.isSafeInteger(uid)||uid<0)throw unavailable();
  const directory=environment.XDG_RUNTIME_DIR||'/run/user/'+uid;
  if(!path.posix.isAbsolute(directory))throw unavailable();
  const bus=path.posix.join(directory,'bus');
  try{
    const [dirStat,busStat]=await Promise.all([lstat(directory),lstat(bus)]);
    if(!dirStat.isDirectory()||dirStat.isSymbolicLink()||dirStat.uid!==uid||
        (dirStat.mode&0o077)!==0||!busStat.isSocket()||busStat.isSymbolicLink()||
        busStat.uid!==uid)throw unavailable();
  }catch{throw unavailable();}
  return {...environment,XDG_RUNTIME_DIR:directory,
    DBUS_SESSION_BUS_ADDRESS:'unix:path='+bus};
}
function run(command,args,input='',options={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:['pipe','pipe','pipe'],windowsHide:true,...options});
    let output='',size=0,settled=false;
    const timer=setTimeout(()=>{child.kill();finish(unavailable());},15000);
    function finish(error,value){if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);}
    child.on('error',()=>finish(unavailable()));
    child.stdin.on('error',()=>{});
    child.stdout.on('data',chunk=>{
      size+=chunk.length;if(size>LIMIT){child.kill();finish(unavailable());}
      else output+=chunk;
    });
    // security(1) prompts may contain diagnostic output; never forward it or
    // child input to logs, errors, telemetry, or the remote runtime.
    child.stderr.resume();
    child.on('close',code=>finish(null,{code,output}));
    child.stdin.end(input);
  });
}
const dpapiScript=`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Security
try {
 $r=[Console]::In.ReadToEnd()|ConvertFrom-Json
 $entropy=[Text.Encoding]::UTF8.GetBytes('site.remcp.e2ee:'+ $r.account)
 if ($r.operation -eq 'seal') {
  $raw=[Text.Encoding]::UTF8.GetBytes($r.value)
  $sealed=[Security.Cryptography.ProtectedData]::Protect($raw,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($sealed))
 } elseif ($r.operation -eq 'open') {
  $raw=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($r.ciphertext),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($raw))
 } else {exit 1}
} catch {exit 1}
`;
async function dpapi(request) {
  const root=process.env.SystemRoot||'C:\\Windows';
  const result=await run(path.win32.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe'),
    ['-NoLogo','-NoProfile','-NonInteractive','-Command',dpapiScript],JSON.stringify(request));
  if(result.code!==0||!result.output)throw unavailable();return result.output;
}
export function createE2eeVault({directory=configDir,profile='device'}={}) {
  if(!['device','client'].includes(profile))throw new Error('Invalid E2EE vault profile');
  const account=createHash('sha256').update(path.resolve(directory)+':'+profile).digest('hex');
  const file=path.join(directory,'e2ee-'+profile+'.dpapi');
  if(process.platform==='darwin')return createMacE2eeStore({run,service:SERVICE,account,directory,profile,unavailable});
  async function secretTool() {
    for(const executable of ['/usr/bin/secret-tool',path.join(os.homedir(),'.local','bin','secret-tool')]){
      try{
        const stat=await fs.lstat(executable);
        if(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o022)===0&&
            [0,process.getuid()].includes(stat.uid))return executable;
      }catch{/* Try the fixed owner-local installation location next. */}
    }
    throw unavailable();
  }
  async function read() {
    let result;
    if(process.platform==='linux'){
      result=await run(await secretTool(),['lookup','service',SERVICE,'account',account],
        '',{env:await linuxSecretServiceEnvironment()});
      if(result.code===1&&!result.output)return null;
    } else if(process.platform==='win32'){
      let ciphertext;
      try {
        const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>LIMIT)throw unavailable();
        ciphertext=await fs.readFile(file,'utf8');
      }catch(error){if(error.code==='ENOENT')return null;throw error;}
      return JSON.parse(await dpapi({operation:'open',account,ciphertext}));
    } else throw unavailable();
    if(result.code!==0||!result.output)throw unavailable();
    try{return JSON.parse(result.output.trim());}catch{throw unavailable();}
  }
  async function write(value) {
    const text=JSON.stringify(value);
    if(!text||Buffer.byteLength(text)>48*1024)throw new Error('E2EE vault record too large');
    let result;
    if(process.platform==='linux'){
      result=await run(await secretTool(),['store','--label=ReMCP E2EE '+profile,'service',SERVICE,'account',account],
        text+'\n',{env:await linuxSecretServiceEnvironment()});
    }else if(process.platform==='win32'){
      const ciphertext=await dpapi({operation:'seal',account,value:text});
      await fs.mkdir(directory,{recursive:true,mode:0o700});
      const stat=await fs.lstat(directory);
      if(!stat.isDirectory()||stat.isSymbolicLink())throw unavailable();
      const temporary=file+'.'+randomUUID()+'.tmp';
      try {
        await fs.writeFile(temporary,ciphertext,{mode:0o600,flag:'wx'});
        await fs.rename(temporary,file);
      }finally{await fs.rm(temporary,{force:true});}
      return;
    }else throw unavailable();
    if(result.code!==0)throw unavailable();
    // An unavailable/locked wallet must not appear initialized successfully.
    const saved=await read();
    if(JSON.stringify(saved)!==text)throw unavailable();
  }
  async function remove() {
    let result;
    if(process.platform==='linux')result=await run(await secretTool(),['clear','service',SERVICE,'account',account],
      '',{env:await linuxSecretServiceEnvironment()});
    else if(process.platform==='win32'){await fs.rm(file,{force:true});return;}
    else throw unavailable();
    if(result.code!==0&&result.code!==44&&result.code!==1)throw unavailable();
  }
  return {read,write,remove};
}
