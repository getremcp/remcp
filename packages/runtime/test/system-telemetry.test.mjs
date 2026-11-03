import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuPerCoreUtilizationRatios } from '../src/tools/cpu-telemetry.mjs';
import {
  parseNetworkCounters, parseDarwinNetworkCounters, parseWindowsNetworkCounters, parseWindowsNetshCounters, calculateNetworkRates, parseDiskVolumes, thermalReadings,
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

test('Windows netsh counters support real active Ethernet bytes when PowerShell has no data', () => {
  const payload = [
    '       MTU  MediaSenseState      Bytes In     Bytes Out  Interface',
    '----------  ---------------  ------------  ------------  -------------',
    '4294967295                1             0         12290  Loopback Pseudo-Interface 1',
    '      1500                1     566548022      38142055  Ethernet',
    '      1500                5         10000         17000  Wi-Fi',
  ].join('\n');
  const active = new Set(['Ethernet', 'Wi-Fi']);
  // MediaSenseState=5 means the Wi-Fi link is disconnected.
  assert.deepEqual(parseWindowsNetshCounters(payload, active), [
    { name:'Ethernet', rx:566548022, tx:38142055 },
  ]);
  assert.deepEqual(parseWindowsNetshCounters(payload, new Set(['Ethernet'])),
    [{ name:'Ethernet', rx:566548022, tx:38142055 }]);
  assert.deepEqual(parseWindowsNetshCounters(payload, new Set()), []);
  const later = [{name:'Ethernet',rx:566552022,tx:38143055}];
  assert.deepEqual(calculateNetworkRates(later, parseWindowsNetshCounters(payload, new Set(['Ethernet'])), 2),
    { rxBytesPerSecond:2000, txBytesPerSecond:500,
      interfaces:[{name:'Ethernet',rxBytesPerSecond:2000,txBytesPerSecond:500}] });
});

test('Windows netsh rejects malformed, unsafe and nonnumeric data without inventing counters', () => {
  const payload = [
    ' MTU State Bytes In Bytes Out Interface',
    ' 1500 1 unknown 1000 Ethernet',
    ' 1500 1 -1 1000 Ethernet',
    ' 1500 1 100000 9999 bad/name',
    ' 1500 1 100000 9999 unsafe;name',
    ' 1500 1 9007199254740992 10 Ethernet',
    ' 1500 1 4000 1500 Ethernet',
    ' 1500 1 3000 900 Ethernet',
  ].join('\n');
  assert.deepEqual(parseWindowsNetshCounters(payload, new Set(['Ethernet'])),
    [{name:'Ethernet',rx:3000,tx:900}]);
  assert.deepEqual(parseWindowsNetshCounters(''), []);
  assert.deepEqual(parseWindowsNetshCounters('Get-NetAdapterStatistics failed'), []);
});
