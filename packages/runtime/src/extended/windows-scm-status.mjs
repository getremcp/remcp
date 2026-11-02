// SCM is much cheaper than loading Windows PowerShell on a pressured VM.
// Keep the existing Get-Service JSON contract and fall back when output is
// localized or cannot be parsed reliably.
export function parseWindowsServiceStatus(query, config, requestedName) {
  const value = (source, key) => String(source).match(new RegExp(
    '^\\s*' + key + '\\s*:\\s*(.*?)\\r?$', 'mi'))?.[1]?.trim();
  const queryName = value(query, 'SERVICE_NAME');
  const configName = value(config, 'SERVICE_NAME');
  const state = Number(value(query, 'STATE')?.match(/^(\d+)(?:\s|$)/)?.[1]);
  const start = Number(value(config, 'START_TYPE')?.match(/^(\d+)(?:\s|$)/)?.[1]);
  const displayName = value(config, 'DISPLAY_NAME');
  if (!requestedName || !queryName || !configName ||
      queryName.toLowerCase() !== requestedName.toLowerCase() ||
      configName.toLowerCase() !== queryName.toLowerCase() ||
      !Number.isInteger(state) || state < 1 || state > 7 ||
      !Number.isInteger(start) || start < 0 || start > 4 ||
      !displayName || displayName.includes('\uFFFD')) return null;
  return { Name: queryName, DisplayName: displayName, Status: state, StartType: start };
}
