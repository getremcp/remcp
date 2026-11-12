import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { WINDOWS_INTEROP } from '../native/windows/manifest.mjs';

// Keep loaded DLLs in a transparent, immutable per-release installation store.
// Package directories remain replaceable while the supervisor owns its Job Object.
// A removed installed helper is never silently re-created on the next tool call.
export function windowsInteropLoad(id) {
 const item=WINDOWS_INTEROP[id];
 if(!Object.hasOwn(WINDOWS_INTEROP,id)||!item||!/^[a-f0-9]{64}$/.test(item.sha256)||!/^\d+\.\d+\.\d+$/.test(item.releaseVersion||'')) throw new Error('Unknown or invalid Windows interop helper');
 const quote=value=>String(value).replaceAll("'","''");
 const source=quote(fileURLToPath(new URL('../native/windows/'+item.file,import.meta.url)));
 const root=quote(path.join(process.env.REMCP_CONFIG_DIR||path.join(os.homedir(),'.config','remcp'),'windows-interop',item.releaseVersion,id+'-'+item.sha256));
 return [
  "$ErrorActionPreference='Stop';$remcpSource='"+source+"';$remcpStore='"+root+"';",
  "if(-not(Test-Path -LiteralPath $remcpSource -PathType Leaf)){throw 'REMCP_WINDOWS_PAYLOAD_BLOCKED: ReMCP helper missing'};",
  "if((Get-FileHash -LiteralPath $remcpSource -Algorithm SHA256).Hash.ToLowerInvariant() -cne '"+item.sha256+"'){throw 'REMCP_WINDOWS_PAYLOAD_BLOCKED: ReMCP helper integrity mismatch'};",
  "$remcpDll=Join-Path $remcpStore '"+item.file+"';",
  "$remcpCreator=$false;if(-not(Test-Path -LiteralPath $remcpStore)){[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($remcpStore));try{[void](New-Item -ItemType Directory -Path $remcpStore -ErrorAction Stop);$remcpCreator=$true}catch{if(-not(Test-Path -LiteralPath $remcpStore -PathType Container)){throw 'REMCP_WINDOWS_PAYLOAD_BLOCKED: Helper store unavailable'}}};",
  "if((Get-Item -LiteralPath $remcpStore).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'REMCP_WINDOWS_PAYLOAD_BLOCKED: Unsafe helper store'};",
  "if($remcpCreator){$remcpStage=Join-Path $remcpStore 'installing.dll';try{Copy-Item -LiteralPath $remcpSource -Destination $remcpStage -ErrorAction Stop;if((Get-FileHash -LiteralPath $remcpStage -Algorithm SHA256).Hash.ToLowerInvariant() -cne '"+item.sha256+"'){throw 'Integrity mismatch'};Move-Item -LiteralPath $remcpStage -Destination $remcpDll -ErrorAction Stop}catch{throw 'REMCP_WINDOWS_PAYLOAD_BLOCKED: Helper installation blocked'}};",
  "for($remcpWait=0;$remcpWait -lt 50 -and -not(Test-Path -LiteralPath $remcpDll);$remcpWait++){Start-Sleep -Milliseconds 100};",
  "if(-not(Test-Path -LiteralPath $remcpDll -PathType Leaf)){throw 'REMCP_WINDOWS_PAYLOAD_BLOCKED: Installed helper was removed; security review and an approved replacement are required'};",
  "if((Get-FileHash -LiteralPath $remcpDll -Algorithm SHA256).Hash.ToLowerInvariant() -cne '"+item.sha256+"'){throw 'REMCP_WINDOWS_PAYLOAD_BLOCKED: Installed helper integrity mismatch'};",
  "[void][System.Reflection.Assembly]::LoadFrom($remcpDll);"
 ].join('\n');
}
