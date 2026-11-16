// Owner-controlled encryption identity, peer grants, and no-downgrade policy.
import process from 'node:process';
import { loadConfig, saveConfig } from './config.mjs';
import { manageEncryptedClient } from './e2ee-client-profile.mjs';
import { loadDeviceE2eeProfile, initializeDeviceE2ee, manageE2eePeer } from './e2ee-identity.mjs';
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

export async function describeLocalE2ee(config){
  const requirementConfigured=effectiveE2eeRequirement(config);
  try{
    const profile=await loadDeviceE2eeProfile(config);
    return {requirementConfigured,available:Boolean(profile),
      transport:profile?'remcp-hpke-auth-p256-v1':'tls-only',liveSessionVerified:false,
      ...(profile?{fingerprint:profile.identity.fingerprint}:{})};
  }catch{
    return {requirementConfigured,available:false,transport:'unavailable',liveSessionVerified:false,
      reason:'OS vault locked or local pairing no longer matches its encryption identity'};
  }
}
export async function manageE2eePolicy(action = 'status', flags = {}) {
  const config = loadConfig(false) || {};
  const mode = String(action || 'status').toLowerCase();
  if (mode.startsWith('client-')) {
    console.log(JSON.stringify(await manageEncryptedClient(mode,flags),null,2));
    return;
  }
  if (mode === 'init' || mode === 'rotate') {
    const publicIdentity = await initializeDeviceE2ee(config,{rotate:mode==='rotate'});
    const next = { ...config, e2eeIdentity:true };
    saveConfig(next);
    console.log(JSON.stringify({ ...publicIdentity, device:config.deviceId,
      next:'Verify the client fingerprint independently, then use remcp e2ee trust --public-key <key> --fingerprint <fingerprint> --mode read|control. remcp e2ee require rejects plaintext tool calls.' }, null, 2));
    restartPersistentServiceIfInstalled(next, { deferLinux:true, deferWindows:true });
    return;
  }
  if (['trust','peers','revoke'].includes(mode)) {
    console.log(JSON.stringify(await manageE2eePeer(config, mode, flags), null, 2));
    if(mode==='revoke')restartPersistentServiceIfInstalled(config,{deferLinux:true,deferWindows:true});
    return;
  }
  if (mode === 'status') {
    const status = await describeLocalE2ee(config);
    console.log(JSON.stringify({
      required: effectiveE2eeRequirement(config),
      persisted: persistedE2eeRequired(config),
      ...status,
      behavior: 'Strict mode accepts only authenticated encrypted tool calls from locally pinned peers.',
    }, null, 2));
    return;
  }
  if (!['require', 'on', 'off'].includes(mode))
    throw new Error('Usage: remcp e2ee [init|rotate|status|require|off|trust|peers|revoke]');
  const required = mode !== 'off';
  const restarted = setE2eeRequirement(config, required);
  if (required) {
    console.log('E2EE required: plaintext tool calls are refused. An initialized OS-vault identity and a trusted client are required.');
  } else {
    console.log('Persistent E2EE requirement disabled; REMCP_REQUIRE_E2EE=1 still takes precedence.');
  }
  console.log(restarted
    ? 'Background agent reload requested: ' + restarted + '.'
    : 'Restart any manually managed agent to apply this policy to an existing connection.');
}
