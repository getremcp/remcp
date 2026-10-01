import test from 'node:test';
import assert from 'node:assert/strict';

import { filterMacosTcpListeners, networkTool } from '../src/extended/diagnostics.mjs';

test('macOS listener filtering keeps only TCP LISTEN rows', () => {
  const sample = [
    'Active Internet connections (including servers)',
    'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)',
    'tcp4       0      0  127.0.0.1.8787         *.*                    LISTEN',
    'tcp4       0      0  10.0.0.2.53120         1.1.1.1.443            ESTABLISHED',
    'tcp6       0      0  *.22                   *.*                    LISTEN',
  ].join('\n');
  const filtered = filterMacosTcpListeners(sample);
  assert.match(filtered, /127\.0\.0\.1\.8787[\s\S]*LISTEN/);
  assert.match(filtered, /\*\.22[\s\S]*LISTEN/);
  assert.doesNotMatch(filtered, /ESTABLISHED/);
  assert.doesNotMatch(filtered, /1\.1\.1\.1\.443/);
});

test('macOS network routes returns the numeric routing table instead of route(8) usage', { skip: process.platform !== 'darwin' }, async () => {
  const result = await networkTool({ action:'routes' });
  const output = result?.content?.[0]?.text || '';
  assert.ok(output.length > 0, 'macOS routing table output must not be empty');
  assert.match(output, /Routing tables|Destination\s+Gateway/i);
  assert.doesNotMatch(output, /usage:\s*route/i);
});

test('macOS network listeners returns only TCP listeners', { skip: process.platform !== 'darwin' }, async () => {
  const result = await networkTool({ action:'listeners' });
  const output = result?.content?.[0]?.text || '';
  assert.doesNotMatch(output, /ESTABLISHED|CLOSE_WAIT|TIME_WAIT/i);
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim() || /^Active Internet connections/i.test(line) || /^Proto\s+/i.test(line)) continue;
    assert.match(line, /\bLISTEN\b/i, `unexpected non-listening socket row: ${line}`);
  }
});
