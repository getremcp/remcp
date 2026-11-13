// Crash-conservative local application action journal.
// A UUID is durably reserved BEFORE a non-idempotent action. A crash or
// disconnected process leaves an unknown outcome, never an auto-retry.
// This is not a global exactly-once transaction across remote services.
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {constants,openSync,closeSync,mkdirSync,lstatSync,fstatSync,writeFileSync,readFileSync,fsyncSync,renameSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

const NOFOLLOW=constants.O_NOFOLLOW||0;
const JOURNAL_MAX_BYTES=4096;
const DEFAULT_MAX_ENTRIES=10000;

function defaultDirectory(){
  if(process.platform==='win32')return path.join(process.env.LOCALAPPDATA||os.homedir(),'ReMCP','app-execute-journal');
  if(process.platform==='darwin')return path.join(os.homedir(),'Library','Application Support','ReMCP','app-execute-journal');
  return path.join(process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local','share'),'remcp','app-execute-journal');
}

function assertPrivateDirectory(directory){
  mkdirSync(directory,{recursive:true,mode:0o700});
  const info=lstatSync(directory);
  if(!info.isDirectory()||info.isSymbolicLink())throw Error('Unsafe app execution journal directory');
  if(process.platform!=='win32'){
    if(typeof process.getuid==='function'&&info.uid!==process.getuid())throw Error('App execution journal directory has wrong owner');
    if((info.mode&0o077)!==0)throw Error('App execution journal directory is not private');
  }
}
function journalFile(directory,uuid){
  if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(uuid))throw Error('Invalid journal operation id');
  return path.join(directory,uuid+'.json');
}
function openRecord(file){
  let fd;
  try{
    if(process.platform==='win32'&&lstatSync(file).isSymbolicLink())
      throw Error('Unsafe Windows app execution journal record');
    fd=openSync(file,constants.O_RDONLY|NOFOLLOW);
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.size<=0||stat.size>JOURNAL_MAX_BYTES)throw Error('Unsafe app execution journal record');
    if(process.platform!=='win32'&&(stat.mode&0o077)!==0)throw Error('App execution journal record is not private');
    if(process.platform!=='win32'&&typeof process.getuid==='function'&&stat.uid!==process.getuid())
      throw Error('App execution journal record owner mismatch');
    return JSON.parse(readFileSync(fd,'utf8'));
  }finally{if(fd!==undefined)closeSync(fd);}
}
function syncDirectory(directory){
  if(process.platform==='win32')return; // Node cannot portably fsync a Windows directory handle.
  let fd;
  try{fd=openSync(directory,constants.O_RDONLY|NOFOLLOW);fsyncSync(fd);}
  finally{if(fd!==undefined)closeSync(fd);}
}
function safeWriteNew(file,data){
  let fd;
  try{
    fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|NOFOLLOW,0o600);
    writeFileSync(fd,JSON.stringify(data));
    fsyncSync(fd);
  }finally{if(fd!==undefined)closeSync(fd);}
}
function assertRecord(record,uuid,fingerprint){
  if(!record||record.version!==1||record.uuid!==uuid||record.fingerprint!==fingerprint||
    !['pending','complete'].includes(record.status)||
    (record.status==='complete'&&(!record.result||typeof record.result!=='object')))
    throw Error('App execution operation ID reused with different parameters or journal record corrupted; refuse to replay');
}
export function createAppExecuteJournal({directory=defaultDirectory(),maxEntries=DEFAULT_MAX_ENTRIES}={}){
  if(typeof directory!=='string'||!path.isAbsolute(directory)||!Number.isInteger(maxEntries)||maxEntries<1||maxEntries>100000)
    throw Error('Invalid app execution journal configuration');
  return {
    // This is a synchronous critical section, safe across processes on the
    // same local filesystem through exclusive creation (no network FS claim).
    begin(uuid,fingerprint){
      const key=uuid.toLowerCase();
      assertPrivateDirectory(directory);
      const file=journalFile(directory,key);
      const existing=()=>{
        const record=openRecord(file);
        assertRecord(record,key,fingerprint);
        if(record.status==='pending')return {replayed:true,result:{
          status:'outcome_unknown',executed:null,verified:false,
          reason:'operation_reserved_before_crash_or_still_running_reinspect_before_retry'}};
        return {replayed:true,result:record.result};
      };
      try{return existing();}
      catch(error){if(error?.code!=='ENOENT')throw error;}
      const count=readdirSync(directory,{withFileTypes:true})
        .filter(entry=>entry.name.endsWith('.json')).length;
      if(count>=maxEntries)throw Error('App execution journal is full; manual review required before adding mutations');
      try{
        safeWriteNew(file,{version:1,uuid:key,fingerprint,status:'pending'});
        syncDirectory(directory);
        return {reserved:true};
      }catch(error){
        if(error?.code==='EEXIST')return existing();
        // An I/O error may happen *after* exclusive creation. Leave the
        // record in place, fail closed and require manual inspection.
        throw error;
      }
    },
    complete(uuid,fingerprint,result){
      const key=uuid.toLowerCase();
      assertPrivateDirectory(directory);
      const file=journalFile(directory,key);
      const original=openRecord(file);
      assertRecord(original,key,fingerprint);
      if(original.status!=='pending')throw Error('App execution journal entry already finalized');
      const next={version:1,uuid:key,fingerprint,status:'complete',result};
      if(Buffer.byteLength(JSON.stringify(next))>JOURNAL_MAX_BYTES)
        throw Error('App execution journal result exceeds safe bound');
      const temporary=path.join(directory,'.'+randomUUID()+'.tmp');
      safeWriteNew(temporary,next);
      // On a failed rename the pending record remains, so retries fail closed.
      renameSync(temporary,file);
      syncDirectory(directory);
    },
  };
}
