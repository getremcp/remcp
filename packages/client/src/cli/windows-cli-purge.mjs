import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export function windowsCliWrapperText() {
  return ['@echo off', 'setlocal DisableDelayedExpansion',
    'set "NPM_CONFIG_PREFIX=%LOCALAPPDATA%\\ReMCP\\runtime"',
    'set "PATH=%LOCALAPPDATA%\\ReMCP\\runtime;%PATH%"',
    'call "%LOCALAPPDATA%\\ReMCP\\runtime\\remcp.cmd" %*',
    'exit /b %ERRORLEVEL%', ''].join('\r\n');
}

// Read the unexpanded value and retain its registry type, including REG_EXPAND_SZ.
// Do not rewrite the machine PATH or remove any other user's entries.
export const removeWindowsCliPathScript = String.raw`
$ErrorActionPreference = 'Stop'
$bin = [IO.Path]::Combine($env:LOCALAPPDATA, 'ReMCP', 'bin')
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($null -eq $key) { exit 0 }
try {
  $raw = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($null -eq $raw) { exit 0 }
  $kind = $key.GetValueKind('Path')
  if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String -and
      $kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) { throw 'Unexpected user PATH type' }
  $kept = @($raw.Split(';') | Where-Object { $_.TrimEnd('\') -ine $bin.TrimEnd('\') })
  $next = $kept -join ';'
  if ($next -cne $raw) { $key.SetValue('Path', $next, $kind) }
} finally { $key.Dispose() }
`;

export function removeWindowsCliCommand({localAppData = process.env.LOCALAPPDATA, runner = spawnSync} = {}) {
  if (!localAppData) return;
  const wrapper = path.join(localAppData, 'ReMCP', 'bin', 'remcp.cmd');
  let stat;
  try { stat = fs.lstatSync(wrapper); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  if (!stat.isFile() || stat.size > 4096 ||
      fs.realpathSync(wrapper).toLowerCase() !== path.resolve(wrapper).toLowerCase() ||
      fs.readFileSync(wrapper, 'utf8') !== windowsCliWrapperText()) return;
  const result = runner('powershell.exe', ['-NoProfile', '-NonInteractive',
    '-EncodedCommand', Buffer.from(removeWindowsCliPathScript, 'utf16le').toString('base64')],
  {encoding:'utf8', windowsHide:true, timeout:15000, env:{...process.env, LOCALAPPDATA:localAppData}});
  if (result.status !== 0) throw new Error('Could not remove the ReMCP user PATH entry', {cause:result.error});
  const current = fs.lstatSync(wrapper);
  if (current.dev !== stat.dev || current.ino !== stat.ino || !current.isFile() ||
      fs.readFileSync(wrapper, 'utf8') !== windowsCliWrapperText()) throw new Error('ReMCP wrapper changed during purge');
  fs.unlinkSync(wrapper);
}
