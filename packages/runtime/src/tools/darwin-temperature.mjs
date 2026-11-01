// Optional Apple Silicon native sensor adapter. A missing/denied sensor never
// becomes a fabricated zero: the caller can display "unavailable" explicitly.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CHANNELS = [
  ['cpu', 'CPU'],
  ['soc', 'SoC'],
  ['gpu', 'GPU'],
];

export function normalizeDarwinTemperatures(sample) {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return [];
  return CHANNELS.flatMap(([key, name]) => {
    const value = sample[key];
    // The native package uses 0 when hardware did not expose a channel.
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 125)
      return [];
    return [{ name, celsius: Number(value.toFixed(1)) }];
  });
}

// No shell, sudo, arbitrary execution or runtime download. The optional native
// module is installed by the platform's ordinary, version-pinned npm workflow.
export function darwinTemperatureReadings(loadSensor = () => require('macos-temperature-sensor')) {
  try {
    const sensor = loadSensor();
    if (!sensor || typeof sensor.temperature !== 'function') return [];
    return normalizeDarwinTemperatures(sensor.temperature());
  } catch {
    // Unsupported chip, missing optional package and permission failures all
    // remain "unknown", not a healthy-looking temperature of 0°C.
    return [];
  }
}
