import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuUtilizationRatio, cpuFrequencyMHz, scheduleCpuSampleAndProbes } from '../src/tools/cpu-telemetry.mjs';

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

test('Windows samples CPU before diagnostic subprocesses can distort utilization', async () => {
  const order = [];
  const result = await scheduleCpuSampleAndProbes('win32', async () => {
    order.push('sample-start');
    await Promise.resolve();
    order.push('sample-complete');
    return [core(100, 100)];
  }, () => { order.push('start-probes'); return { network: 'measured' }; });
  assert.deepEqual(order, ['sample-start', 'sample-complete', 'start-probes']);
  assert.equal(result.probes.network, 'measured');
  assert.equal(result.cpus[0].times.idle, 100);
});

test('Linux and macOS keep diagnostic probes parallel with CPU sampling', async () => {
  for (const platform of ['linux', 'darwin']) {
    const order = [];
    const result = await scheduleCpuSampleAndProbes(platform, () => {
      order.push('sample-start');
      return Promise.resolve('cpu-result');
    }, () => { order.push('start-probes'); return 'probe-result'; });
    assert.deepEqual(order, ['start-probes', 'sample-start']);
    assert.equal(result.cpus, 'cpu-result');
    assert.equal(result.probes, 'probe-result');
  }
});

test('Windows probe startup does not run if CPU sample fails', async () => {
  let invoked = false;
  await assert.rejects(scheduleCpuSampleAndProbes('win32',
    () => Promise.reject(new Error('cpu sampling failed')),
    () => { invoked = true; return null; }), /cpu sampling failed/);
  assert.equal(invoked, false);
});
