import test from 'node:test';
import assert from 'node:assert/strict';
import { claimLegacyManifestSlot, getOrCreateRolloutStart, isLegacyAutomaticUpdateRequest, nextFleetManifestDelayMs, updateRolloutEligibility, ROLLOUT_WINDOW_MS } from '../src/agent-update-rollout.mjs';

const start = 1793904000000;
const target = '@remcp/remcp@0.2.235|@remcp/runtime@0.2.235';

test('100k clients deterministically spread downloads over 24 hours', () => {
  const minuteBins = new Uint32Array(1440);
  const hourBins = new Uint32Array(24);
  for (let n = 0; n < 100000; n += 1) {
    const input = { deviceId: 'paired-' + n, target, rollout:{startAtMs:start, windowMs:ROLLOUT_WINDOW_MS} };
    const first = updateRolloutEligibility(input, start);
    const again = updateRolloutEligibility(input, start);
    assert.deepEqual(first, again);
    assert.equal(first.ready, false);
    assert.ok(first.readyAt >= start && first.readyAt < start + ROLLOUT_WINDOW_MS);
    const offset = first.readyAt - start;
    minuteBins[Math.floor(offset / 60000)]++;
    hourBins[Math.floor(offset / 3600000)]++;
  }
  assert.ok(Math.max(...hourBins) < 4600, 'no hour should absorb a large fleet wave');
  assert.ok(Math.max(...minuteBins) < 130, 'no minute should absorb thousands of downloads');
  assert.equal(hourBins.reduce((sum, n) => sum + n, 0), 100000);
});

test('100k reconnecting agents spread manifest checks over 30 minutes', () => {
  const bins = new Uint32Array(1800);
  const now = start + 333333;
  for (let n = 0; n < 100000; n += 1) {
    const deviceId = 'paired-' + n;
    const delayMs = nextFleetManifestDelayMs(deviceId, now);
    assert.equal(nextFleetManifestDelayMs(deviceId, now), delayMs);
    assert.ok(delayMs > 0 && delayMs <= 1800000);
    bins[Math.floor((delayMs - 1) / 1000)]++;
  }
  assert.ok(Math.max(...bins) < 100, 'no second should receive a reconnect fleet stampede');
  assert.equal(bins.reduce((sum,n)=>sum+n,0),100000);
});

test('rollout window is stable after reconnect and a device becomes eligible at its slot', () => {
  const input = { deviceId:'a-backend', target, rollout:{startAtMs:start,windowMs:ROLLOUT_WINDOW_MS} };
  const { readyAt } = updateRolloutEligibility(input, start);
  assert.equal(updateRolloutEligibility(input, readyAt - 1).ready, false);
  assert.equal(updateRolloutEligibility(input, readyAt).ready, true);
  assert.equal(updateRolloutEligibility(input, readyAt + 8 * 86400000).ready, true);
  assert.notEqual(updateRolloutEligibility({ ...input, deviceId:'a-different-host' }, start).readyAt, readyAt);
});

test('server timestamp prevents skewed client clocks from bypassing rollout', () => {
  const input = { deviceId:'clock-skew-fixture', target, rollout:{startAtMs:start,windowMs:ROLLOUT_WINDOW_MS,serverNowMs:start} };
  const skewed = updateRolloutEligibility(input, start + 30 * ROLLOUT_WINDOW_MS);
  assert.equal(skewed.ready,false,'incorrect client clock must not skip the server-controlled window');
  assert.equal(updateRolloutEligibility({ ...input, rollout:{...input.rollout,serverNowMs:skewed.readyAt} }, start).ready,true);
});

test('invalid rollout metadata fails closed and critical runtime repair may bypass', () => {
  const input = { deviceId:'x',target,rollout:{startAtMs:'unknown',windowMs:86400000} };
  assert.equal(updateRolloutEligibility(input, start).ready,false);
  assert.equal(updateRolloutEligibility({ ...input, urgent:true }, start).ready,true);
  assert.equal(updateRolloutEligibility({ ...input, rollout:null }, start).ready,true, 'older standalone servers retain compatibility');
  assert.equal(updateRolloutEligibility({ ...input, deviceId:'', rollout:{startAtMs:start,windowMs:86400000} }, start).ready,false);
});

test('legacy automatic clients receive bounded per-minute shared admission', async () => {
  const counters = new Map();
  const command = {
    isReady:true,
    async eval(script, {keys, arguments:args}) {
      assert.match(script, /redis.call\('INCR',KEYS\[1\]\)/);
      const count = (counters.get(keys[0]) || 0) + 1;
      counters.set(keys[0], count);
      return count <= Number(args[0]) ? 1 : 0;
    },
  };
  let time = start;
  for (let n = 0; n < 120; n += 1) {
    assert.equal(await claimLegacyManifestSlot(command, '0.2.235', {now:()=>time}), true);
  }
  assert.equal(await claimLegacyManifestSlot(command, '0.2.235', {now:()=>time}), false);
  time += 60_000;
  assert.equal(await claimLegacyManifestSlot(command, '0.2.235', {now:()=>time}), true);
  assert.equal(counters.size,2,'independent minute buckets');
  await assert.rejects(claimLegacyManifestSlot({isReady:false}, '0.2.235'), /unavailable/);
});

test('only old unattended Node version checks use the server-side budget', () => {
  const request = (ua, accept='*/*', headers={}, query={}) => ({
    get(name) { return name === 'user-agent' ? ua : name === 'accept' ? accept : headers[name]; },
    query,
  });
  assert.equal(isLegacyAutomaticUpdateRequest(request('node')), true);
  assert.equal(isLegacyAutomaticUpdateRequest(request('undici/6.0')), true);
  assert.equal(isLegacyAutomaticUpdateRequest(request('node', '*/*', {'x-remcp-update-scheduler':'v1'})), false);
  assert.equal(isLegacyAutomaticUpdateRequest(request('node', 'application/json')), false);
  assert.equal(isLegacyAutomaticUpdateRequest(request('node', '*/*', {}, {fresh:'123'})), false);
  assert.equal(isLegacyAutomaticUpdateRequest(request('curl/8.5.0')), false);
});

test('Redis release epoch is shared across replicas, stable across deployment retries and fails closed', async () => {
  const store = new Map();
  const client = {
    isReady:true,
    async set(key, value, opts) { if (!store.has(key)) {store.set(key, value); this.options=opts;} return store.get(key)===value?'OK':null; },
    async get(key) { return store.get(key) || null; },
  };
  const initial = await getOrCreateRolloutStart(client, '0.2.235', () => start);
  const second = await getOrCreateRolloutStart(client, '0.2.235', () => start + 3600000);
  const third = await getOrCreateRolloutStart(client, '0.2.236', () => start + 3600000);
  assert.equal(initial, start);
  assert.equal(second, initial);
  assert.equal(third, start + 3600000);
  assert.equal(client.options.NX,true);
  assert.ok(client.options.EX >= 86400);
  await assert.rejects(getOrCreateRolloutStart({isReady:false}, '0.2.235'), /unavailable/i);
  await assert.rejects(getOrCreateRolloutStart(client, 'not/a/version'), /version/i);
});
