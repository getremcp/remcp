// ReMCP's private Windows npm prefix is called from both cmd.exe and PowerShell.
// npm generates both remcp.cmd and remcp.ps1, but PowerShell prefers the .ps1
// even when ExecutionPolicy=Restricted. That makes a successful installation
// appear broken. Keep the batch shim, and remove only the recognizable npm shim.
import fs from 'node:fs';
import path from 'node:path';

// Exact npm cmd-shim template; partial markers cannot establish ownership.
export const WINDOWS_NPM_POWERSHELL_SHIM = String.raw`#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  # Fix case when both the Windows and Linux builds of Node
  # are installed in the same directory
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe"  "$basedir/node_modules/@remcp/remcp/bin/remcp.mjs" $args
  } else {
    & "$basedir/node$exe"  "$basedir/node_modules/@remcp/remcp/bin/remcp.mjs" $args
  }
  $ret=$LASTEXITCODE
} else {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "node$exe"  "$basedir/node_modules/@remcp/remcp/bin/remcp.mjs" $args
  } else {
    & "node$exe"  "$basedir/node_modules/@remcp/remcp/bin/remcp.mjs" $args
  }
  $ret=$LASTEXITCODE
}
exit $ret
`;

function normalizedShim(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

function sameFileIdentity(a,b) {
  return a.isFile() && b.isFile() && !b.isSymbolicLink() &&
    a.nlink===1n && b.nlink===1n && a.dev===b.dev && a.ino===b.ino &&
    a.size===b.size && a.mtimeNs===b.mtimeNs && a.ctimeNs===b.ctimeNs;
}
function readPinnedShim(file) {
  const flags=fs.constants.O_RDONLY | (process.platform==='win32'?0:
    (fs.constants.O_NOFOLLOW||0)|(fs.constants.O_NONBLOCK||0));
  const named=fs.lstatSync(file,{bigint:true});
  if(!named.isFile()||named.isSymbolicLink()||named.nlink!==1n||named.size>16000n)
    throw new Error('Refusing unknown or unsafe ReMCP launcher');
  const fd=fs.openSync(file,flags);
  try {
    const pinned=fs.fstatSync(fd,{bigint:true});
    if(!sameFileIdentity(pinned,named))throw new Error('ReMCP launcher changed before read');
    const buffer=Buffer.alloc(16001);let used=0;
    while(used<buffer.length){const n=fs.readSync(fd,buffer,used,buffer.length-used,used);if(!n)break;used+=n;}
    if(BigInt(used)!==pinned.size||!sameFileIdentity(pinned,fs.fstatSync(fd,{bigint:true}))||
      !sameFileIdentity(pinned,fs.lstatSync(file,{bigint:true})))throw new Error('ReMCP launcher changed during read');
    return buffer.toString('utf8',0,used);
  }finally{fs.closeSync(fd);}
}
export function assertWindowsNpmPowerShellShimOwned(prefix) {
  const powershell = path.join(prefix, 'remcp.ps1');
  try { fs.lstatSync(powershell); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  const contents=readPinnedShim(powershell);
  if(normalizedShim(contents)!==normalizedShim(WINDOWS_NPM_POWERSHELL_SHIM))
    throw new Error('Refusing to remove a non-npm ReMCP PowerShell launcher');
  return true;
}

export function preferWindowsCmdShim(prefix) {
  if (!assertWindowsNpmPowerShellShimOwned(prefix)) return false;
  const batch = path.join(prefix, 'remcp.cmd');
  const powershell = path.join(prefix, 'remcp.ps1');
  let batchStat;
  try { batchStat = fs.lstatSync(batch); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    throw new Error('Cannot remove the PowerShell launcher without a ReMCP .cmd launcher');
  }
  if (!batchStat.isFile() || batchStat.isSymbolicLink()) {
    throw new Error('Cannot remove the PowerShell launcher without a trusted ReMCP .cmd launcher');
  }
  if(!assertWindowsNpmPowerShellShimOwned(prefix))throw new Error('PowerShell launcher changed before removal');
  const stage=fs.mkdtempSync(path.join(prefix,'.remcp-shim-release-'));
  const isolated=path.join(stage,'remcp.ps1');
  try { fs.renameSync(powershell,isolated); }
  catch(error){try{fs.rmdirSync(stage);}catch{}throw error;}
  // Preserve unexpected content, rather than unlinking a mutable shared path.
  if(normalizedShim(readPinnedShim(isolated))!==normalizedShim(WINDOWS_NPM_POWERSHELL_SHIM))
    throw new Error('PowerShell launcher changed before removal; isolated evidence retained at '+stage);
  fs.unlinkSync(isolated);
  fs.rmdirSync(stage);
  return true;
}


// An older auto-updater can install a newer client without running that newer
// client's post-npm shim cleanup. Repair the canonical npm-owned shadow at
// agent startup so a Windows account using Restricted PowerShell remains usable.
// Do not touch arbitrary prefixes, custom scripts, links or nonstandard shims.
export const WINDOWS_NPM_CMD_SHIM = String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@remcp\remcp\bin\remcp.mjs" %*
`;

function sameCanonicalFile(actual, expected) {
  if (!actual || !expected) return false;
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (!same(actual, expected)) return false;
  let fd;
  try {
    // Pin a real executable/source file before inspecting mutable path names.
    // A Windows reparse point must also be rejected by the post-open lstat.
    const unixFlags=process.platform==='win32'?0:
      (fs.constants.O_NOFOLLOW||0)|(fs.constants.O_NONBLOCK||0);
    fd=fs.openSync(expected,fs.constants.O_RDONLY|unixFlags);
    const pinned=fs.fstatSync(fd,{bigint:true});
    const sameIdentity=stat=>stat.isFile()&&!stat.isSymbolicLink()&&
      stat.dev===pinned.dev&&stat.ino===pinned.ino&&
      stat.size===pinned.size&&stat.mtimeNs===pinned.mtimeNs&&
      stat.ctimeNs===pinned.ctimeNs;
    if(!sameIdentity(pinned)||!sameIdentity(fs.lstatSync(expected,{bigint:true})))
      return false;
    // Canonicalize parents too, preventing startup repair through symlinks.
    if(!same(fs.realpathSync(expected),expected))return false;
    return sameIdentity(fs.lstatSync(expected,{bigint:true}))&&
      sameIdentity(fs.fstatSync(fd,{bigint:true}));
  } catch { return false; }
  finally { if(fd!==undefined)fs.closeSync(fd); }
}

export function repairManagedWindowsPowerShellShimOnStart({
  platform = process.platform,
  localAppData = process.env.LOCALAPPDATA,
  nodePath = process.execPath,
  cliEntry = process.argv[1],
} = {}) {
  if (platform !== 'win32' || !localAppData || !path.isAbsolute(localAppData)) return false;
  const prefix = path.join(localAppData, 'ReMCP', 'runtime');
  const expectedNode = path.join(prefix, 'node.exe');
  const expectedCli = path.join(prefix, 'node_modules', '@remcp', 'remcp', 'bin', 'remcp.mjs');
  if (!sameCanonicalFile(nodePath, expectedNode) || !sameCanonicalFile(cliEntry, expectedCli)) return false;

  const directory = fs.lstatSync(prefix);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('Refusing Windows launcher self-repair outside a real managed runtime directory');
  }
  if (!assertWindowsNpmPowerShellShimOwned(prefix)) return false;
  const cmdPath = path.join(prefix, 'remcp.cmd');
  const cmdStat = fs.lstatSync(cmdPath);
  if (!cmdStat.isFile() || cmdStat.isSymbolicLink()) {
    throw new Error('Refusing Windows launcher self-repair without a trusted batch shim');
  }
  const cmdBody = readPinnedShim(cmdPath);
  if (normalizedShim(cmdBody) !== normalizedShim(WINDOWS_NPM_CMD_SHIM)) {
    throw new Error('Refusing Windows launcher self-repair for an unrecognized batch shim');
  }
  return preferWindowsCmdShim(prefix);
}
