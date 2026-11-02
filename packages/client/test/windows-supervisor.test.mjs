import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsServiceLauncherText, windowsTaskReliabilityCommand, windowsTaskScriptText } from '../src/cli/windows-supervisor.mjs';

test('Windows wrapper pins its private install and re-launches after every agent exit', () => {
  const launcher = windowsServiceLauncherText(
    'C:\\Users\\test-user\\AppData\\Local\\ReMCP\\runtime\\remcp.cmd',
    'C:\\Users\\test-user\\AppData\\Local\\ReMCP\\runtime\\node.exe',
  );
  assert.match(launcher, /^@echo off\r\nsetlocal DisableDelayedExpansion/m);
  assert.match(launcher, /set "NPM_CONFIG_PREFIX=C:\\Users\\test-user\\AppData\\Local\\ReMCP\\runtime"/);
  assert.match(launcher, /set "PATH=C:\\Users\\test-user\\AppData\\Local\\ReMCP\\runtime;%PATH%"/);
  assert.match(launcher, /:remcp_restart\r\ncall "[^"]+remcp\.cmd" start --service\r\n/);
  assert.match(launcher, /ping\.exe -n 6 127\.0\.0\.1 >nul\r\ngoto remcp_restart/);
  assert.doesNotMatch(launcher, /powershell|cmd\.exe \/c/i);
});

test('Windows scheduled task hides the persistent CMD process without detaching its lifetime', () => {
  const script = windowsTaskScriptText('C:\\Users\\anton\\.config\\remcp\\remcp-agent.cmd');
  assert.match(script, /WScript\.Shell/);
  assert.match(script, /remcpShell\.Run Chr\(34\).* 0, True/);
  assert.doesNotMatch(script, /powershell\.exe|cmd\.exe \/c/i);
  assert.throws(() => windowsTaskScriptText('C:\\unsafe\\bad" & MsgBox(1) & ".cmd'), /Invalid ReMCP Windows task launcher/);
});

test('Windows wrapper preserves escaped percent signs in unusual private paths', () => {
  const wrapper = windowsServiceLauncherText('C:\\Users\\percent%user\\remcp.cmd', 'D:\\Node%2026\\node.exe');
  assert.match(wrapper, /NPM_CONFIG_PREFIX=C:\\Users\\percent%%user/);
  assert.match(wrapper, /PATH=D:\\Node%%2026;%PATH%/);
  assert.match(wrapper, /call "C:\\Users\\percent%%user\\remcp\.cmd"/);
});

test('POSIX runner fixtures simulating win32 preserve their absolute test prefix', () => {
  const launcher = windowsServiceLauncherText('/tmp/remcp-test/bin/remcp.cmd', '/usr/local/bin/node');
  assert.match(launcher, /NPM_CONFIG_PREFIX=\/tmp\/remcp-test\/bin/);
  assert.match(launcher, /PATH=\/usr\/local\/bin;%PATH%/);
});

test('Scheduled Task recovery retains a single instance, battery operation, and unbounded uptime', () => {
  const command = windowsTaskReliabilityCommand('ReMCP Agent');
  assert.match(command, /New-ScheduledTaskSettingsSet/);
  assert.match(command, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(command, /-AllowStartIfOnBatteries/);
  assert.match(command, /-DontStopIfGoingOnBatteries/);
  assert.match(command, /-MultipleInstances IgnoreNew/);
  assert.match(command, /-RestartCount 99/);
  assert.match(command, /-RestartInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(command, /Set-ScheduledTask -TaskName \$taskName -Settings \$settings/);
  assert.match(command, /did not persist the ReMCP recovery policy/);
  assert.throws(() => windowsTaskReliabilityCommand("evil'; Stop-Computer"), /Invalid Windows task name/);
});


test('managed Windows launchers contain only ASCII batch text for multilingual accounts', () => {
  for (const user of ['Иван', 'Łukasz', 'محمد', '山田太郎', 'שלום', 'François', 'José', 'name%20! &']) {
    const localAppData = 'C:\\Users\\' + user + '\\AppData\\Local';
    const prefix = localAppData + '\\ReMCP\\runtime';
    const launcher = windowsServiceLauncherText(prefix + '\\remcp.cmd', prefix + '\\node.exe',
      { localAppData });
    assert.ok([...launcher].every(ch => ch.codePointAt(0) < 128), user);
    assert.match(launcher, /set "NPM_CONFIG_PREFIX=%LOCALAPPDATA%\\ReMCP\\runtime"/);
    assert.match(launcher, /set "PATH=%LOCALAPPDATA%\\ReMCP\\runtime;%PATH%"/);
    assert.match(launcher, /call "%LOCALAPPDATA%\\ReMCP\\runtime\\remcp.cmd" start --service/);
    assert.doesNotMatch(launcher, /%%LOCALAPPDATA%%|C:\\Users\\/);
  }
});
test('Windows launcher refuses writing unrepresentable user-controlled paths into a .cmd file', () => {
  assert.throws(() => windowsServiceLauncherText('C:\\Users\\山田\\other\\remcp.cmd',
    'C:\\Program Files\\nodejs\\node.exe', { localAppData:'C:\\Users\\山田\\AppData\\Local' }),
  /cannot safely encode this Unicode path/);
});
