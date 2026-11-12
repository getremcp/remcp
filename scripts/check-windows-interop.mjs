import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const isPublic=fs.existsSync('packages/client/package.json');
const {assertWindowsInteropPayload}=await import(isPublic?'../packages/client/src/cli/windows-interop-payload.mjs':'../src/cli/windows-interop-payload.mjs');
const policy=JSON.parse(fs.readFileSync('distribution/windows-signing-publishers.json','utf8'));
const requiredSigned=process.argv.includes('--require-signed');
const roots=isPublic?[['packages/client','@remcp/remcp','packages/client/src/cli/native/windows'],['packages/runtime','@remcp/runtime','packages/runtime/src/native/windows']]:[['.','@remcp/remcp','src/cli/native/windows'],['runtime','@remcp/runtime','runtime/src/native/windows']];
for(const [root,name,dir] of roots){
 assertWindowsInteropPayload(path.resolve(root),name);
 const text=fs.readFileSync(path.join(dir,'manifest.mjs'),'utf8');
 const manifest=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));
 for(const [id,item] of Object.entries(manifest)){
  const source=fs.readFileSync(path.join(dir,id+'.cs'));
  if(crypto.createHash('sha256').update(source).digest('hex')!==item.sourceSha256) throw new Error('Windows helper source drift: '+id);
  if(requiredSigned && (item.signatureStatus!=='Valid'||!policy.approvedSha1.includes(item.signerThumbprint))) throw new Error('Windows publisher signature is required before release: '+id);
 }
}
console.log('Windows interop asset integrity verified'+(requiredSigned?' with publisher signatures':'; Authenticode status is recorded in each manifest'));
