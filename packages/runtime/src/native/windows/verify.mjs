import fs from 'node:fs';
import crypto from 'node:crypto';
import { WINDOWS_INTEROP } from './manifest.mjs';

// Advertise Windows tools only after the package's immutable helper bytes are
// present. This verifies package integrity; Authenticode status is separate.
export function verifyWindowsInterop({platform=process.platform}={}) {
 if(platform!=='win32')return;
 for(const [id,item] of Object.entries(WINDOWS_INTEROP)){
  const file=new URL(item.file,import.meta.url);
  try{
   const stat=fs.lstatSync(file);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw new Error('Invalid helper file');
   const hash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
   if(hash!==item.sha256)throw new Error('Helper digest mismatch');
  }catch{throw new Error('REMCP_WINDOWS_PAYLOAD_BLOCKED: Windows helper unavailable or altered: '+id);}
 }
}
