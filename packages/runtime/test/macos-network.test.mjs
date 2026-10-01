import test from 'node:test';
import assert from 'node:assert/strict';

import { networkTool } from '../src/extended/diagnostics.mjs';

test('macOS network routes returns the numeric routing table instead of route(8) usage', { skip: process.platform !== 'darwin' }, async () => {
  const result = await networkTool({ action:'routes' });
  const output = result?.content?.[0]?.text || '';
  assert.ok(output.length > 0, 'macOS routing table output must not be empty');
  assert.match(output, /Routing tables|Destination\s+Gateway/i);
  assert.doesNotMatch(output, /usage:\s*route/i);
});
