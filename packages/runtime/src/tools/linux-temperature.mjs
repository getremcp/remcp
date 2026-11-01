// Linux exposes multiple independent hardware temperature channels through hwmon and
// thermal zones. Never stop at the first thermal zone: that hides real CPU/GPU/SSD data.
import { readFile as kernelRead, readdir as kernelList } from 'node:fs/promises';
import { nvidiaTemperatureReadings } from './nvidia-temperature.mjs';

const CHIP = /^[A-Za-z0-9_.+-]{1,32}$/;
const LABEL = /^[A-Za-z0-9_.:+#() -]{1,40}$/;
const SAFE_NAME = /^[A-Za-z0-9_.:+#() -]{1,60}$/;
const SENSOR_LIMIT = 64;

export function linuxTemperatureValue(raw) {
  const input = String(raw || '').trim();
  if (!/^-?\d{1,7}$/.test(input)) return null;
  const celsius = Number(input) / 1000;
  return Number.isFinite(celsius) && celsius >= -40 && celsius <= 125
    ? Number(celsius.toFixed(1)) : null;
}

const priority = name => /^(?:k10temp|coretemp|zenpower|cpu)/i.test(name) ? 0
  : /^(?:amdgpu|nvidia|gpu)/i.test(name) ? 1
    : /^nvme/i.test(name) ? 2 : 3;

export async function linuxTemperatureReadings({
  list = kernelList, read = kernelRead, nvidia = nvidiaTemperatureReadings,
} = {}) {
  const entries = [];
  const chips = [];
  const seen = new Set();
  const boundedFile = async name => {
    const value = String(await read(name, 'utf8'));
    return value.length <= 128 ? value.trim() : '';
  };
  const add = (name, value, chip = '') => {
    if (value === null || !SAFE_NAME.test(name) || seen.has(name)) return;
    entries.push({ name, celsius: value, chip });
    seen.add(name);
  };

  try {
    const dirs = (await list('/sys/class/hwmon'))
      .filter(name => /^hwmon\d{1,3}$/.test(name)).slice(0, 32);
    for (const dir of dirs) {
      const base = '/sys/class/hwmon/' + dir;
      let chip;
      try { chip = await boundedFile(base + '/name'); } catch { continue; }
      if (!CHIP.test(chip)) continue;
      chips.push(chip);
      let inputs = [];
      try { inputs = (await list(base)).filter(name => /^temp(?:[1-9]|[1-9]\d)_input$/.test(name)).slice(0, 32); }
      catch { continue; }
      for (const file of inputs) {
        const index = file.match(/^temp(\d+)_input$/)[1];
        try {
          const value = linuxTemperatureValue(await boundedFile(base + '/' + file));
          let label = '';
          try { label = await boundedFile(base + '/temp' + index + '_label'); } catch { /* Optional. */ }
          if (!LABEL.test(label)) label = 'temp' + index;
          const baseName = chip + ': ' + label;
          // Multiple NVMe drives can share the same chip/label. Preserve each
          // physical channel using its hwmon ID rather than dropping it.
          add(seen.has(baseName) ? chip + '(' + dir + '): ' + label : baseName, value, chip);
        } catch { /* Optional or inaccessible hardware channel. */ }
      }
    }
  } catch { /* No hwmon inventory (VMs, containers, hardened hosts). */ }

  // Thermal zones can expose additional independent channels. Drop an exact
  // ACPI duplicate when hwmon already reports the same chip and temperature.
  try {
    const zones = (await list('/sys/class/thermal'))
      .filter(name => /^thermal_zone\d{1,3}$/.test(name)).slice(0, 32);
    for (const zone of zones) {
      const base = '/sys/class/thermal/' + zone;
      try {
        const value = linuxTemperatureValue(await boundedFile(base + '/temp'));
        const type = await boundedFile(base + '/type').catch(() => '');
        const duplicate = CHIP.test(type) && entries.some(row =>
          row.chip === type && value !== null && Math.abs(row.celsius - value) <= 0.1);
        if (!duplicate) add('Thermal ' + zone.slice('thermal_zone'.length), value);
      } catch { /* Optional or inaccessible thermal zone. */ }
    }
  } catch { /* No thermal zones. */ }
  // The proprietary NVIDIA driver may not expose GPU temperatures via hwmon.
  // Query its read-only tool using fixed arguments; missing drivers mean unknown.
  const vendorGpu = await nvidia().catch(() => []);
  for (const item of Array.isArray(vendorGpu) ? vendorGpu.slice(0, 16) : []) {
    if (!/^NVIDIA GPU (?:[0-9]|1[0-5])$/.test(item?.name)) continue;
    const value = typeof item.celsius === 'number' && Number.isFinite(item.celsius) &&
      item.celsius >= 0 && item.celsius <= 125 ? item.celsius : null;
    add(item.name, value, 'nvidia');
  }
  // Prefer measured CPU and GPU channels for the compact overview widget.
  return entries.sort((a, b) => priority(a.chip) - priority(b.chip))
    .slice(0, SENSOR_LIMIT).map(({ name, celsius }) => ({ name, celsius }));
}
