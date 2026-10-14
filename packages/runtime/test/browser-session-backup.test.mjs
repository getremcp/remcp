import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { preserveInterruptedBrowserSession } from '../src/extended/browser-session-backup.mjs';

const cleanup = [];
afterEach(() => { for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true }); });
function profile({ crashed = true, tabs = true, session = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'remcp-session-safety-'));
  cleanup.push(root);
  const home = join(root, 'browser-cdp');
  const dir = join(home, 'Default', 'Sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, 'Default', 'Preferences'), JSON.stringify({ profile: { exit_type: crashed ? 'Crashed' : 'Normal' } }));
  if (tabs) writeFileSync(join(dir, 'Tabs_1111'), Buffer.from('SNSS\u0003\u0000\u0000\u0000synthetic-tab-data'));
  if (session) writeFileSync(join(dir, 'Session_2222'), Buffer.from('SNSS\u0003\u0000\u0000\u0000synthetic-window-data'));
  return { home, dir, root, recovery: join(root, 'browser-cdp-recovery') };
}

test('backs up both session types without changing source files', () => {
  const p = profile();
  const originalTabs = readFileSync(join(p.dir, 'Tabs_1111'));
  const originalWindow = readFileSync(join(p.dir, 'Session_2222'));
  const result = preserveInterruptedBrowserSession(p.home);
  assert.deepEqual(result, { saved: true, reason: 'saved', count: 2, bytes: originalTabs.length + originalWindow.length });
  const snapshots = readdirSync(p.recovery);
  assert.equal(snapshots.length, 1);
  const dest = join(p.recovery, snapshots[0]);
  assert.deepEqual(readFileSync(join(dest, 'Tabs_1111')), originalTabs);
  assert.deepEqual(readFileSync(join(dest, 'Session_2222')), originalWindow);
  assert.deepEqual(readFileSync(join(p.dir, 'Tabs_1111')), originalTabs);
  const manifest = readFileSync(join(dest, 'manifest.json'), 'utf8');
  assert.ok(!manifest.includes('synthetic-window-data') && !manifest.includes('synthetic-tab-data'));
  assert.equal(JSON.parse(manifest).hasWindowSession, true);
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(p.recovery).mode & 0o777, 0o700);
    for (const file of ['Tabs_1111', 'Session_2222', 'manifest.json']) assert.equal(lstatSync(join(dest, file)).mode & 0o777, 0o600);
  }
});

test('duplicate backup is idempotent and prior files are never overwritten', () => {
  const p = profile();
  assert.equal(preserveInterruptedBrowserSession(p.home).saved, true);
  const original = readdirSync(p.recovery);
  assert.deepEqual(preserveInterruptedBrowserSession(p.home), { saved: false, reason: 'already-saved' });
  assert.deepEqual(readdirSync(p.recovery), original);
});

test('protects orphaned Tabs files even when there is no recent window session', () => {
  const p = profile({ session: false });
  const result = preserveInterruptedBrowserSession(p.home);
  assert.equal(result.saved, true);
  const snapshot = readdirSync(p.recovery)[0];
  assert.equal(JSON.parse(readFileSync(join(p.recovery, snapshot, 'manifest.json'), 'utf8')).hasWindowSession, false);
});

test('does not snapshot clean shutdowns or profiles with no tab data', () => {
  const clean = profile({ crashed: false });
  const empty = profile({ tabs: false });
  assert.equal(preserveInterruptedBrowserSession(clean.home).reason, 'clean-or-missing');
  assert.equal(preserveInterruptedBrowserSession(empty.home).reason, 'no-tabs');
});

test('refuses a linked Tabs file instead of following it', { skip: process.platform === 'win32' }, () => {
  const p = profile({ tabs: false });
  symlinkSync(join(p.dir, 'Session_2222'), join(p.dir, 'Tabs_1111'));
  assert.throws(() => preserveInterruptedBrowserSession(p.home), /unsafe/i);
});

test('refuses a linked backup directory instead of writing outside the profile', { skip: process.platform === 'win32' }, () => {
  const p = profile();
  symlinkSync(p.dir, p.recovery);
  assert.throws(() => preserveInterruptedBrowserSession(p.home), /unsafe|ELOOP|directory/i);
  assert.equal(readdirSync(p.dir).length, 2);
});

test('refuses oversized evidence instead of exhausting the filesystem', () => {
  const p = profile();
  truncateSync(join(p.dir, 'Tabs_1111'), 33 * 1024 * 1024);
  assert.throws(() => preserveInterruptedBrowserSession(p.home), /oversized/i);
});
