// security(1)'s hidden-input prompt truncates at 128 bytes. Store only a
// random 32-byte wrapping key there; authenticated ciphertext stays on disk.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto';
export function createMacE2eeStore({run,service,account,directory,profile,unavailable}){
  const file=path.join(directory,'e2ee-'+profile+'.keychain');
  async function readCiphertext(){
    try{
      const stat=await fs.lstat(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid()||
          (stat.mode&0o077)!==0||stat.size>128*1024)throw unavailable();
      return JSON.parse(await fs.readFile(file,'utf8'));
    }catch(error){if(error.code==='ENOENT')return null;throw error;}
  }
  async function key(create=false){
    let result=await run('/usr/bin/security',['find-generic-password','-a',account,'-s',service,'-w']);
    if(result.code===44&&create){
      if(await readCiphertext())throw unavailable();
      const secret=randomBytes(32).toString('base64url');
      const stored=await run('/usr/bin/security',['add-generic-password','-a',account,'-s',service,'-w'],
        secret+'\n'+secret+'\n');
      // Another initializer may have won. Read its key; never overwrite it.
      if(stored.code!==0&&stored.code!==45)throw unavailable();
      result=await run('/usr/bin/security',['find-generic-password','-a',account,'-s',service,'-w']);
    }
    const encoded=result.output.trim();
    if(result.code!==0||!/^[A-Za-z0-9_-]{43}$/.test(encoded))throw unavailable();
    return Buffer.from(encoded,'base64url');
  }
  async function read(){
    const saved=await readCiphertext();if(!saved)return null;
    try{
      if(Object.keys(saved).sort().join(',')!=='ciphertext,iv,tag,version'||saved.version!==1)throw unavailable();
      const decipher=createDecipheriv('aes-256-gcm',await key(),Buffer.from(saved.iv,'base64url'));
      decipher.setAAD(Buffer.from(account));decipher.setAuthTag(Buffer.from(saved.tag,'base64url'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.ciphertext,'base64url')),
        decipher.final()]).toString('utf8'));
    }catch{throw unavailable();}
  }
  async function write(value){
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    const stat=await fs.lstat(directory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||
        (stat.mode&0o077)!==0)throw unavailable();
    const wrappingKey=await key(true),iv=randomBytes(12);
    const cipher=createCipheriv('aes-256-gcm',wrappingKey,iv);cipher.setAAD(Buffer.from(account));
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
    const saved={version:1,iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),
      ciphertext:ciphertext.toString('base64url')};
    const temporary=file+'.'+randomUUID()+'.tmp';
    try{
      await fs.writeFile(temporary,JSON.stringify(saved),{mode:0o600,flag:'wx'});
      await fs.rename(temporary,file);
    }finally{await fs.rm(temporary,{force:true});}
    if(JSON.stringify(await read())!==JSON.stringify(value))throw unavailable();
  }
  async function remove(){
    const result=await run('/usr/bin/security',['delete-generic-password','-a',account,'-s',service]);
    if(result.code!==0&&result.code!==44)throw unavailable();
    await fs.rm(file,{force:true});
  }
  return {read,write,remove};
}
