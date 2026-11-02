import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { body, freshWorkspace, isError } from './helpers.mjs';
import {
  describeFilesystemFailure,
  filesystemErrorExplanation,
  macosProtectedLocation,
  windowsProtectedLocation,
} from '../src/permissions.mjs';

const errno = (code, extra = {}) => Object.assign(new Error(`${code}: something failed`), { code, ...extra });

test('the macOS privacy folders are recognised, and nothing else is', () => {
  const options = { platform: 'darwin', home: '/Users/ada' };
  assert.equal(macosProtectedLocation('/Users/ada/Desktop/notes/a.md', options), '~/Desktop');
  assert.equal(macosProtectedLocation('/Users/ada/Documents', options), '~/Documents');
  assert.equal(macosProtectedLocation('/Users/ada/Downloads/tmp/x', options), '~/Downloads');
  assert.equal(macosProtectedLocation('/Users/ada/Library/Mobile Documents/com~apple~CloudDocs', options), 'iCloud Drive');
  assert.equal(macosProtectedLocation('/Volumes/Backup/notes', options), 'an external or network volume');
  assert.equal(macosProtectedLocation('/Users/ada/projects/a.md', options), null);
  // Another account's Desktop is still a Desktop: the runtime can be asked to write there, and the
  // kernel protects it for this process all the same.
  assert.equal(macosProtectedLocation('/Users/other/Desktop/notes', options), '~/Desktop');
  assert.equal(macosProtectedLocation('/Users/ada', options), null);
  // The same path is ordinary on Linux, where TCC does not exist.
  assert.equal(macosProtectedLocation('/Users/ada/Desktop', { platform: 'linux', home: '/Users/ada' }), null);
});

test('an EACCES inside Desktop explains the grant instead of the errno alone', () => {
  const explanation = filesystemErrorExplanation(errno('EACCES'), {
    path: '/Users/ada/Desktop/антоша мелаша',
    platform: 'darwin',
    execPath: '/usr/local/bin/node',
  });
  assert.match(explanation, /macOS protects ~\/Desktop \(EACCES\)/);
  assert.match(explanation, /System Settings → Privacy & Security → Full Disk Access/);
  assert.match(explanation, /\/usr\/local\/bin\/node/, 'the message names the exact binary to grant');
  assert.match(explanation, /remcp start/);
});

test('other platforms and other errnos get their own sentence, or none at all', () => {
  assert.match(filesystemErrorExplanation(errno('EACCES'), { path: '/srv/app/data', platform: 'linux' }), /denied access to \/srv\/app\/data \(EACCES\)/);
  assert.doesNotMatch(filesystemErrorExplanation(errno('EACCES'), { path: '/srv/app/data', platform: 'linux' }), /Full Disk Access/);
  assert.match(filesystemErrorExplanation(errno('EACCES'), { path: '/srv/app/data', platform: 'linux' }), /owns the folder and its parents/);
  assert.match(filesystemErrorExplanation(errno('EROFS'), { path: '/mnt/ro' }), /read-only file system/);
  assert.match(filesystemErrorExplanation(errno('EBUSY'), { path: 'C:\\logs\\app.log' }), /in use by another program/);
  assert.match(filesystemErrorExplanation(errno('ENOSPC'), {}), /disk is full/);
  assert.match(filesystemErrorExplanation(errno('ENOENT'), { path: '/tmp/x' }), /does not exist.*drive letter/);
  assert.match(filesystemErrorExplanation(errno('ENOTDIR'), { path: '/tmp/file/child' }), /parent path/);
  assert.match(filesystemErrorExplanation(errno('EDQUOT'), {}), /quota is exhausted/);
  assert.equal(filesystemErrorExplanation(new Error('not found'), {}), null);
});

test('Windows controlled folder access is named for Desktop, Documents and Downloads', () => {
  const options = { platform: 'win32', home: 'C:\\Users\\Ada' };
  assert.equal(windowsProtectedLocation('C:\\Users\\Ada\\Desktop\\notes.md', options), '%USERPROFILE%\\Desktop');
  assert.equal(windowsProtectedLocation('C:\\Users\\Ada\\Documents', options), '%USERPROFILE%\\Documents');
  assert.equal(windowsProtectedLocation('C:\\Users\\Ada\\OneDrive\\Desktop\\x', options), '%USERPROFILE%\\OneDrive\\Desktop');
  assert.equal(windowsProtectedLocation('C:\\Users\\Ada\\projects\\a.md', options), null);
  assert.equal(windowsProtectedLocation('C:\\Users\\Ada\\Desktop', { platform: 'linux', home: 'C:\\Users\\Ada' }), null);
  const explanation = filesystemErrorExplanation(errno('EPERM'), {
    path: 'C:\\Users\\Ada\\Desktop\\notes.md',
    platform: 'win32',
    home: 'C:\\Users\\Ada',
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
  });
  assert.match(explanation, /Controlled folder access/);
  assert.match(explanation, /node\.exe/);
  // A permission failure outside those folders still gets Windows-specific advice instead of the
  // generic sentence.
  const generic = filesystemErrorExplanation(errno('EPERM'), { path: 'D:\\data\\x', platform: 'win32', execPath: 'C:\\node.exe' });
  assert.match(generic, /read-only|Controlled folder access/);
});

test('describeFilesystemFailure keeps the kernel message and appends the fix', () => {
  const error = errno('EACCES', { path: '/Users/ada/Downloads/file.txt' });
  const described = describeFilesystemFailure(error, { platform: 'darwin', execPath: '/opt/homebrew/bin/node' });
  assert.match(described, /^EACCES: something failed/);
  assert.match(described, /~\/Downloads/);
  assert.match(described, /\/opt\/homebrew\/bin\/node/);
  assert.equal(describeFilesystemFailure(new Error('plain'), {}), 'plain');
});

test('a real permission failure reaches the caller with a fix attached', {
  // UID 0 bypasses ordinary Unix directory write permissions, so chmod(0500) cannot produce
  // the EACCES path this integration probe is meant to exercise. The pure errno/description
  // tests above still cover the user-facing remediation text on root-runner environments.
  skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0),
}, async () => {
  const root = freshWorkspace('permissions');
  const locked = join(root, 'locked');
  mkdirSync(locked, { recursive: true });
  // The check runs as the owner of the directory, so this is the same shape of failure Desktop gives
  // on macOS: the kernel says EACCES and the tool has to explain what to do about it.
  chmodSync(locked, 0o500);
  process.env.REMCP_RUNTIME_ALLOWED_ROOTS = root;
  const { invokeTool } = await import('../src/invoke.mjs');
  const result = await invokeTool('create_directory', { path: join(locked, 'child') });
  assert.equal(isError(result), true);
  assert.match(body(result), /EACCES/);
  assert.match(body(result), /Check that this user owns the folder and its parents, or choose another path\./);
  chmodSync(locked, 0o700);
});
