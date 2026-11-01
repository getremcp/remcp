// The paired configuration and the two switches that live beside it: usage metrics and the machine id
// the server uses to recognise this computer across pairings.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { normalizeRuntime } from '../runtime.mjs';

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
  fs.writeFileSync(configFile, JSON.stringify(persisted, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(configFile, 0o600);
}

export function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

export function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function autoUpdateEnabled(config, platform = process.platform) {
  // Linux often runs unrelated applications through the same global npm prefix. Never
  // mutate that prefix implicitly: require `remcp auto-update on` for Linux agents.
  // Keep the historical preference for existing explicit opt-ins and other platforms.
  if (config?.autoUpdate === true) return true;
  if (config?.autoUpdate === false) return false;
  return platform !== 'linux';
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

export function setTelemetry(enabled) {
  const client = readJsonFile(configFile);
  client.telemetryEnabled = enabled;
  writeJsonFile(configFile, client);
  const runtime = readJsonFile(runtimeConfigFile);
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
