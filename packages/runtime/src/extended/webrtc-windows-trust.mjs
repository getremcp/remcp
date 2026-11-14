// Windows ACL gate for experimental native screen workers. POSIX mode bits
// are synthetic (typically 0666) on NTFS and must NOT determine trust.
import {spawnSync} from 'node:child_process';
import {lstatSync} from 'node:fs';
import path from 'node:path';

const VERIFY_SCRIPT=String.raw`
$ErrorActionPreference = 'Stop'
try {
  $target = $env:REMCP_WEBRTC_VERIFY_FILE
  $root = $env:REMCP_WEBRTC_VERIFY_ROOT
  $self = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowed = @($self, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0')
  # Ownership grants implicit WRITE_DAC on NTFS even if the owner has
  # no explicit writable ACE. Do not trust a file owned by a foreign SID.
  $trustedOwners = @($self, 'S-1-5-18', 'S-1-5-32-544')
  $write = [int][Security.AccessControl.FileSystemRights]::WriteData -bor
    [int][Security.AccessControl.FileSystemRights]::AppendData -bor
    [int][Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [int][Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [int][Security.AccessControl.FileSystemRights]::Delete -bor
    [int][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [int][Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [int][Security.AccessControl.FileSystemRights]::TakeOwnership
  $item = $target
  while ($true) {
    $entry = Get-Item -LiteralPath $item -Force
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 3 }
    $acl = Get-Acl -LiteralPath $item
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin $trustedOwners) { exit 7 }
    foreach ($rule in $acl.Access) {
      if ($rule.AccessControlType -ne 'Allow') { continue }
      if (([int]$rule.FileSystemRights -band $write) -eq 0) { continue }
      $sid = $rule.IdentityReference.Translate(
        [Security.Principal.SecurityIdentifier]).Value
      if ($sid -notin $allowed) { exit 4 }
    }
    if ([string]::Equals($item, $root,
        [StringComparison]::OrdinalIgnoreCase)) { break }
    $parent = Split-Path -Path $item -Parent
    if (!$parent -or $parent -eq $item) { exit 5 }
    $item = $parent
  }
  'VERIFIED'
} catch {
  exit 6
}
`;

export function windowsNativeWorkerTrusted(filename,{
  env=process.env,run=spawnSync,statFile=lstatSync,now=Date.now,
  cache=null,extension='.py',timeoutMs=3500,
}={}){
  if(typeof filename!=='string'||!path.win32.isAbsolute(filename)||
     typeof env.LOCALAPPDATA!=='string'||!path.win32.isAbsolute(env.LOCALAPPDATA)||
     !env.SystemRoot||!Number.isSafeInteger(timeoutMs)||
     timeoutMs<500||timeoutMs>10_000)return false;
  const root=path.win32.resolve(env.LOCALAPPDATA,'ReMCP');
  const absolute=path.win32.resolve(filename);
  if(!['.py','.exe','.json'].includes(extension)||
     !absolute.toLowerCase().startsWith((root+'\\').toLowerCase())||
     path.win32.extname(absolute).toLowerCase()!==extension)return false;
  try{
    const info=statFile(absolute);
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)return false;
    const stamp=absolute+'|'+info.size+'|'+info.mtimeMs+'|'+extension+'|'+timeoutMs;
    if(cache?.stamp===stamp&&now()-cache.checkedAt<5_000)
      return cache.valid;
    const exe=path.win32.join(env.SystemRoot,'System32',
      'WindowsPowerShell','v1.0','powershell.exe');
    const result=run(exe,['-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(VERIFY_SCRIPT,'utf16le').toString('base64')],{
      encoding:'utf8',timeout:timeoutMs,windowsHide:true,maxBuffer:4096,
      env:{
        SystemRoot:env.SystemRoot,WINDIR:env.WINDIR||env.SystemRoot,
        PATH:env.PATH||'',PSModulePath:env.PSModulePath||'',
        REMCP_WEBRTC_VERIFY_FILE:absolute,
        REMCP_WEBRTC_VERIFY_ROOT:root,
      },
    });
    const valid=result.status===0&&result.stdout.trim()==='VERIFIED';
    if(cache)Object.assign(cache,{stamp,checkedAt:now(),valid});
    return valid;
  }catch{return false;}
}

export const windowsWorkerAclCache={};
