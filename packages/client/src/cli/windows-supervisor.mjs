// Recovery for the signed-in user's interactive ReMCP agent on Windows.
// The desktop UI cannot run in Session 0: this intentionally retains /IT and ONLOGON.
import path from 'node:path';

function windowsBatchValue(value) {
  // cmd.exe expands % even inside quoted strings. Escape user-controlled prefix paths.
  return String(value).replaceAll('%', '%%');
}

export function windowsServiceLauncherText(cliPath, nodePath) {
  const prefix = path.win32.dirname(cliPath);
  const nodeDir = path.win32.dirname(nodePath);
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `set "NPM_CONFIG_PREFIX=${windowsBatchValue(prefix)}"`,
    `set "PATH=${windowsBatchValue(nodeDir)};%PATH%"`,
    ':remcp_restart',
    `call "${windowsBatchValue(cliPath)}" start --service`,
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
