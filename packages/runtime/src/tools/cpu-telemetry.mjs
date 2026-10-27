// OS-wide CPU utilization over a short bounded interval, not process CPU time or load average.
const timeKeys = ['user', 'nice', 'sys', 'idle', 'irq'];

function totals(cpu) {
  const times = cpu?.times;
  if (!times || !timeKeys.every(key => Number.isFinite(times[key]) && times[key] >= 0)) return null;
  return {
    total: timeKeys.reduce((sum, key) => sum + times[key], 0),
    idle: times.idle,
  };
}

export function cpuUtilizationRatio(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after) || !before.length || before.length !== after.length) return null;
  let deltaTotal = 0;
  let deltaIdle = 0;
  for (let i = 0; i < before.length; i++) {
    const previous = totals(before[i]);
    const current = totals(after[i]);
    if (!previous || !current) return null;
    const total = current.total - previous.total;
    const idle = current.idle - previous.idle;
    if (total < 0 || idle < 0 || idle > total) return null;
    deltaTotal += total;
    deltaIdle += idle;
  }
  return deltaTotal > 0 ? Number(Math.max(0, Math.min(1, 1 - deltaIdle / deltaTotal)).toFixed(3)) : null;
}

export function cpuPerCoreUtilizationRatios(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after) || !before.length ||
      before.length !== after.length || before.length > 256) return null;
  const ratios = before.map((core, index) => cpuUtilizationRatio([core], [after[index]]));
  return ratios.every(value => value !== null) ? ratios : null;
}

export function cpuFrequencyMHz(cores) {
  if (!Array.isArray(cores) || !cores.length) return null;
  const speeds = cores.map(core => core?.speed).filter(speed => Number.isFinite(speed) && speed > 0 && speed <= 100000);
  return speeds.length ? Math.round(speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length) : null;
}
