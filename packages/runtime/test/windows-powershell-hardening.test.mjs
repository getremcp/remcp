import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsPowerShellArguments } from '../src/extended/common.mjs';

test('Windows PowerShell never overrides execution policy for inline commands', () => {
  const argv = windowsPowerShellArguments('Write-Output 42');
  assert.deepEqual(argv.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(argv.length, 5);
  assert.ok(!argv.some(arg => /^-ExecutionPolicy$/i.test(arg)));
  assert.ok(!argv.some(arg => /^Bypass$/i.test(arg)));
  assert.match(argv[4], /^\[Console\]::OutputEncoding=/);
  assert.ok(argv[4].endsWith('Write-Output 42'));
});

test('Unicode/multiline PS scripts are delivered intact', () => {
  const script = `Write-Output 'Привет'
Write-Output 'Zażółć'`;
  assert.ok(windowsPowerShellArguments(script)[4].endsWith(script));
});
