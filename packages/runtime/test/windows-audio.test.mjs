import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { windowsAudioPowerShell } from '../src/extended/diagnostics.mjs';

function invocationTail(action, volume = 50) {
  return windowsAudioPowerShell(action, volume).split('\n').slice(-2);
}

test('Windows CoreAudio commands are deterministic and never use mute toggles', () => {
  assert.deepEqual(invocationTail('mute'), [
    '[ReMCP.WindowsAudio]::SetMuted($true)',
    '[Console]::Out.WriteLine([ReMCP.WindowsAudio]::GetStateJson())',
  ]);
  assert.deepEqual(invocationTail('unmute'), [
    '[ReMCP.WindowsAudio]::SetMuted($false)',
    '[Console]::Out.WriteLine([ReMCP.WindowsAudio]::GetStateJson())',
  ]);
  assert.deepEqual(invocationTail('set_volume', 37), [
    '[ReMCP.WindowsAudio]::SetVolume(37)',
    '[Console]::Out.WriteLine([ReMCP.WindowsAudio]::GetStateJson())',
  ]);
  assert.deepEqual(invocationTail('set_volume', 150), [
    '[ReMCP.WindowsAudio]::SetVolume(100)',
    '[Console]::Out.WriteLine([ReMCP.WindowsAudio]::GetStateJson())',
  ]);
  assert.deepEqual(invocationTail('set_volume', -10), [
    '[ReMCP.WindowsAudio]::SetVolume(0)',
    '[Console]::Out.WriteLine([ReMCP.WindowsAudio]::GetStateJson())',
  ]);

  const script = windowsAudioPowerShell('status');
  assert.match(script, /GetDefaultAudioEndpoint/);
  assert.match(script, /SetMasterVolumeLevelScalar/);
  assert.match(script, /GetMasterVolumeLevelScalar/);
  assert.match(script, /SetMute/);
  assert.match(script, /GetMute/);
  assert.doesNotMatch(script, /VOLUME_MUTE|SendKeys|WScript\.Shell/);
});

test('Windows CoreAudio interop compiles with the inbox PowerShell Add-Type compiler', { skip: process.platform !== 'win32' }, () => {
  const script = windowsAudioPowerShell('status', 50, { compileOnly:true });
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    encoding:'utf8',
    timeout:30_000,
    windowsHide:true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /compiled/);
});
