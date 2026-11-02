import test from 'node:test';
import assert from 'node:assert/strict';
import { browserLaunchCommand } from '../src/cli/connect.mjs';

test('Windows opens approval URLs without routing server-controlled text through cmd.exe', () => {
  const hostile = 'https://example.test/approve?next=x&calc.exe';
  const launch = browserLaunchCommand(hostile, 'win32');
  assert.equal(launch.command, 'explorer.exe');
  assert.deepEqual(launch.args, [hostile]);
});

test('macOS and Linux openers keep the URL as one argument', () => {
  const url = 'https://example.test/approve?a=1&b=2';
  assert.deepEqual(browserLaunchCommand(url, 'darwin'), { command: 'open', args: [url] });
  assert.deepEqual(browserLaunchCommand(url, 'linux'), { command: 'xdg-open', args: [url] });
});
