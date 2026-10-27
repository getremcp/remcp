import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuPerCoreUtilizationRatios } from '../src/tools/cpu-telemetry.mjs';
import {
  parseNetworkCounters, calculateNetworkRates, parseDiskVolumes, thermalReadings,
  diskVolumes, networkRates,
} from '../src/tools/system-telemetry.mjs';

const core = (idle, user) => ({ times: { idle, user, nice: 0, sys: 0, irq: 0 } });

test('CPU telemetry returns the measured per-core deltas, not fabricated load', () => {
  assert.deepEqual(cpuPerCoreUtilizationRatios(
    [core(10, 10), core(5, 5)], [core(20, 10), core(5, 15)]), [0, 1]);
  assert.equal(cpuPerCoreUtilizationRatios([core(5,5)], [core(1,6)]), null);
  assert.equal(cpuPerCoreUtilizationRatios([core(5,5)], []), null);
});

test('Linux network counter parsing accepts only bounded safe interface names', () => {
  const payload = ['Inter-| Receive | Transmit',' face |bytes packets errs drop fifo frame compressed multicast |bytes',
    ' lo: 100 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0',
    ' eth0: 1000 0 0 0 0 0 0 0 4000 0 0 0 0 0 0 0',
    ' bad/name: 50 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0',
    ' wlan0: 200 0 0 0 0 0 0 0 900 0 0 0 0 0 0 0'].join('\n');
  assert.deepEqual(parseNetworkCounters(payload), [
    {name:'eth0',rx:1000,tx:4000},{name:'wlan0',rx:200,tx:900},
  ]);
});

test('network rates require two real samples, monotonic counters and elapsed time', () => {
  const prev = [{name:'eth0',rx:100,tx:1000}];
  assert.equal(calculateNetworkRates(prev, null, 10), null);
  assert.equal(calculateNetworkRates(prev, prev, 0), null);
  assert.equal(calculateNetworkRates([{name:'eth0',rx:50,tx:1100}], prev, 10), null);
  const rates = calculateNetworkRates([{name:'eth0',rx:5100,tx:3000}], prev, 10);
  assert.deepEqual(rates, {rxBytesPerSecond:500,txBytesPerSecond:200,
    interfaces:[{name:'eth0',rxBytesPerSecond:500,txBytesPerSecond:200}]});
});

test('disk enumeration ignores virtual filesystems, handles no drives', () => {
  const payload = ['Filesystem 1024-blocks Used Available Capacity Mounted on',
    'tmpfs 1000 200 800 20% /run',
    '/dev/nvme0n1p3 100000 55000 45000 55% /',
    '/dev/sdb1 200000 10000 190000 5% /mnt/data'].join('\n');
  const rows = parseDiskVolumes(payload);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(item => item.mount), ['/', '/mnt/data']);
  assert.equal(rows[0].totalBytes, 102400000);
  assert.deepEqual(parseDiskVolumes('not a df response'), []);
});

test('optional sensor/network/volume probing remains safe on unavailable hosts', async () => {
  const [temperatures, volumes, net] = await Promise.all([thermalReadings(),diskVolumes(),networkRates()]);
  assert.ok(Array.isArray(temperatures));
  assert.ok(Array.isArray(volumes));
  assert.ok(net === null || typeof net.rxBytesPerSecond === 'number');
  assert.ok(temperatures.every(item => Number.isFinite(item.celsius)));
});

test('mounted volume inventory excludes loop, zram and ram-backed devices without hiding physical disks', () => {
  const df = ['Filesystem 1024-blocks Used Available Capacity Mounted on',
    '/dev/loop0 100 90 10 90% /snap/old',
    '/dev/loop1 100 90 10 90% /snap/another',
    '/dev/zram0 500 300 200 60% /swap',
    '/dev/ram0 500 200 300 40% /ram',
    '/dev/nvme0n1p2 1000000 500000 500000 50% /',
    '/dev/sda1 2000000 200000 1800000 10% /mnt/archive'].join('\n');
  assert.deepEqual(parseDiskVolumes(df).map(volume => volume.mount), ['/', '/mnt/archive']);
});

test('invalid or unsafe disk counters are omitted, not represented as full or empty disks', () => {
  const df = ['Filesystem 1024-blocks Used Available Capacity Mounted on',
    '/dev/sda1 100 200 0 200% /invalid',
    '/dev/sda2 100 50 50 50% /safe',
    '/dev/sda3 100 10 90 10% /etc/weird\\path'].join('\n');
  assert.deepEqual(parseDiskVolumes(df).map(volume => volume.mount), ['/safe']);
});
