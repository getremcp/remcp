import test from 'node:test';
import assert from 'node:assert/strict';
import { darwinTemperatureReadings, normalizeDarwinTemperatures } from '../src/tools/darwin-temperature.mjs';

test('Apple Silicon reads real CPU, SoC and GPU channels with bounded labels', () => {
  const measured = { cpu: 58.8563, soc: 57.433, gpu: 52.6935, cpuDieTemps: [51, 52] };
  assert.deepEqual(darwinTemperatureReadings(() => ({ temperature: () => measured })), [
    { name: 'CPU', celsius: 58.9 },
    { name: 'SoC', celsius: 57.4 },
    { name: 'GPU', celsius: 52.7 },
  ]);
});

test('nonphysical or unavailable native sensor readings are omitted rather than fabricated', () => {
  assert.deepEqual(normalizeDarwinTemperatures({ cpu: 0, soc: NaN, gpu: -12 }), []);
  assert.deepEqual(normalizeDarwinTemperatures({ cpu: Infinity, soc: 126, gpu: '55.0' }), []);
  assert.deepEqual(normalizeDarwinTemperatures({ cpu: 41.25, gpu: 0 }), [
    { name: 'CPU', celsius: 41.3 },
  ]);
  assert.deepEqual(normalizeDarwinTemperatures(null), []);
  assert.deepEqual(normalizeDarwinTemperatures([]), []);
});

test('missing optional native package, sensor exception and invalid module all degrade safely', () => {
  assert.deepEqual(darwinTemperatureReadings(() => { throw new Error('module absent'); }), []);
  assert.deepEqual(darwinTemperatureReadings(() => ({ temperature: () => { throw new Error('not permitted'); } })), []);
  assert.deepEqual(darwinTemperatureReadings(() => ({ temperature: null })), []);
});

test('native package output cannot inject arbitrary telemetry names or payload fields', () => {
  assert.deepEqual(normalizeDarwinTemperatures({
    cpu: 44.53, soc: 41.34, gpu: 39.21, name: '<script>', randomKey: 60,
  }).map(x => x.name), ['CPU', 'SoC', 'GPU']);
});
