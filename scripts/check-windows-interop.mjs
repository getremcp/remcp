import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const isPublic=fs.existsSync('packages/client/package.json');
const {assertWindowsInteropPayload}=await import(isPublic?'../packages/client/src/cli/windows-interop-payload.mjs':'../src/cli/windows-interop-payload.mjs');
const policy=JSON.parse(fs.readFileSync('distribution/windows-signing-publishers.json','utf8'));
const requiredSigned=process.argv.includes('--require-signed');
const requiredSourceRelease=process.argv.includes('--require-source-release');
if(requiredSigned&&requiredSourceRelease)
 throw Error('Windows source release and Authenticode DLL gates are mutually exclusive');
const roots=isPublic?[['packages/client','@remcp/remcp','packages/client/src/cli/native/windows'],['packages/runtime','@remcp/runtime','packages/runtime/src/native/windows']]:[['.','@remcp/remcp','src/cli/native/windows'],['runtime','@remcp/runtime','runtime/src/native/windows']];
function rejectBundledExecutables(root){
 const stack=[path.join(root,'src')];
 while(stack.length){
  const directory=stack.pop();
  for(const item of fs.readdirSync(directory,{withFileTypes:true})){
   if(item.name==='node_modules')continue;
   if(item.isSymbolicLink())throw Error('Linked file in source-only release package');
   if(item.isDirectory())stack.push(path.join(directory,item.name));
   else if(/\.(?:dll|exe|node|so|dylib)$/i.test(item.name))
    throw Error('Compiled binary found in source-only release: '+item.name);
  }
 }
}
for(const [root,name,dir] of roots){
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 const packageMode=pkg.remcpWindowsInterop;
 if(requiredSigned&&packageMode===2) throw Error('Source-only Windows package has no bundled DLL to sign');
 if(requiredSourceRelease){
  if(packageMode!==2||pkg.private===true||pkg.remcpBuildProfile!=='dllfree-source-release')
   throw Error('Windows source-only public release package identity is invalid: '+name);
  rejectBundledExecutables(root);
 }
 assertWindowsInteropPayload(path.resolve(root),name);
 const text=fs.readFileSync(path.join(dir,'manifest.mjs'),'utf8');
 const manifest=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));
 for(const [id,item] of Object.entries(manifest)){
  const source=fs.readFileSync(path.join(dir,id+'.cs'));
  if(crypto.createHash('sha256').update(source).digest('hex')!==item.sourceSha256) throw new Error('Windows helper source drift: '+id);
  if(requiredSigned && (item.signatureStatus!=='Valid'||!policy.approvedSha1.includes(item.signerThumbprint))) throw new Error('Windows publisher signature is required before release: '+id);
 }
}
console.log('Windows interop asset integrity verified'+
 (requiredSourceRelease?' as reviewed source-only public release (no bundled DLLs)':
 requiredSigned?' with publisher signatures':'; Authenticode status is recorded in each manifest'));
