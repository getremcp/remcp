import test from 'node:test';
import assert from 'node:assert/strict';
import { linuxTemperatureReadings, linuxTemperatureValue } from '../src/tools/linux-temperature.mjs';
import { parseWindowsTemperatureReadings, parseNvidiaTemperatures,
  windowsTemperatureReadings, WINDOWS_TEMPERATURE_SCRIPT } from '../src/tools/windows-temperature.mjs';

test('Linux merges actual CPU, GPU, NVMe, Wi-Fi and ACPI channels even when thermal_zone exists', async () => {
  const entries = new Map([
    ['/sys/class/hwmon', ['hwmon0','hwmon1','hwmon2','hwmon3','untrusted']],
    ['/sys/class/hwmon/hwmon0', ['temp1_input','temp1_label']],
    ['/sys/class/hwmon/hwmon1', ['temp1_input','temp1_label','temp2_input','temp2_label']],
    ['/sys/class/hwmon/hwmon2', ['temp1_input']],
    ['/sys/class/hwmon/hwmon3', ['temp1_input']],
    ['/sys/class/thermal', ['thermal_zone0','thermal_zone1']],
  ]);
  const files = new Map([
    ['/sys/class/hwmon/hwmon0/name', 'acpitz\n'],
    ['/sys/class/hwmon/hwmon0/temp1_input', '68000\n'],
    ['/sys/class/hwmon/hwmon1/name', 'nvme\n'],
    ['/sys/class/hwmon/hwmon1/temp1_input', '63850'],
    ['/sys/class/hwmon/hwmon1/temp1_label', 'Composite'],
    ['/sys/class/hwmon/hwmon1/temp2_input', '63850'],
    ['/sys/class/hwmon/hwmon1/temp2_label', 'Sensor 1'],
    ['/sys/class/hwmon/hwmon2/name', 'k10temp'],
    ['/sys/class/hwmon/hwmon2/temp1_input', '68750'],
    ['/sys/class/hwmon/hwmon3/name', 'amdgpu'],
    ['/sys/class/hwmon/hwmon3/temp1_input', '64000'],
    ['/sys/class/thermal/thermal_zone0/type', 'acpitz'],
    ['/sys/class/thermal/thermal_zone0/temp', '68000'],
    ['/sys/class/thermal/thermal_zone1/type', 'other'],
    ['/sys/class/thermal/thermal_zone1/temp', '42000'],
  ]);
  const read = async name => { if (!files.has(name)) throw new Error('ENOENT'); return files.get(name); };
  const list = async name => { if (!entries.has(name)) throw new Error('ENOENT'); return entries.get(name); };
  const sensors = await linuxTemperatureReadings({ list, read });
  assert.deepEqual(sensors, [
    { name: 'k10temp: temp1', celsius: 68.8 },
    { name: 'amdgpu: temp1', celsius: 64 },
    { name: 'nvme: Composite', celsius: 63.9 },
    { name: 'nvme: Sensor 1', celsius: 63.9 },
    { name: 'acpitz: temp1', celsius: 68 },
    { name: 'Thermal 1', celsius: 42 },
  ]);
});

test('Linux rejects out-of-range, unlabelled and unsafe hwmon names without inventing measurements', async () => {
  assert.equal(linuxTemperatureValue('999999'), null);
  assert.equal(linuxTemperatureValue('NaN'), null);
  assert.equal(linuxTemperatureValue('0'), 0);
  assert.equal(linuxTemperatureValue('-41000'), null);
  const list = async path => path === '/sys/class/hwmon' ? ['hwmon0']
    : path.endsWith('hwmon0') ? ['temp1_input'] : [];
  const read = async path => path.endsWith('/name') ? 'cpu\ninjected'
    : '55000';
  assert.deepEqual(await linuxTemperatureReadings({ list, read }), []);
  assert.deepEqual(await linuxTemperatureReadings({
    list: async () => { throw new Error('EACCES'); },
    read: async () => { throw new Error('EACCES'); },
  }), []);
});

test('Windows CIM accepts only finite reported temperatures, bounds labels and drops unsafe names', () => {
  const readings = parseWindowsTemperatureReadings(JSON.stringify([
    { name: 'Hardware: CPU Package', celsius: 61.78 },
    { name: 'Hardware: GPU Core', celsius: 65.4 },
    { name: 'Hardware: GPU Core', celsius: 60 },
    { name: 'Hardware: Injection\nName', celsius: 50 },
    { name: 'ACPI Thermal 0', celsius: 32.5 },
    { name: 'Hardware: CPU Fan', celsius: '1200' },
    { name: 'Hardware: invalid', celsius: 1000 },
    { name: 'Hardware: NaN', celsius: null },
  ]));
  assert.deepEqual(readings, [
    { name: 'Hardware: CPU Package', celsius: 61.8 },
    { name: 'Hardware: GPU Core', celsius: 65.4 },
    { name: 'Hardware: GPU Core (3)', celsius: 60 },
    { name: 'ACPI Thermal 0', celsius: 32.5 },
  ]);
  assert.deepEqual(parseWindowsTemperatureReadings('not json'), []);
  assert.deepEqual(parseWindowsTemperatureReadings('[]'), []);
  assert.match(WINDOWS_TEMPERATURE_SCRIPT, /Get-CimInstance/);
  assert.match(WINDOWS_TEMPERATURE_SCRIPT, /LibreHardwareMonitor/);
  assert.match(WINDOWS_TEMPERATURE_SCRIPT, /OpenHardwareMonitor/);
});

test('Windows uses fixed read-only PowerShell and NVIDIA commands with bounded execution', async () => {
  const calls = [];
  const run = async (program, args, opts) => {
    calls.push({ program, args, opts });
    if (program === 'powershell.exe') return { stdout: '[{"name":"Hardware: CPU Package","celsius":60}]' };
    return { stdout: '55\n62\nN/A\n' };
  };
  assert.deepEqual(await windowsTemperatureReadings({ run }), [
    { name: 'Hardware: CPU Package', celsius: 60 },
    { name: 'NVIDIA GPU 0', celsius: 55 },
    { name: 'NVIDIA GPU 1', celsius: 62 },
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.program), ['powershell.exe','nvidia-smi']);
  assert.ok(calls.every(call => call.opts.timeout <= 5500 && call.opts.maxBuffer <= 32768));
  assert.deepEqual(parseNvidiaTemperatures('30\nNaN\n130\n'), [{ name: 'NVIDIA GPU 0', celsius: 30 }]);
  assert.deepEqual(await windowsTemperatureReadings({
    run: async () => { throw new Error('not installed'); },
  }), []);
});

test('Linux picks up NVIDIA GPU die sensors even without NVIDIA hwmon entries', async () => {
  const temps = await linuxTemperatureReadings({
    list: async () => [],
    read: async () => { throw new Error('not available'); },
    nvidia: async () => [
      { name: 'NVIDIA GPU 0', celsius: 66 },
      { name: 'NVIDIA GPU 1', celsius: 58 },
      { name: 'Injected GPU', celsius: 75 },
    ],
  });
  assert.deepEqual(temps, [
    { name: 'NVIDIA GPU 0', celsius: 66 },
    { name: 'NVIDIA GPU 1', celsius: 58 },
  ]);
});
