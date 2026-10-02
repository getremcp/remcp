import test from 'node:test';
import assert from 'node:assert/strict';

import { installedApps } from '../src/extended/diagnostics.mjs';

const enabled = process.env.REMCP_LIVE_INSTALLED_APPS === '1';

test('live installed app inventory returns the stable structured contract', { skip: !enabled }, async () => {
  const result = await installedApps({ limit:5 });
  const payload = result?.structuredContent;

  assert.ok(payload && typeof payload === 'object');
  assert.ok(Array.isArray(payload.data));
  assert.equal(typeof payload.backend, 'string');
  assert.equal(typeof payload.count, 'number');
  assert.equal(typeof payload.returned, 'number');
  assert.equal(typeof payload.truncated, 'boolean');
  assert.equal(payload.returned, payload.data.length);
  assert.ok(payload.count >= payload.returned);
  assert.equal(payload.truncated, payload.count > payload.returned);
  assert.ok(payload.returned > 0, 'native inventory should return at least one installed app/package');

  const expectedBackends = {
    win32:'windows-registry',
    darwin:'system_profiler',
    linux:['dpkg-query','rpm'],
  };
  const expected = expectedBackends[process.platform];
  if (Array.isArray(expected)) assert.ok(expected.includes(payload.backend), payload.backend);
  else if (expected) assert.equal(payload.backend, expected);

  for (const row of payload.data) {
    assert.equal(typeof row.name, 'string');
    assert.ok(row.name.length > 0);
    for (const field of ['version','publisher','path']) assert.ok(Object.hasOwn(row, field), field);
  }
});
