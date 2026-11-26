// macOS keeps the launchd/npm entry path stable. Every promoted release
// has its own full dependency tree; only the entry symlink is switched.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {withWindowsUpdateLock} from './windows-update-lock.mjs';

export function withMacReleaseMutation(prefix,operation){
 return withWindowsUpdateLock(prefix,operation,'macOS');
}

const ENTRY=path.join('lib','node_modules','@remcp','remcp','bin','remcp.mjs');
const RELEASE=/^\.remcp-release-[0-9a-f-]{36}$/;
const rootOf=prefix=>path.resolve(prefix);
const anchorOf=prefix=>path.join(prefix,ENTRY);
function stat(file){try{return fs.lstatSync(file);}catch(error){if(error.code!=='ENOENT')throw error;return null;}}
function real(file){try{return fs.realpathSync(file);}catch{return null;}}
function inside(root,file){const rel=path.relative(root,file);return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);}
function ownedRelease(stage){
 try{
   const marker=path.join(stage,'.remcp-release-owner');
   return stat(stage)?.isDirectory()&&stat(marker)?.isFile()&&stat(marker)?.uid===stat(stage)?.uid&&fs.statSync(marker).size<100&&
     fs.readFileSync(marker,'utf8')===path.basename(stage)+'\n';
 }catch{return false;}
}
function stagedEntry(entry){
 if(!entry?.endsWith(path.sep+ENTRY))return null;
 const stage=entry.slice(0,-(ENTRY.length+1));
 return RELEASE.test(path.basename(stage))&&ownedRelease(stage)?{stage,prefix:path.dirname(stage)}:null;
}
export function activeMacReleasePrefix(prefix){
 const root=real(prefix)||rootOf(prefix);
 const entry=real(anchorOf(root));
 const staged=stagedEntry(entry);
 return staged?.prefix===root?staged.stage:root;
}
// Even when launched from a retained immutable release, service repair and
// saved service identity must always refer to the stable switch point.
export function stableMacCliPath(cli){
 const absolute=path.resolve(cli);
 const resolved=real(absolute);
 const staged=stagedEntry(resolved||absolute);
 if(staged&&activeMacReleasePrefix(staged.prefix)!==staged.prefix)
   return anchorOf(staged.prefix);
 return resolved||absolute;
}
export function macOuterPrefix(prefix){
 const absolute=real(prefix)||rootOf(prefix);
 if(RELEASE.test(path.basename(absolute))&&ownedRelease(absolute))
   return path.dirname(absolute);
 return absolute;
}
function checkedDirectory(file,root){
 const metadata=stat(file);
 if(!metadata?.isDirectory()||metadata.isSymbolicLink()||real(file)!==file||!inside(root,file))
   throw Error('Unsafe macOS release directory: '+file);
}
function manifest(directory,name,exact){
 const file=path.join(directory,'package.json');
 if(!stat(file)?.isFile()||real(file)!==file)throw Error('Unsafe macOS package manifest');
 const root=JSON.parse(fs.readFileSync(file,'utf8'));
 if(root.name!==name||typeof root.version!=='string'||!root.version||
    (exact&&/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(exact)&&root.version!==exact))
   throw Error('macOS staged package identity or version mismatch: '+name);
 return root;
}
function syncFile(file){
 const fd=fs.openSync(file,'r');
 try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function syncTree(root,file=root){
 const metadata=fs.lstatSync(file);
 if(metadata.isSymbolicLink()){
   const target=real(file);
   if(!target||!inside(root,target))throw Error('macOS staged dependency symlink escapes release');
 }else if(metadata.isDirectory()){
   for(const name of fs.readdirSync(file))syncTree(root,path.join(file,name));
   syncFile(file);
 }else if(metadata.isFile())syncFile(file);
 else throw Error('Unexpected macOS staged package entry');
}
// This is a single-file atomic rename, not a sequence of directory moves.
// There is no interval where a previously installed CLI entry is absent.
export function stageAndActivateMacRelease({prefix,packageNames,specs,install,buildAddon}){
 fs.mkdirSync(prefix,{recursive:true});
 prefix=macOuterPrefix(prefix);
 const anchor=anchorOf(prefix),bin=path.join(prefix,'bin','remcp');
 const old=stat(anchor),oldReal=real(anchor);
 if(!old||(!old.isFile()&&!old.isSymbolicLink())||!oldReal)
   throw Error('macOS staged update requires a valid installed ReMCP CLI; repair with the installer first');
 checkedDirectory(path.dirname(anchor),prefix);
 manifest(path.dirname(path.dirname(anchor)),'@remcp/remcp');
 if(old.isSymbolicLink()&&stagedEntry(oldReal)?.prefix!==prefix)
   throw Error('Refusing to replace an unrelated macOS CLI symlink');
 if(!stat(bin)?.isSymbolicLink()||path.resolve(path.dirname(bin),fs.readlinkSync(bin))!==anchor||real(bin)!==oldReal)
   throw Error('Refusing to update an unrelated or missing macOS npm bin/remcp');
 const stage=path.join(prefix,'.remcp-release-'+randomUUID());
 fs.mkdirSync(stage,{mode:0o700});
 const temporary=path.join(path.dirname(anchor),'.remcp-switch-'+randomUUID());
 let committed=false;
 try{
   install(stage);
   for(const name of new Set(packageNames)){
     if(!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name))
       throw Error('Invalid macOS update package name');
     const directory=path.join(stage,'lib','node_modules',...name.split('/'));
     checkedDirectory(directory,stage);
     const exact=specs.find(spec=>String(spec).startsWith(name+'@'))?.slice(name.length+1);
     manifest(directory,name,exact);
   }
   const entry=anchorOf(stage);
   if(!stat(entry)?.isFile()||real(entry)!==entry||!fs.statSync(entry).size)
     throw Error('macOS staged CLI entry is missing');
   if(packageNames.includes('@remcp/runtime')){
     const runtime=path.join(stage,'lib','node_modules','@remcp','runtime');
     const runtimeEntry=path.join(runtime,'src','index.mjs');
     if(!stat(runtimeEntry)?.isFile()||!fs.statSync(runtimeEntry).size)
       throw Error('macOS staged runtime entry is missing');
     buildAddon(runtime);
   }
   // Staging can take minutes and may be interrupted without leaving a
   // mutation lock. Only the promotion and explicit purge share the lock.
   // Until promotion, no ownership marker makes this a purgeable release.
   syncTree(stage);
   withMacReleaseMutation(prefix,()=>{
     const current=stat(anchor);
     if(!current||current.dev!==old.dev||current.ino!==old.ino||real(anchor)!==oldReal||
        (!stat(bin)?.isSymbolicLink()||path.resolve(path.dirname(bin),fs.readlinkSync(bin))!==anchor||real(bin)!==oldReal))
       throw Error('macOS CLI changed during staged update');
     fs.writeFileSync(path.join(stage,'.remcp-release-owner'),path.basename(stage)+'\n',{flag:'wx',mode:0o644});
     fs.chmodSync(stage,0o755);
     syncFile(path.join(stage,'.remcp-release-owner'));syncFile(stage);syncFile(prefix);
     fs.symlinkSync(entry,temporary);
     fs.renameSync(temporary,anchor);
     committed=true;
     syncFile(path.dirname(anchor));
   });
 }finally{
   try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
   if(!committed)fs.rmSync(stage,{recursive:true,force:true});
 }
 return stage;
}


// Removing the launchd job and npm anchor does not establish that no manually
// launched process still imports the staged package. Keep retained trees,
// including unknown or interrupted stages, rather than breaking such a process.
// Cleanup requires a separate offline maintenance procedure.
export function uninstallMacGlobalPreservingReleases(prefix,{uninstall=()=>{}}={}){
 const root=real(macOuterPrefix(prefix));
 if(!root)return {preserved:0};
 return withMacReleaseMutation(root,()=>{
   uninstall();
   if(stat(anchorOf(root))||stat(path.join(root,'bin','remcp')))
     throw Error('ReMCP npm launcher still exists; retained macOS releases were preserved');
   return {preserved:fs.readdirSync(root).filter(name=>RELEASE.test(name)).length};
 });
}
