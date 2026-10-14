import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserAutoLaunchArgs, shouldRestoreBrowserSession } from '../src/extended/browser.mjs';

const profiles = [];
afterEach(() => { for (const dir of profiles.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function profile(exitType = 'Crashed', withTabs = true) {
  const dir = mkdtempSync(join(tmpdir(), 'remcp-browser-restore-'));
  profiles.push(dir);
  mkdirSync(join(dir, 'Default', 'Sessions'), { recursive: true });
  writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify({ profile: { exit_type: exitType } }));
  if (withTabs) writeFileSync(join(dir, 'Default', 'Sessions', 'Tabs_123456'), Buffer.alloc(1024, 42));
  return dir;
}

test('restores an interrupted Chrome session without overriding it with an empty tab', () => {
  const dir = profile('Crashed');
  assert.equal(shouldRestoreBrowserSession(dir), true);
  const args = browserAutoLaunchArgs(dir, { platform: 'linux', display: ':0' });
  assert.ok(args.includes('--restore-last-session'));
  assert.ok(!args.includes('about:blank'), 'an explicit URL can suppress Chrome last-session restore');
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(args.includes('--remote-debugging-port=9222'));
  assert.ok(args.includes(`--user-data-dir=${dir}`));
});

test('never restores tabs after clean user-controlled browser shutdown', () => {
  const dir = profile('Normal');
  assert.equal(shouldRestoreBrowserSession(dir), false);
  const args = browserAutoLaunchArgs(dir);
  assert.ok(!args.includes('--restore-last-session'));
  assert.ok(args.includes('about:blank'));
});

test('does not restore when session data is absent or malformed', () => {
  const empty = profile('Crashed', false);
  const broken = profile('Crashed');
  writeFileSync(join(broken, 'Default', 'Preferences'), 'not valid JSON');
  assert.equal(shouldRestoreBrowserSession(empty), false);
  assert.equal(shouldRestoreBrowserSession(broken), false);
  assert.ok(browserAutoLaunchArgs(empty, { platform: 'linux', display: '', waylandDisplay: '' }).includes('--headless=new'));
});

test('auto-launch remains unchanged for a newly created profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remcp-browser-fresh-'));
  profiles.push(dir);
  assert.equal(shouldRestoreBrowserSession(dir), false);
  const args = browserAutoLaunchArgs(dir, { platform: 'linux', display: ':0' });
  assert.ok(args.includes('about:blank'));
  assert.ok(!args.includes('--restore-last-session'));
});

test('does not use a symlinked external sessions directory', { skip: process.platform === 'win32' ? 'Windows symlink creation requires developer mode' : false }, () => {
  const dir = profile('Crashed', false);
  const external = profile('Crashed', true);
  rmSync(join(dir, 'Default', 'Sessions'), { recursive: true });
  symlinkSync(join(external, 'Default', 'Sessions'), join(dir, 'Default', 'Sessions'));
  assert.equal(shouldRestoreBrowserSession(dir), false);
});

test('refuses a linked Preferences file rather than reading an external file', { skip: process.platform === 'win32' ? 'Windows symlink creation requires developer mode' : false }, () => {
  const dir = profile('Crashed');
  const other = profile('Crashed');
  rmSync(join(dir, 'Default', 'Preferences'));
  symlinkSync(join(other, 'Default', 'Preferences'), join(dir, 'Default', 'Preferences'));
  assert.equal(shouldRestoreBrowserSession(dir), false);
});

test('refuses a linked Tabs file rather than using the external tab session', { skip: process.platform === 'win32' ? 'Windows symlink creation requires developer mode' : false }, () => {
  const dir = profile('Crashed', false);
  const other = profile('Crashed');
  symlinkSync(join(other, 'Default', 'Sessions', 'Tabs_123456'), join(dir, 'Default', 'Sessions', 'Tabs_123456'));
  assert.equal(shouldRestoreBrowserSession(dir), false);
});
