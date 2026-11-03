import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuPerCoreUtilizationRatios } from '../src/tools/cpu-telemetry.mjs';
import {
  parseNetworkCounters, parseDarwinNetworkCounters, parseWindowsNetworkCounters, calculateNetworkRates, parseDiskVolumes, thermalReadings,
  diskVolumes, networkRates, sampleNetworkRates, parseWindowsNetstatPackets,
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

test('macOS netstat parses one active link row without double-counting address rows or tunnels', () => {
  const payload = [
    'Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll',
    'lo0 16384 <Link#1> 100 0 12000 200 0 13000 0',
    'en0 1500 <Link#11> aa:bb:cc:dd:ee:ff 400 0 123456 200 0 654321 0',
    'en0 1500 192.168.50 192.168.50.193 400 - 123456 200 - 654321 -',
    'en1 1500 <Link#12> aa:bb:cc:dd:ee:ff 1 0 42 2 0 21 0',
    'utun0 1500 <Link#14> aa:bb:cc:dd:ee:ff 9 0 99 8 0 88 0',
    'bad/name 1500 <Link#15> aa:bb:cc:dd:ee:ff 1 0 20 1 0 40 0',
  ].join('\n');
  assert.deepEqual(parseDarwinNetworkCounters(payload, new Set(['en0', 'utun0'])),
    [{name: 'en0', rx: 123456, tx: 654321}]);
  assert.deepEqual(parseDarwinNetworkCounters('bad header'), []);
});

test('Windows NIC statistics parse active adapter aliases, preserving real 0 traffic', () => {
  const rows = JSON.stringify([
    { Name: 'Ethernet 2', ReceivedBytes: 250000, SentBytes: 6000 },
    { Name: 'Wi-Fi', ReceivedBytes: 0, SentBytes: 0 },
    { Name: 'vEthernet (WSL)', ReceivedBytes: 8000, SentBytes: 1234 },
    { Name: 'unsafe;name', ReceivedBytes: 42, SentBytes: 32 },
    { Name: 'broken', ReceivedBytes: null, SentBytes: 80 },
  ]);
  assert.deepEqual(parseWindowsNetworkCounters(rows, new Set(['Ethernet 2','Wi-Fi'])), [
    { name: 'Ethernet 2', rx: 250000, tx: 6000 },
    { name: 'Wi-Fi', rx: 0, tx: 0 },
  ]);
  assert.deepEqual(parseWindowsNetworkCounters('{broken'), []);
  assert.deepEqual(parseWindowsNetworkCounters('null'), []);
  for (const invalid of ['', '  ', true, -1, 5.5, '1e3', 'NaN', null]) {
    assert.deepEqual(parseWindowsNetworkCounters(JSON.stringify({
      Name: 'Wi-Fi', ReceivedBytes: invalid, SentBytes: 30,
    })), [], 'Never coerce missing or malformed byte counters into zero');
  }
  assert.deepEqual(parseWindowsNetworkCounters(JSON.stringify({ Name: 'Wi-Fi',
    ReceivedBytes: 'not a counter', SentBytes: 30 })), []);
});

test('network rates require two real samples, monotonic counters and elapsed time', () => {
  const prev = [{name:'eth0',rx:100,tx:1000}];
  assert.equal(calculateNetworkRates(prev, null, 10), null);
  assert.equal(calculateNetworkRates(prev, prev, 0), null);
  assert.equal(calculateNetworkRates([{name:'eth0',rx:50,tx:1100}], prev, 10), null);
  const rates = calculateNetworkRates([{name:'eth0',rx:5100,tx:3000}], prev, 10);
  assert.deepEqual(rates, {rxBytesPerSecond:500,txBytesPerSecond:200,
    interfaces:[{name:'eth0',rxBytesPerSecond:500,txBytesPerSecond:200}]});
  assert.deepEqual(calculateNetworkRates(prev, prev, 2), {
    rxBytesPerSecond:0, txBytesPerSecond:0,
    interfaces:[{name:'eth0',rxBytesPerSecond:0,txBytesPerSecond:0}],
  });
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

test('unreadable network byte counters skip expensive retries and never fabricate zero', async () => {
  let reads = 0;
  let waits = 0;
  const result = await sampleNetworkRates(
    async () => { reads++; return []; },
    async () => { waits++; },
  );
  assert.equal(result, null);
  assert.equal(reads, 1);
  assert.equal(waits, 0);
});

test('Windows netstat fallback reports real packet rates without fabricating bytes', () => {
  const snapshot = [
    'Interface Statistics', '                           Received            Sent',
    'Bytes                             0               0',
    'Unicast packets                 1000             200',
    'Non-unicast packets               12               8',
    'Discards                           0               0',
    'Errors                             0               0',
  ].join('\r\n');
  const counters = parseWindowsNetstatPackets(snapshot);
  assert.deepEqual(counters, [{ name:'windows-all-adapters', rx:1012, tx:208, unit:'packets' }]);
  assert.deepEqual(calculateNetworkRates(
    [{name:'windows-all-adapters',rx:1212,tx:248,unit:'packets'}], counters, 2), {
    rxBytesPerSecond:null,txBytesPerSecond:null,rxPacketsPerSecond:100,
    txPacketsPerSecond:20,interfaces:[],
  });
  assert.equal(calculateNetworkRates([{name:'windows-all-adapters',rx:500,tx:248,unit:'packets'}],
    counters,2),null);
  assert.equal(calculateNetworkRates([{name:'windows-all-adapters',rx:1212,tx:248,unit:'packets'}],
    [{name:'windows-all-adapters',rx:1000,tx:200}],2),null);
  assert.deepEqual(parseWindowsNetstatPackets('No valid counter rows'), []);
});
