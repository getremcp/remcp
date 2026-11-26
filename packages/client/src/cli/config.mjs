// The paired configuration and the two switches that live beside it: usage metrics and the machine id
// the server uses to recognise this computer across pairings.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeRuntime } from '../runtime.mjs';
import { replaceFileAtomically } from './atomic-file.mjs';

import { configDir, configFile, machineIdFile, officialOrigin, runtimeConfigFile } from './env.mjs';

export const CONFIG_SCHEMA_VERSION = 1;
const legacyOfficialOrigins = new Set(['https://remcp.delio24.com']);

function migrateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ReMCP config must be a JSON object');
  const declared = Number(value.configSchemaVersion || 0);
  // A newer client may have added fields this client does not understand. Preserve that document
  // byte-for-meaning and only use the known fields below; never downgrade its schema marker.
  if (Number.isSafeInteger(declared) && declared > CONFIG_SCHEMA_VERSION) return { value: { ...value }, changed: false };

  let next = { ...value };
  let changed = false;
  if (declared < 1) {
    try {
      const server = new URL(String(next.serverUrl || ''));
      if (legacyOfficialOrigins.has(server.origin)) {
        next.serverUrl = officialOrigin;
        if (next.trustRuntime === undefined) next.trustRuntime = true;
        changed = true;
      }
    } catch {}
    if (next.configSchemaVersion !== CONFIG_SCHEMA_VERSION) {
      next.configSchemaVersion = CONFIG_SCHEMA_VERSION;
      changed = true;
    }
  }
  return { value: next, changed };
}

function configForWrite(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ReMCP config must be a JSON object');
  const declared = Number(value.configSchemaVersion || 0);
  return {
    ...value,
    configSchemaVersion: Number.isSafeInteger(declared) && declared > CONFIG_SCHEMA_VERSION
      ? declared
      : CONFIG_SCHEMA_VERSION,
  };
}

function isFutureConfig(value) {
  const declared = Number(value?.configSchemaVersion || 0);
  return Number.isSafeInteger(declared) && declared > CONFIG_SCHEMA_VERSION;
}

export function loadConfig(required = true) {
  if (!fs.existsSync(configFile)) {
    if (!required) return undefined;
    throw new Error(`ReMCP is not paired. Generate a pairing command at ${officialOrigin}/app/connect`);
  }
  const migrated = migrateConfig(JSON.parse(fs.readFileSync(configFile, 'utf8')));
  const value = migrated.value;
  // A configuration that only carries preferences (for example after `remcp auto-update off`
  // before pairing) has no runtime yet; it must not fail as if it were corrupt.
  if (value.runtime !== undefined) value.runtime = normalizeRuntime(value.runtime);
  if (migrated.changed) saveConfig(value);
  return value;
}

export function saveConfig(value) {
  const persisted = configForWrite(value);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  replaceFileAtomically(configFile, JSON.stringify(persisted, null, 2) + '\n', { mode: 0o600 });
}

export function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

export function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  replaceFileAtomically(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export function autoUpdateEnabled(config) {
  // This preference controls the two first-party ReMCP npm packages only. It never
  // upgrades the Node.js interpreter or npm itself. All supported OSes keep the
  // historical default of automatic ReMCP releases unless the owner opts out.
  // Updates use the verified managed service prefix, not a shared global prefix.
  return config?.autoUpdate !== false;
}

export function flagEnabled(value) {
  return value === undefined || value === null ? true : value !== false;
}

// One switch for the whole machine: the client and the runtime it spawns must agree,
// otherwise the runtime would keep reporting after the user opted out.
export function telemetryState() {
  const client = readJsonFile(configFile);
  const runtime = readJsonFile(runtimeConfigFile);
  const clientEnabled = flagEnabled(client.telemetryEnabled);
  const runtimeEnabled = flagEnabled(runtime.telemetryEnabled);
  return {
    enabled: clientEnabled && runtimeEnabled,
    clientEnabled,
    runtimeEnabled,
    installReported: client.installReported === true,
    configFile,
    runtimeConfigFile,
    transport: 'paired-agent-only',
    endpoint: null,
    collects: 'tool names, durations, outcomes, error classes, and device health samples',
    neverCollects: 'file paths, file contents, command strings, tool arguments, and tool output',
    thirdParty: false,
    installPing: false,
    remoteFeatureFlags: false,
  };
}

// Mutations may initialize missing files, but must never replace unreadable or
// malformed files. Read both before writing either one.
function readJsonForMutation(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new Error('ReMCP configuration is not valid JSON; no preferences were changed'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ReMCP configuration must be a JSON object; no preferences were changed');
  }
  return value;
}

export function setTelemetry(enabled) {
  const client = readJsonForMutation(configFile);
  const runtime = readJsonForMutation(runtimeConfigFile);
  client.telemetryEnabled = enabled;
  writeJsonFile(configFile, client);
  runtime.telemetryEnabled = enabled;
  writeJsonFile(runtimeConfigFile, runtime);
  return telemetryState();
}

export function ensureMachineId() {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  try {
    const existing = fs.readFileSync(machineIdFile, 'utf8').trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) return existing;
  } catch {}
  const value = randomUUID();
  fs.writeFileSync(machineIdFile, value + '\n', { mode: 0o600 });
  fs.chmodSync(machineIdFile, 0o600);
  return value;
}

// An older CLI can display basic local metadata and change familiar opt-out
// switches without interpreting the newer runtime or invoking its supervisor.
// No credentials, runtime payloads, or server requests belong in this path.
export function handleFutureConfigCommand(command, action, version) {
  if (!['status', 'doctor', 'auto-update', 'telemetry', 'godmode', 'unrestricted'].includes(command)) return false;
  const value = readJsonForMutation(configFile);
  if (!isFutureConfig(value)) return false;
  const warning = 'Newer ReMCP configuration schema; use a compatible client to inspect or restart the agent.';
  if (command === 'status' || command === 'doctor') {
    console.log(JSON.stringify({
      version, configured: Boolean(value.deviceId && value.deviceToken),
      configSchemaVersion: Number(value.configSchemaVersion), supportedConfigSchemaVersion: CONFIG_SCHEMA_VERSION,
      autoUpdate: autoUpdateEnabled(value), telemetry: {enabled:telemetryState().enabled},
      diagnosis: {verdict:'unsupported-config-schema', message:warning},
    }, null, 2));
    if (command === 'doctor') process.exitCode = 1;
    return true;
  }
  const mode = String(action || 'status').toLowerCase();
  if (command === 'godmode' || command === 'unrestricted') {
    if (mode === 'status') return false;
    throw new Error(warning + ' Unrestricted mode was not changed.');
  }
  if (mode === 'status') {
    console.log(JSON.stringify(command === 'auto-update'
      ? {autoUpdate:autoUpdateEnabled(value), warning}
      : {...telemetryState(), warning}, null, 2));
    return true;
  }
  if (!['on','enable','off','disable'].includes(mode)) throw new Error('Usage: remcp ' + command + ' [status|on|off]');
  const enabled = mode === 'on' || mode === 'enable';
  if (command === 'auto-update') saveConfig({...value, autoUpdate:enabled});
  else console.log(JSON.stringify(setTelemetry(enabled), null, 2));
  console.log('Preference saved. Agent was not restarted. ' + warning);
  return true;
}
