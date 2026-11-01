// Optional read-only Windows temperature sources. Windows has no universal
// built-in API for CPU/GPU/SSD temperatures: report only exposed real sensors.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nvidiaTemperatureReadings } from './nvidia-temperature.mjs';
export { parseNvidiaTemperatures } from './nvidia-temperature.mjs';

const exec = promisify(execFile);
const MAX_SENSORS = 64;
const CLEAN_LABEL = /^[A-Za-z0-9_.:+#() -]{1,60}$/;

// Fixed PowerShell source, with no user-supplied script text or arguments.
export const WINDOWS_TEMPERATURE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$rows = [System.Collections.Generic.List[object]]::new()",
  "foreach ($namespace in @('root\\LibreHardwareMonitor','root\\OpenHardwareMonitor')) {",
  "  try {",
  "    $sensors = @(Get-CimInstance -Namespace $namespace -ClassName Sensor -ErrorAction Stop)",
  "    foreach ($sensor in $sensors) {",
  "      if ($sensor.SensorType -ne 'Temperature') { continue }",
  "      $rows.Add(@{ name = ('Hardware: ' + [string]$sensor.Name); celsius = $sensor.Value })",
  "      if ($rows.Count -ge 64) { break }",
  "    }",
  "    if ($rows.Count -gt 0) { break }",
  "  } catch { }",
  "}",
  "try {",
  "  $zones = @(Get-CimInstance -Namespace 'root\\wmi' -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop)",
  "  $index = 0",
  "  foreach ($zone in $zones) {",
  "    $raw = [double]$zone.CurrentTemperature",
  "    $rows.Add(@{ name = ('ACPI Thermal ' + $index); celsius = (($raw / 10) - 273.15) })",
  "    $index += 1",
  "    if ($rows.Count -ge 64) { break }",
  "  }",
  "} catch { }",
  "ConvertTo-Json -InputObject @($rows.ToArray()) -Compress -Depth 3",
].join('\n');

export function parseWindowsTemperatureReadings(stdout) {
  let values;
  try { values = JSON.parse(String(stdout || '')); } catch { return []; }
  if (!Array.isArray(values)) values = values && typeof values === 'object' ? [values] : [];
  const sensors = [];
  const names = new Set();
  for (const raw of values.slice(0, 128)) {
    const baseName = String(raw?.name ?? '').trim();
    const value = raw?.celsius;
    if (!CLEAN_LABEL.test(baseName) || typeof value !== 'number' ||
        !Number.isFinite(value) || value < -40 || value > 125) continue;
    // Separate GPUs/cores can expose identical labels through the same WMI
    // provider; retain every valid channel with a deterministic index.
    let name = baseName;
    if (names.has(name)) name = baseName + ' (' + (sensors.length + 1) + ')';
    if (!CLEAN_LABEL.test(name) || names.has(name)) continue;
    names.add(name);
    sensors.push({ name, celsius: Number(value.toFixed(1)) });
    if (sensors.length >= MAX_SENSORS) break;
  }
  return sensors;
}

export async function windowsTemperatureReadings({ run = exec } = {}) {
  const [cim, nvidia] = await Promise.all([
    run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-Command', WINDOWS_TEMPERATURE_SCRIPT], {
      windowsHide: true, timeout: 5500, maxBuffer: 32768,
    }).then(result => parseWindowsTemperatureReadings(result.stdout)).catch(() => []),
    nvidiaTemperatureReadings({ run }),
  ]);
  const names = new Set(cim.map(item => item.name));
  for (const item of nvidia) if (!names.has(item.name) && cim.length < MAX_SENSORS) {
    cim.push(item); names.add(item.name);
  }
  return cim;
}
