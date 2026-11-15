// Persistent device-to-client E2EE requirement: an explicit owner safety
// policy, not an implementation of E2EE. Hosted transport is TLS-only today.
import process from 'node:process';
import { loadConfig, saveConfig } from './config.mjs';
import { restartPersistentServiceIfInstalled } from './service.mjs';

export function persistedE2eeRequired(config) {
  const value = config?.requireE2ee;
  if (value !== undefined && value !== true && value !== false)
    throw new Error('Invalid persisted E2EE requirement: expected boolean');
  return value === true;
}

export function effectiveE2eeRequirement(config, environment = process.env) {
  const stored = persistedE2eeRequired(config);
  const env = environment?.REMCP_REQUIRE_E2EE;
  if (env !== undefined && env !== '0' && env !== '1')
    throw new Error('Invalid REMCP_REQUIRE_E2EE: expected 0 or 1');
  return stored || env === '1';
}

export function setE2eeRequirement(config, required, {
  persist = saveConfig, restart = restartPersistentServiceIfInstalled,
} = {}) {
  if (typeof required !== 'boolean') throw new TypeError('E2EE requirement must be boolean');
  const changed = persistedE2eeRequired(config) !== required;
  if (!changed && !required) return null;
  const next = { ...config, requireE2ee: required };
  if (changed) persist(next);
  // Repeating 'require' must retry a previously failed supervisor restart:
  // a saved policy alone cannot revoke an already connected TLS-only agent.
  return restart(next, { deferLinux: true, deferWindows: true });
}

export function manageE2eePolicy(action = 'status') {
  const config = loadConfig(false) || {};
  const mode = String(action || 'status').toLowerCase();
  if (mode === 'status') {
    console.log(JSON.stringify({
      required: effectiveE2eeRequirement(config),
      persisted: persistedE2eeRequired(config),
      available: false,
      transport: 'tls-only',
      behavior: 'An E2EE requirement refuses hosted relay connections; it does not enable E2EE.',
    }, null, 2));
    return;
  }
  if (!['require', 'on', 'off'].includes(mode))
    throw new Error('Usage: remcp e2ee [status|require|off]');
  const required = mode !== 'off';
  const restarted = setE2eeRequirement(config, required);
  if (required) {
    console.log('E2EE required: ReMCP will refuse TLS-only relay connections until genuine E2EE is implemented.');
  } else {
    console.log('Persistent E2EE requirement disabled; REMCP_REQUIRE_E2EE=1 still takes precedence.');
  }
  console.log(restarted
    ? 'Background agent reload requested: ' + restarted + '.'
    : 'Restart any manually managed agent to apply this policy to an existing connection.');
}
