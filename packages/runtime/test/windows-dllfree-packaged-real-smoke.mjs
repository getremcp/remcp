// Manual QA only: run the actual locally packed DLL-free client and runtime
// on an isolated real Windows user desktop. Never changes installed ReMCP.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

if(process.platform!=='win32')throw Error('This smoke requires real Windows');
const qa=path.resolve(process.argv[2]||'');
const profile=process.argv[3]||'dllfree-source-qa';
if(!/remcp-cu-dllfree-pack-(?:qa|release)-[a-z0-9-]+$/i.test(path.basename(qa))||
 !['dllfree-source-qa','dllfree-source-release'].includes(profile))
 throw Error('Only an isolated ReMCP DLL-free QA or release-preview directory is allowed');
if(!fs.statSync(qa).isDirectory()||fs.lstatSync(qa).isSymbolicLink())
 throw Error('QA directory must be a real directory');
const expected={
 client:{name:'@remcp/remcp',ids:['owned-job'],loader:'src/cli/windows-interop.mjs'},
 runtime:{name:'@remcp/runtime',ids:['audio','cursor','displays','foreground',
  'msaa','pointer','ui-mouse','window-action','window-list'],
  loader:'src/extended/windows-interop.mjs'},
};
let count=0;
for(const [kind,config] of Object.entries(expected)){
 const root=path.join(qa,kind,'package');
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 assert.equal(pkg.name,config.name);
 assert.equal(pkg.version,'0.2.252');
 assert.equal(pkg.remcpWindowsInterop,2);
 if(profile==='dllfree-source-qa')assert.equal(pkg.private,true);
 else assert.notEqual(pkg.private,true);
 assert.equal(pkg.remcpBuildProfile,profile);
 const nativeDir=path.join(root,kind==='client'?'src/cli/native/windows':
   'src/native/windows');
 const nativeFiles=fs.readdirSync(nativeDir);
 assert.equal(nativeFiles.filter(f=>f.toLowerCase().endsWith('.dll')).length,0);
 assert.equal(nativeFiles.filter(f=>f.endsWith('.cs')).length,config.ids.length);
 const manifestSource=fs.readFileSync(path.join(nativeDir,'manifest.mjs'),'utf8');
 const match=manifestSource.match(/^export const WINDOWS_INTEROP =\s*(\{[\s\S]*\});\s*$/);
 assert.ok(match,'manifest must be declarative data, not executable logic');
 const manifest=JSON.parse(match[1]);
 assert.deepEqual(Object.keys(manifest).sort(),[...config.ids].sort());
 for(const id of config.ids){
  const item=manifest[id];
  assert.equal(item.signatureStatus,'NotApplicable');
  assert.equal(item.file,id+'.cs');
  assert.equal(item.sha256,item.sourceSha256);
  assert.equal(item.releaseVersion,pkg.version);
 }
 const {windowsInteropLoad}=await import(pathToFileURL(path.join(root,config.loader)).href);
 for(const id of config.ids){
  const code=windowsInteropLoad(id);
  assert.ok(code.includes('ComputeHash($remcpBytes)'));
  assert.ok(code.includes('Add-Type -TypeDefinition'));
  assert.ok(!code.includes('Assembly]::LoadFrom'));
  const script=`[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false;
${code}
Write-Output 'REMCP_DLLFREE_SOURCE_QA_OK'`;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive',
    '-Command',script],{
    encoding:'utf8',windowsHide:true,timeout:25000,maxBuffer:1024*256,
  });
  assert.equal(result.error,undefined,kind+':'+id+': process start failed');
  assert.equal(result.status,0,kind+':'+id+': compilation failed '+
    String(result.stderr||'').slice(0,350));
  assert.match(result.stdout,/REMCP_DLLFREE_SOURCE_QA_OK/);
  count++;
  console.log('SOURCE_HELPER_COMPILED '+kind+'/'+id);
 }
}
assert.equal(count,10);
console.log('WINDOWS_REAL_PACKAGED_DLLFREE_QA_PASS_10_OF_10');
// Exercise the real packaged supervisor, not just isolated C# compilation.
// The child performs a benign console print; the helper must prove its owned
// kernel job is empty before reporting success. Never touch installed services.
const {spawnWindowsOwnedJob}=await import(pathToFileURL(path.join(qa,
 'client','package','src','cli','windows-owned-job.mjs')).href);
const log=path.join(qa,'dllfree-owned-job-qa.log');
assert.equal(fs.existsSync(log),false,'QA-owned log must be fresh');
const child=spawnWindowsOwnedJob(process.execPath,
 ['-e',"console.log('REMCP_DLLFREE_JOB_CHILD_OK')"],{cwd:qa,log});
try{
 await child.ownedJob.ready;
 assert.ok(child.ownedJob.pid>0);
 await child.ownedJob.done;
 assert.equal(child.ownedJob.confirmedEmpty,true);
 assert.match(fs.readFileSync(log,'utf8'),/REMCP_DLLFREE_JOB_CHILD_OK/);
 console.log('WINDOWS_DLLFREE_PACKAGED_OWNED_JOB_CONFIRMED_EMPTY');
}finally{
 if(!child.ownedJob.confirmedEmpty&&child.exitCode===null)
  child.kill();
}
