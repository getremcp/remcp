// Share one owner-private lock for all client OS-vault writes across processes.
// This includes OAuth token rotation and device trust enrollment.
import {configDir} from './env.mjs';
import {withE2eeVaultMutation} from './e2ee-vault-lock.mjs';

export function withEncryptedClientVaultLock(operation,{
  directory=configDir,lock=withE2eeVaultMutation,
}={}){
  return lock(directory,operation);
}
