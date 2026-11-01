import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsTemperatureReadings } from '../src/tools/windows-temperature.mjs';

// GitHub-hosted Windows VMs are not guaranteed any thermal sensors. Exercise
// the real PowerShell/CIM and optional NVIDIA paths without fabricating data.
test('Windows live temperature API returns only measured bounded channels', async context => {
  if (process.platform !== 'win32') return context.skip('requires actual Windows');
  const readings = await windowsTemperatureReadings();
  assert.ok(Array.isArray(readings));
  assert.ok(readings.length <= 64);
  for (const row of readings) {
    assert.equal(typeof row.name, 'string');
    assert.ok(row.name.length > 0 && row.name.length <= 60);
    assert.equal(typeof row.celsius, 'number');
    assert.ok(Number.isFinite(row.celsius) && row.celsius >= -40 && row.celsius <= 125);
  }
  console.log('Windows physical temperature channels exposed: ' + readings.length);
});
