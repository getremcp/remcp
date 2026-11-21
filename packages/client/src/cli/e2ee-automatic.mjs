// Establish an OS-vault identity automatically; never silently replace one.
// First browser trust still requires independent owner-local consent.
import {initializeDeviceE2ee,loadDeviceE2eeProfile} from './e2ee-identity.mjs';
const vaultUnavailable=error=>/^E2EE OS vault unavailable or locked;/.test(String(error?.message||''));

// Wait for the signed-in owner to unlock the OS vault; never retry pairing
// mismatches, missing/corrupt identities, or authorization errors.
async function withOwnerVault(task,{report,delay}){
  let retries=0;
  for(;;){
    try{return await task();}catch(error){
      if(!vaultUnavailable(error))throw error;
      if(retries===0)report('ReMCP E2EE: owner OS vault is locked. Waiting for unlock; no unencrypted fallback.');
      const backoff=Math.min(30_000,3_000*2**Math.min(retries,4));
      retries++;
      await delay(backoff);
    }
  }
}
export async function prepareAgentE2eeProfile(config,{
  initialize=initializeDeviceE2ee,load=loadDeviceE2eeProfile,
  report=message=>console.error(message),
  delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  environment=process.env,
}={}){
  if(config.requireE2ee!==undefined&&typeof config.requireE2ee!=='boolean')
    throw new Error('Invalid persisted E2EE requirement: expected boolean');
  if(environment.REMCP_REQUIRE_E2EE!==undefined&&
      !['0','1'].includes(environment.REMCP_REQUIRE_E2EE))
    throw new Error('Invalid REMCP_REQUIRE_E2EE: expected 0 or 1');
  const retry={report,delay};
  if(config.e2eeIdentity===true){
    // Autologin can start before Secret Service / Keychain is unlocked.
    // An established encrypted identity is mandatory and never regenerated.
    return withOwnerVault(()=>load(config),retry);
  }
  if(!config.deviceId||!config.deviceToken||!config.serverUrl)return null;
  const strict=config.requireE2ee===true||environment.REMCP_REQUIRE_E2EE==='1';
  if(strict){
    // First boot with an explicit E2EE requirement must also wait for the
    // owner. Returning null would restart the service on a locked vault.
    await withOwnerVault(()=>initialize(config),retry);
  }else{
    try{await initialize(config);}catch(error){
      // An unavailable owner vault is not an encrypted endpoint. Explicit
      // pairing mismatches or identity-policy failures must never become TLS.
      if(!vaultUnavailable(error))throw error;
      report('Automatic encrypted connection unavailable: unlock the owner OS vault. No encryption identity was replaced.');
      return null;
    }
  }
  const next={...config,e2eeIdentity:true};
  // Persist before exposing the identity. Every later restart must fail closed
  // if this established vault is locked, lost, or bound to another pairing.
  if(typeof config.persistState==='function')await config.persistState({e2eeIdentity:true});
  return strict?withOwnerVault(()=>load(next),retry):load(next);
}
