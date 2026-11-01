import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDarwinMemoryPressure, readDarwinMemoryPressure } from '../src/tools/darwin-memory-pressure.mjs';

test('Darwin free memory and kernel pressure remain separate, correctly attributed fields', async () => {
  const result = parseDarwinMemoryPressure('System-wide memory free percentage: 37%\n', '2\n');
  assert.deepEqual(result, {
    effectiveFreeRatio: .37, effectiveFreeMethod: 'darwin-memory_pressure-Q',
    pressureLevel: 'warning', pressureMethod: 'darwin-kernel-sysctl',
  });
  const seen = [];
  const sampled = await readDarwinMemoryPressure(async (file, args) => {
    seen.push([file, args]);
    return file.endsWith('memory_pressure') ? 'System-wide memory free percentage: 32%' : '4\n';
  });
  assert.equal(sampled.pressureLevel, 'critical');
  assert.deepEqual(seen, [
    ['/usr/bin/memory_pressure', ['-Q']],
    ['/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']],
  ]);
});
test('missing or malformed macOS probes never fabricate a normal pressure reading', () => {
  for (const [free, level] of [
    ['',''], ['System-wide memory free percentage: 101%', '0'],
    ['System-wide memory free percentage: -1%', '9'],
    ['System-wide memory free percentage: NaN%', 'normal'],
  ]) {
    const actual = parseDarwinMemoryPressure(free, level);
    assert.equal(actual.effectiveFreeRatio, null);
    assert.equal(actual.pressureLevel, null);
    assert.equal(actual.effectiveFreeMethod, null);
    assert.equal(actual.pressureMethod, null);
  }
});
