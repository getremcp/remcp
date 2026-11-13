// Bounded, read-only Linux XDG GUI launcher inventory. Never execute Exec=.
import os from 'node:os';
import path from 'node:path';
import {access,lstat,readFile,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {jsonResult} from './common.mjs';

const MAX_DESKTOP_FILES=800;
const MAX_FILE_BYTES=64*1024;
const safeText=value=>typeof value==='string'&&value.length>0&&value.length<=180&&
  !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
const list=value=>String(value||'').split(';').filter(Boolean);
const trueValue=value=>value==='true'||value==='1';
function executableHint(exec){
  // Only interpret a plain argv[0] as an identity hint; never evaluate
  // desktop field codes, arguments, shell syntax or wrapper commands.
  const raw=String(exec||'').match(/^([A-Za-z0-9_.+/-]+)(?:\s|$)/)?.[1];
  const name=raw&&path.basename(raw);
  if(!name||!safeText(name)||
    /^(?:env|sh|bash|zsh|flatpak|snap|gio|gtk-launch|python\d*|node|java|wine)$/i.test(name))
    return null;
  return name;
}

export function parseDesktopEntry(content,{desktop=''}={}){
  if(typeof content!=='string'||Buffer.byteLength(content)>MAX_FILE_BYTES)return null;
  let section='',entry={};
  for(const line of content.split(/\r?\n/)){
    const text=line.trim();
    if(!text||text.startsWith('#'))continue;
    if(text.startsWith('[')&&text.endsWith(']')){
      section=text.slice(1,-1);continue;
    }
    if(section!=='Desktop Entry')continue;
    const eq=text.indexOf('=');
    if(eq<=0)continue;
    const key=text.slice(0,eq).trim();
    if(['Type','Name','Exec','TryExec','Hidden','NoDisplay','Terminal',
      'OnlyShowIn','NotShowIn','DBusActivatable','StartupWMClass'].includes(key))
      entry[key]??=text.slice(eq+1).trim();
  }
  if(entry.Type!=='Application'||!safeText(entry.Name)||
    trueValue(entry.Hidden)||trueValue(entry.NoDisplay)||trueValue(entry.Terminal)||
    (!entry.Exec&&!trueValue(entry.DBusActivatable)))return null;
  const current=String(desktop||'').split(':').filter(Boolean);
  const only=list(entry.OnlyShowIn),except=list(entry.NotShowIn);
  if(only.length&&!current.some(x=>only.includes(x)))return null;
  if(except.length&&current.some(x=>except.includes(x)))return null;
  return {name:entry.Name,
    ...(safeText(entry.StartupWMClass)?{startup_wm_class:entry.StartupWMClass}:{}),
    ...(executableHint(entry.Exec)?{process_hint:executableHint(entry.Exec)}:{}),
    ...(safeText(entry.TryExec)?{try_exec:entry.TryExec}:{})};
}

const sourceDirs=({home=os.homedir(),xdgDataHome,xdgDataDirs}={})=>{
  const local=xdgDataHome||path.join(home,'.local','share');
  const shared=xdgDataDirs||'/usr/local/share:/usr/share';
  return [local,...shared.split(':')].filter((x,i,a)=>x&&path.isAbsolute(x)&&
    !x.includes('\0')&&a.indexOf(x)===i).slice(0,12);
};

async function runnable(tryExec,{pathEnv=process.env.PATH||''}={}){
  if(!tryExec)return true;
  if(tryExec.includes('/')&&!path.isAbsolute(tryExec))return false;
  const paths=path.isAbsolute(tryExec)?[tryExec]:
    pathEnv.split(path.delimiter).filter(path.isAbsolute).map(dir=>path.join(dir,tryExec));
  for(const file of paths.slice(0,48)){
    try{await access(file,constants.X_OK);return true}catch{}
  }
  return false;
}

async function walkFiles(directory,{limit=MAX_DESKTOP_FILES,depth=0}={}){
  if(depth>2||limit<=0)return [];
  let names;
  try{names=await readdir(directory,{withFileTypes:true})}catch{return []}
  const found=[];
  for(const item of names.sort((a,b)=>a.name.localeCompare(b.name))){
    if(found.length>=limit)break;
    const file=path.join(directory,item.name);
    if(item.isDirectory()){
      found.push(...await walkFiles(file,{limit:limit-found.length,depth:depth+1}));
    }else if(item.isFile()&&item.name.endsWith('.desktop'))found.push(file);
  }
  return found;
}

export async function linuxGuiInventory(options={}){
  const desktop=options.desktop??process.env.XDG_CURRENT_DESKTOP??'';
  const dirs=sourceDirs({
    home:options.home,xdgDataHome:options.xdgDataHome??process.env.XDG_DATA_HOME,
    xdgDataDirs:options.xdgDataDirs??process.env.XDG_DATA_DIRS,
  });
  const seen=new Set(),apps=[];
  let scanned=0;
  for(const base of dirs){
    const applicationDir=path.join(base,'applications');
    for(const file of await walkFiles(applicationDir,{limit:MAX_DESKTOP_FILES-scanned})){
      if(scanned++>=MAX_DESKTOP_FILES)break;
      const desktopId=path.relative(applicationDir,file).split(path.sep).join('-');
      // Precedence applies even to Hidden=true tombstones, which suppress
      // same-ID system launchers.
      if(seen.has(desktopId))continue;
      seen.add(desktopId);
      let body;
      try{
        const stat=await lstat(file);
        if(!stat.isFile()||stat.size>MAX_FILE_BYTES)continue;
        body=await readFile(file,'utf8');
      }catch{continue}
      const parsed=parseDesktopEntry(body,{desktop});
      if(!parsed||!await runnable(parsed.try_exec,{pathEnv:options.pathEnv}))continue;
      apps.push({name:parsed.name,desktop_id:desktopId,
        ...(parsed.startup_wm_class?{startup_wm_class:parsed.startup_wm_class}:{}),
        ...(parsed.process_hint?{process_hint:parsed.process_hint}:{}),
        source:'xdg_desktop_entry'});
    }
    if(scanned>=MAX_DESKTOP_FILES)break;
  }
  apps.sort((a,b)=>a.name.localeCompare(b.name));
  return jsonResult({backend:'xdg_desktop_entries',data:apps,
    count:apps.length,returned:apps.length,
    inventory_truncated:scanned>=MAX_DESKTOP_FILES,
    inspected_files:scanned});
}
