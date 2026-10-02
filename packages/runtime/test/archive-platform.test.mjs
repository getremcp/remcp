import test from 'node:test';
import assert from 'node:assert/strict';

import { coreToolSupported, toolDefinitions } from '../src/catalog.mjs';
import { tarEntrySize } from '../src/tools/files.mjs';

test('archive tools are advertised on Linux and macOS but remain fail-closed on Windows', () => {
  const archives = toolDefinitions.filter(tool => ['create_archive','extract_archive'].includes(tool.name));
  assert.equal(archives.length, 2);
  for (const tool of archives) {
    assert.equal(coreToolSupported(tool, { platform:'linux' }), true);
    assert.equal(coreToolSupported(tool, { platform:'darwin' }), true);
    assert.equal(coreToolSupported(tool, { platform:'win32' }), false);
    assert.equal(coreToolSupported(tool, { platform:'freebsd' }), false);
  }
});

test('tar verbose parser accepts GNU and macOS bsdtar date formats without guessing other columns', () => {
  assert.equal(tarEntrySize('-rw-r--r-- user/group 5 2026-10-02 13:53 a.txt'), 5);
  assert.equal(tarEntrySize('-rw-r--r--  0 antonbaider staff       5 Oct  2 13:53 a.txt'), 5);
  assert.equal(tarEntrySize('-rw-r--r--  0 antonbaider staff      17 Oct  2  2025 old.txt'), 17);
  assert.equal(tarEntrySize('not a verbose tar row 5 Oct 2 13:53 whatever'), null);
});
