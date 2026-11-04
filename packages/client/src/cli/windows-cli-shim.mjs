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

export function assertWindowsNpmPowerShellShimOwned(prefix) {
  const powershell = path.join(prefix, 'remcp.ps1');
  let metadata;
  try { metadata = fs.lstatSync(powershell); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Refusing to replace an unknown ReMCP PowerShell launcher');
  }
  const contents = fs.readFileSync(powershell, 'utf8');
  if (contents.length > 16000 || normalizedShim(contents) !== normalizedShim(WINDOWS_NPM_POWERSHELL_SHIM)) {
    throw new Error('Refusing to remove a non-npm ReMCP PowerShell launcher');
  }
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
  fs.unlinkSync(powershell);
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
  try {
    return same(actual, expected) && same(fs.realpathSync(actual), expected)
      && same(fs.realpathSync(expected), expected);
  } catch { return false; }
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
  const cmdBody = fs.readFileSync(cmdPath, 'utf8');
  if (normalizedShim(cmdBody) !== normalizedShim(WINDOWS_NPM_CMD_SHIM)) {
    throw new Error('Refusing Windows launcher self-repair for an unrecognized batch shim');
  }
  return preferWindowsCmdShim(prefix);
}
