import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuUtilizationRatio, cpuFrequencyMHz } from '../src/tools/cpu-telemetry.mjs';

const core = (idle, user, speed = 3100) => ({
  speed, times: { idle, user, nice: 0, sys: 0, irq: 0 },
});

test('utilization uses delta busy CPU time across all logical cores', () => {
  const before = [core(100,100),core(200,100)];
  const after = [core(160,140),core(240,160)];
  assert.equal(cpuUtilizationRatio(before,after), 0.5);
  assert.equal(cpuFrequencyMHz(after), 3100);
});
test('missing or invalid CPU counters are unknown rather than 0% busy', () => {
  assert.equal(cpuUtilizationRatio([],[]),null);
  assert.equal(cpuUtilizationRatio([core(10,10)],[core(10,10)]),null);
  assert.equal(cpuUtilizationRatio([core(50,50)],[core(10,90)]),null);
  assert.equal(cpuUtilizationRatio([core(1,1)],[{}]),null);
  assert.equal(cpuFrequencyMHz([{speed:0},{speed:Infinity}]),null);
});
test('percentage and measured frequency are bounded', () => {
  assert.equal(cpuUtilizationRatio([core(0,0)],[core(0,100)]),1);
  assert.equal(cpuUtilizationRatio([core(0,0)],[core(100,0)]),0);
  assert.equal(cpuFrequencyMHz([core(0,0,2000),core(0,0,4000)]),3000);
});
