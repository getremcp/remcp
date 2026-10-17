import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsServiceLauncherText, windowsTaskReliabilityCommand } from '../src/cli/windows-supervisor.mjs';

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
