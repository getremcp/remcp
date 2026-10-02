import test from 'node:test';
import assert from 'node:assert/strict';

import { coreToolSupported, toolDefinitions } from '../src/catalog.mjs';
import { archiveBackendAvailable, tarEntrySize } from '../src/tools/files.mjs';

test('archive tools are advertised on Linux/macOS and on Windows only with the native tar backend', () => {
  const archives = toolDefinitions.filter(tool => ['create_archive','extract_archive'].includes(tool.name));
  assert.equal(archives.length, 2);
  for (const tool of archives) {
    assert.equal(coreToolSupported(tool, { platform:'linux' }), true);
    assert.equal(coreToolSupported(tool, { platform:'darwin' }), true);
    assert.equal(coreToolSupported(tool, { platform:'win32', archiveAvailable:true }), true);
    assert.equal(coreToolSupported(tool, { platform:'win32', archiveAvailable:false }), false);
    assert.equal(coreToolSupported(tool, { platform:'freebsd', archiveAvailable:true }), false);
  }
});

test('Windows archive backend availability is the tar.exe probe result', () => {
  assert.equal(archiveBackendAvailable({ platform:'win32', probe:name => name === 'tar.exe' ? 'tar.exe' : null }), true);
  assert.equal(archiveBackendAvailable({ platform:'win32', probe:() => null }), false);
  assert.equal(archiveBackendAvailable({ platform:'darwin', probe:() => null }), true);
  assert.equal(archiveBackendAvailable({ platform:'linux', probe:() => null }), true);
  assert.equal(archiveBackendAvailable({ platform:'freebsd', probe:() => 'tar' }), false);
});

test('tar verbose parser accepts GNU and macOS bsdtar date formats without guessing other columns', () => {
  assert.equal(tarEntrySize('-rw-r--r-- user/group 5 2026-10-02 13:53 a.txt'), 5);
  assert.equal(tarEntrySize('-rw-r--r--  0 antonbaider staff       5 Oct  2 13:53 a.txt'), 5);
  assert.equal(tarEntrySize('-rw-r--r--  0 antonbaider staff      17 Oct  2  2025 old.txt'), 17);
  assert.equal(tarEntrySize('not a verbose tar row 5 Oct 2 13:53 whatever'), null);
});
