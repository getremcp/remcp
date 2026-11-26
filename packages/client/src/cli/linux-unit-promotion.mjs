// The caller holds the verified parent directory and (for replacement) the
// original unit descriptor. Staging never writes into the original unit.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function sameUnitIdentity(a,b){
  return Boolean(a&&b&&a.isFile()&&b.isFile()&&a.nlink===1n&&b.nlink===1n&&
    ['dev','ino','size','mtimeNs','ctimeNs','uid','gid','mode'].every(key=>a[key]===b[key]));
}
export function promoteLinuxUnit(source, data, original=null, originalFd=null){
  const parent=path.dirname(source),directory=fs.statSync(parent);
  const uid=process.getuid?.();
  if(!directory.isDirectory()||(directory.mode&0o022)!==0||
      (uid!==undefined&&directory.uid!==uid&&directory.uid!==0))
    throw new Error('Unsafe managed systemd unit parent');
  const mode=original?Number(original.mode&0o777n):0o644;
  if((mode&0o022)!==0||data.length>65536)throw new Error('Unsafe managed systemd unit mode or size');
  const temporary=path.join(parent,'.remcp-unit-'+randomUUID()+'.tmp');
  let fd;
  try{
    fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|
      (fs.constants.O_NOFOLLOW||0),0o600);
    fs.writeFileSync(fd,data);
    if(original&&fs.fstatSync(fd,{bigint:true}).gid!==original.gid)
      fs.fchownSync(fd,Number(original.uid),Number(original.gid));
    fs.fchmodSync(fd,mode);
    fs.fsyncSync(fd);
    const staged=fs.fstatSync(fd,{bigint:true});
    if(!sameUnitIdentity(staged,fs.lstatSync(temporary,{bigint:true})))
      throw new Error('Staged systemd unit changed');
    if(original){
      if(!sameUnitIdentity(original,fs.fstatSync(originalFd,{bigint:true}))||
          !sameUnitIdentity(original,fs.lstatSync(source,{bigint:true})))
        throw new Error('Managed systemd unit changed during replacement');
      fs.renameSync(temporary,source);
    }else{
      // Exclusive publication: a competing creator must never be overwritten.
      fs.linkSync(temporary,source);
    }
  }finally{
    if(fd!==undefined){
      fs.closeSync(fd);
      try{fs.unlinkSync(temporary);}catch(error){if(error?.code!=='ENOENT')throw error;}
    }
  }
}
