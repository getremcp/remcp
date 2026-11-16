// Source-only optional media installation. The owner chooses a local Python.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {VERSION} from '../version.mjs';

function execute(command,args,{input,inherit=false,timeout=300000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:inherit?['pipe','inherit','inherit']:['pipe','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('Media installation command timed out'));},timeout);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.stdout?.on('data',chunk=>{stdout+=chunk;if(stdout.length>65536)child.kill();});
    child.stderr?.on('data',chunk=>{stderr+=chunk;if(stderr.length>65536)child.kill();});
    child.once('close',code=>{clearTimeout(timer);code===0?resolve(stdout):reject(new Error('Media dependency command failed ('+code+'). '+stderr.slice(-500)));});
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
function packageSource(entry){
  const directory=path.join(path.dirname(entry),'native','webrtc');
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'source-manifest.json'),'utf8'));
  if(manifest.version!==1||manifest.protocol!=='remcp-media-stdio-v1'||
      !manifest.files||!Object.hasOwn(manifest.files,'worker_stdio.py')||
      !Object.hasOwn(manifest.files,'requirements.lock'))throw new Error('Media source manifest unavailable');
  for(const [name,hash] of Object.entries(manifest.files)){
    if(!/^[a-z_]+\.py$/.test(name)&&name!=='requirements.lock')throw new Error('Invalid media source file');
    const filename=path.join(directory,name),info=fs.lstatSync(filename);
    if(!info.isFile()||info.isSymbolicLink()||
        process.platform!=='win32'&&((info.mode&0o022)!==0||![0,process.getuid()].includes(info.uid))||
        createHash('sha256').update(fs.readFileSync(filename)).digest('hex')!==hash)
      throw new Error('Media source integrity check failed');
  }
  return directory;
}
async function privateDirectory(directory){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  if(process.platform!=='win32'){fs.chmodSync(directory,0o700);return;}
  const shell=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  await execute(shell,['-NoProfile','-NonInteractive','-Command',`
$ErrorActionPreference='Stop'
$p=[Console]::In.ReadToEnd()
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
foreach($id in @($sid.Value,'S-1-5-18','S-1-5-32-544')){
 $rule=New-Object Security.AccessControl.FileSystemAccessRule(
  (New-Object Security.Principal.SecurityIdentifier($id)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
 $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $p -AclObject $acl
`],{input:directory,timeout:15000});
}
// Object spreads lose Windows process.env's case-insensitive lookup behavior.
export function desktopMediaPlatformEnvironment(env=process.env,platform=process.platform){
  if(platform!=='win32')return {};
  const value=name=>Object.entries(env).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1]||'';
  const systemRoot=value('SystemRoot')||value('WINDIR');
  return {SystemRoot:systemRoot,WINDIR:systemRoot,LOCALAPPDATA:value('LOCALAPPDATA')};
}
export function desktopMediaNativeSource(env=process.env,platform=process.platform){
  if(platform==='linux')return !env.WAYLAND_DISPLAY&&env.XDG_SESSION_TYPE!=='wayland'&&
    /^:[0-9]{1,3}(?:\.[0-9]{1,2})?$/.test(env.DISPLAY||'')?'x11':'portal';
  return {darwin:'avfoundation',win32:'gdigrab'}[platform];
}
export function desktopMediaEnvironment(profile,runtimeEntry){
  if(profile===undefined)return {};
  if(profile?.enabled!==true)return {REMCP_WEBRTC_RUNTIME_PILOT:'0'};
  if(profile.version!==1||profile.protocol!=='remcp-media-stdio-v1'||
      typeof profile.python!=='string'||!path.isAbsolute(profile.python)||
      !fs.existsSync(profile.python))return {REMCP_WEBRTC_RUNTIME_PILOT:'0'};
  try{
    const directory=packageSource(runtimeEntry);
    return {...desktopMediaPlatformEnvironment(),REMCP_WEBRTC_RUNTIME_PILOT:'1',REMCP_WEBRTC_FROZEN_WORKER:'',
      REMCP_WEBRTC_ALLOW_TEST_SOURCE:'0',REMCP_WEBRTC_WINDOWS_PRIVATE_TURN_QA:'0',
      REMCP_WEBRTC_PYTHON:profile.python,
      REMCP_WEBRTC_WORKER_SCRIPT:path.join(directory,'worker_stdio.py'),
      REMCP_WEBRTC_DEV_SOURCE:desktopMediaNativeSource()};
  }catch{return {REMCP_WEBRTC_RUNTIME_PILOT:'0'};}
}
export async function installDesktopMedia({python,runtimeEntry,directory,run=execute}){
  if(typeof python!=='string'||!path.isAbsolute(python)||!fs.existsSync(python))
    throw new Error('Use --python with the absolute path to a trusted Python 3.11–3.14 installation');
  if(typeof directory!=='string'||!path.isAbsolute(directory))throw new Error('Private media install directory required');
  const source=packageSource(runtimeEntry);
  const version=JSON.parse(await run(python,['-c','import json,sys; print(json.dumps(list(sys.version_info[:2])))'],{timeout:15000}));
  if(version[0]!==3||version[1]<11||version[1]>14)throw new Error('This media release requires Python 3.11–3.14');
  const base=path.join(directory,'desktop-media',VERSION+'-'+randomUUID());
  await privateDirectory(base);
  const venv=path.join(base,'venv');
  await run(python,['-m','venv',venv],{inherit:true});
  const executable=path.join(venv,process.platform==='win32'?'Scripts':'bin',process.platform==='win32'?'python.exe':'python');
  await run(executable,['-m','pip','install','--disable-pip-version-check','--only-binary=:all:',
    '--require-hashes','-r',path.join(source,'requirements.lock')],{inherit:true});
  const probe=path.join(source,'install_probe.py');
  await run(executable,[probe,'--source',desktopMediaNativeSource()],{timeout:20000});
  return {version:1,protocol:'remcp-media-stdio-v1',enabled:true,python:executable,installedVersion:VERSION};
}
