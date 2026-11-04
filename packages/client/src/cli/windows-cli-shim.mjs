// ReMCP's private Windows npm prefix is called from both cmd.exe and PowerShell.
// npm generates both remcp.cmd and remcp.ps1, but PowerShell prefers the .ps1
// even when ExecutionPolicy=Restricted. That makes a successful installation
// appear broken. Keep the batch shim, and remove only the recognizable npm shim.
import fs from 'node:fs';
import path from 'node:path';

export function assertWindowsNpmPowerShellShimOwned(prefix) {
  const powershell = path.join(prefix, 'remcp.ps1');
  let metadata;
  try { metadata = fs.lstatSync(powershell); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Refusing to replace an unknown ReMCP PowerShell launcher');
  }
  const contents = fs.readFileSync(powershell, 'utf8');
  if (contents.length > 16000 || !contents.startsWith('#!/usr/bin/env pwsh')
    || !contents.includes('$basedir/node_modules/@remcp/remcp/bin/remcp.mjs')) {
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
