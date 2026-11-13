import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

let reviewedRepair = false;
// Only the explicit CLI repair transaction may rebuild an existing helper store.
// Synchronous package staging is verified before touching that store.
export function withWindowsInteropRepair(enabled, operation) {
 const previous = reviewedRepair;
 reviewedRepair = enabled === true;
 try { return operation(); } finally { reviewedRepair = previous; }
}
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function regular(file) {
 const stat = fs.lstatSync(file);
 if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024*1024) throw new Error('Unsafe Windows helper payload');
}
function repairCache(source, cached, sha) {
 let old = false;
 try { regular(cached); old = true; } catch(error) { if(error.code !== 'ENOENT') throw error; }
 const temporary = cached+'.repair-'+crypto.randomUUID();
 try {
  fs.copyFileSync(source,temporary,fs.constants.COPYFILE_EXCL);
  if (digest(temporary)!==sha) throw new Error('Repair helper integrity mismatch');
  if (old) fs.renameSync(cached,cached+'.previous-'+crypto.randomUUID());
  fs.renameSync(temporary,cached);
  if (digest(cached)!==sha) throw new Error('Repaired helper integrity mismatch');
 } finally { fs.rmSync(temporary,{force:true}); }
}
// Parse data, never execute a staged package's JavaScript during verification.
export function assertWindowsInteropPayload(packageRoot, packageName, options={}) {
 try { verifyPayload(packageRoot, packageName, options); }
 catch (error) { throw new Error('REMCP_WINDOWS_PAYLOAD_BLOCKED: '+error.message,{cause:error}); }
}
function verifyPayload(packageRoot, packageName, {cacheRoot=process.platform==='win32'?path.join(process.env.REMCP_CONFIG_DIR||path.join(os.homedir(),'.config','remcp'),'windows-interop'):null}={}) {
 const pkg=JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8'));
 if (pkg.remcpWindowsInterop !== 1 && pkg.remcpWindowsInterop !== 2) return;
 const sourceOnly=pkg.remcpWindowsInterop===2;
 const client=packageName==='@remcp/remcp';
 const root=path.join(packageRoot,client?'src/cli/native/windows':'src/native/windows');
 const match=fs.readFileSync(path.join(root,'manifest.mjs'),'utf8').match(/^export const WINDOWS_INTEROP =\s*(\{[\s\S]*\});\s*$/);
 if (!match) throw new Error('Invalid Windows interop manifest');
 const manifest=JSON.parse(match[1]);
 const expected=client?['owned-job']:['audio','cursor','displays','foreground','msaa','pointer','ui-mouse','window-action','window-list'];
 if (JSON.stringify(Object.keys(manifest).sort())!==JSON.stringify(expected.slice().sort())) throw new Error('Incomplete Windows interop manifest');
 // Validate the whole package before a repair can modify any existing cache.
 if(sourceOnly&&fs.readdirSync(root).some(file=>/\.dll$/i.test(file)))
  throw new Error('DLL-free package unexpectedly contains native binary');
 for (const id of expected) {
  const item=manifest[id], file=path.join(root,id+'.dll');
  if(item.releaseVersion!==pkg.version||!/^\d+\.\d+\.\d+$/.test(item.releaseVersion)) throw new Error('Invalid Windows helper identity');
  if(sourceOnly){
   const source=path.join(root,id+'.cs');
   if(item.file!==id+'.cs'||!/^[a-f0-9]{64}$/.test(item.sourceSha256)||
      item.sha256!==item.sourceSha256||item.signatureStatus!=='NotApplicable')
    throw new Error('Invalid pinned Windows C# source manifest');
   regular(source);
   if(digest(source)!==item.sourceSha256) throw new Error('Windows C# helper integrity mismatch: '+id);
   continue;
  }
  if(item.file!==id+'.dll'||!/^[a-f0-9]{64}$/.test(item.sha256))
   throw new Error('Invalid Windows helper identity');
  regular(file);
  if(digest(file)!==item.sha256) throw new Error('Windows helper integrity mismatch: '+id);
 }
 if(sourceOnly||!cacheRoot) return;
 for(const id of expected) {
  const item=manifest[id], version=path.join(cacheRoot,item.releaseVersion), store=path.join(version,id+'-'+item.sha256);
  for(const directory of [cacheRoot,version,store]) {
   try { const stat=fs.lstatSync(directory); if(!stat.isDirectory()||stat.isSymbolicLink()) throw new Error('Unsafe Windows helper store'); }
   catch(error) { if(error.code!=='ENOENT') throw error; }
  }
  if(!fs.existsSync(store)) continue;
  const cached=path.join(store,item.file);
  try { regular(cached); if(digest(cached)!==item.sha256) throw new Error('Installed helper was changed: '+id); }
  catch(error) {
   if(!reviewedRepair) throw error;
   repairCache(path.join(root,item.file),cached,item.sha256);
  }
 }
}
