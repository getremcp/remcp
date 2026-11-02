// Recovery for the signed-in user's interactive ReMCP agent on Windows.
// The desktop UI cannot run in Session 0: this intentionally retains /IT and ONLOGON.
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';

function windowsBatchValue(value) {
  // cmd.exe expands % even inside quoted strings. Escape user-controlled prefix paths.
  return String(value).replaceAll('%', '%%');
}

function windowsBatchLauncherValue(value) {
  // This trusted variable reference must expand at runtime, not become literal %%.
  const runtime = '%LOCALAPPDATA%\\ReMCP\\runtime';
  return value === runtime || value === runtime + '\\remcp.cmd'
    ? value : windowsBatchValue(value);
}

// CMD cannot reliably resolve paths containing characters outside the active OEM
// codepage. Use the Unicode Windows Script Host supervisor instead of batch tasks
// whenever any launcher path contains non-ASCII or command metacharacters.
export function windowsBatchUnsafeProfile(...paths) {
  return paths.some(value => /[^\x20-\x7e]|[&!%^]/.test(String(value || '')));
}

export function windowsServiceLauncherText(cliPath, nodePath, { localAppData = process.env.LOCALAPPDATA } = {}) {
  // Tests can simulate win32 from a POSIX runner with injected temporary paths.
  // Native Windows paths always use win32 parsing; POSIX-shaped fixtures keep their roots.
  const dirname = file => /^[A-Za-z]:[\\/]/.test(file) || file.includes('\\')
    ? path.win32.dirname(file) : path.dirname(file);
  let prefix = dirname(cliPath);
  let nodeDir = dirname(nodePath);
  // .cmd is decoded using the active Windows codepage, not necessarily UTF-8.
  // Keep the body ASCII if the CLI/Node live under this user's managed runtime.
  // This also handles all locale-specific account names and literal %/! in paths.
  if (typeof localAppData === 'string' && localAppData.trim()) {
    const canonical = path.win32.resolve(localAppData, 'ReMCP', 'runtime');
    if (path.win32.normalize(prefix).toLowerCase() === canonical.toLowerCase()) {
      prefix = '%LOCALAPPDATA%\\ReMCP\\runtime';
    }
    if (path.win32.normalize(nodeDir).toLowerCase() === canonical.toLowerCase()) {
      nodeDir = '%LOCALAPPDATA%\\ReMCP\\runtime';
    }
  }
  const safeCliPath = prefix === '%LOCALAPPDATA%\\ReMCP\\runtime'
    ? '%LOCALAPPDATA%\\ReMCP\\runtime\\remcp.cmd' : cliPath;
  if ([prefix, nodeDir, safeCliPath].some(s => /[^\x20-\x7e]/.test(s))) {
    throw new Error('Windows batch launcher cannot safely encode this Unicode path outside the managed runtime');
  }
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `set "NPM_CONFIG_PREFIX=${windowsBatchLauncherValue(prefix)}"`,
    `set "PATH=${windowsBatchLauncherValue(nodeDir)};%PATH%"`,
    ':remcp_restart',
    `call "${windowsBatchLauncherValue(safeCliPath)}" start --service`,
    // Restart even after a clean unexpected exit. A deliberate stop ends the Scheduled Task
    // process tree, so this supervisor cannot resurrect an intentionally stopped service.
    'rem Reconnect after an interrupted upgrade or a transient crash without logging in again.',
    // timeout.exe may fail when Scheduler redirects stdin; loopback ping supplies the delay
    // without stdin, a helper service, or any public network dependency.
    'ping.exe -n 6 127.0.0.1 >nul',
    'goto remcp_restart',
    '',
  ].join('\r\n');
}

export const WINDOWS_STARTUP_MARKER = "' ReMCP managed user startup (do not edit)";

// Start the existing private launcher in the interactive user's session without displaying
// a permanent console window. Do not interpolate the path into cmd.exe or PowerShell.
export function windowsStartupScriptText(nodePath, supervisorPath, cliEntry) {
  for (const value of [nodePath, supervisorPath, cliEntry]) {
    if (typeof value !== 'string' || !value || /["\0\r\n]/.test(value) ||
        !(path.isAbsolute(value) || path.win32.isAbsolute(value))) {
      throw new Error('Invalid ReMCP Windows supervisor path');
    }
  }
  // VBScript quotes each trusted absolute executable/argument path, with no cmd.exe
  // or PowerShell interpolation. The supervisor owns its agent child and IPC endpoint.
  return [
    WINDOWS_STARTUP_MARKER,
    'Set remcpShell = CreateObject("WScript.Shell")',
    `remcpShell.Run Chr(34) & "${nodePath}" & Chr(34) & " " & Chr(34) & "${supervisorPath}" & Chr(34) & " serve " & Chr(34) & "${cliEntry}" & Chr(34), 0, False`,
    '',
  ].join('\r\n');
}

export function windowsStartupScriptInstalled(scriptFile) {
  try {
    const text = fs.readFileSync(scriptFile, 'utf16le');
    const lines = text.replace(/^\uFEFF/, '').split('\r\n');
    if (!text.startsWith('\uFEFF') || lines.length !== 4 ||
        lines[0] !== WINDOWS_STARTUP_MARKER ||
        lines[1] !== 'Set remcpShell = CreateObject("WScript.Shell")' ||
        lines[3] !== '') return false;
    const match = lines[2].match(/^remcpShell\.Run Chr\(34\) & "([^"]+)" & Chr\(34\) & " " & Chr\(34\) & "([^"]+)" & Chr\(34\) & " serve " & Chr\(34\) & "([^"]+)" & Chr\(34\), 0, False$/);
    if (!match) return false;
    const [, node, supervisor, cli] = match;
    const absolute = value => path.isAbsolute(value) || path.win32.isAbsolute(value);
    const basename = value => path.posix.basename(value.replaceAll('\\', '/'));
    return [node, supervisor, cli].every(absolute) &&
      /^(node|node\.exe)$/i.test(basename(node)) &&
      basename(supervisor) === 'windows-user-supervisor.mjs' &&
      basename(cli) === 'remcp.mjs';
  } catch { return false; }
}

export function windowsTaskAbsenceCommand(taskName) {
  if (typeof taskName !== 'string' || !/^[A-Za-z0-9 _-]{1,80}$/.test(taskName)) {
    throw new Error('Invalid Windows task name');
  }
  // Task Scheduler COM gives locale-independent HRESULTs. A failed schtasks /Query
  // is ambiguous: it may mean "access denied" rather than "does not exist".
  const name = taskName.replaceAll("'", "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    '$scheduler = New-Object -ComObject Schedule.Service',
    '$scheduler.Connect()',
    `try { $null = $scheduler.GetFolder('\\').GetTask('${name}'); Write-Output 'PRESENT' }`,
    'catch {',
    '  $e = $_.Exception',
    '  $missing = $false',
    '  while ($null -ne $e) {',
    '    if ($e.HResult -eq -2147024894 -or $e.HResult -eq -2147216625) { $missing = $true; break }',
    '    $e = $e.InnerException',
    '  }',
    "  if ($missing) { Write-Output 'ABSENT' } else { throw }",
    '}',
  ].join('\n');
}

export function windowsTaskReliabilityCommand(taskName) {
  if (typeof taskName !== 'string' || !/^[A-Za-z0-9 _-]{1,80}$/.test(taskName)) {
    throw new Error('Invalid Windows task name');
  }
  const safeName = taskName.replaceAll("'", "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$taskName = '${safeName}'`,
    // Never default to 72h termination. Keep a single interactive instance and
    // allow running on battery. Scheduler recovers the wrapper if cmd itself fails.
    '$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) ' +
      '-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries ' +
      '-MultipleInstances IgnoreNew -RestartCount 99 ' +
      '-RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable',
    'Set-ScheduledTask -TaskName $taskName -Settings $settings -ErrorAction Stop | Out-Null',
    // Verify the OS accepted the important properties instead of assuming success.
    '$configured = (Get-ScheduledTask -TaskName $taskName -ErrorAction Stop).Settings',
    "if ($configured.ExecutionTimeLimit -ne 'PT0S' -or $configured.RestartCount -lt 1) {" +
      " throw 'Windows Task Scheduler did not persist the ReMCP recovery policy' }",
  ].join('; ');
}
