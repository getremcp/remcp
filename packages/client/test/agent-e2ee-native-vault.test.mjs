import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createE2eeVault} from '../src/cli/e2ee-vault.mjs';
import {createE2eeIdentity,exportE2eeIdentity,importE2eeIdentity} from '../src/agent-e2ee-crypto.mjs';

test('native OS vault persists a real HPKE identity and no plaintext key file',{
  skip:process.env.REMCP_E2EE_NATIVE_VAULT_QA!=='1'?'Requires an unlocked owner OS vault':false,
},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'remcp-e2ee-vault-qa-'));
  const vault=createE2eeVault({directory,profile:'client'});
  try{
    assert.equal(await vault.read(),null);
    const identity=await createE2eeIdentity(),record={identity:await exportE2eeIdentity(identity),peers:[]};
    await vault.write(record);
    const saved=await vault.read();
    assert.equal((await importE2eeIdentity(saved.identity)).fingerprint,identity.fingerprint);
    const files=await fs.readdir(directory);
    assert.deepEqual(files,process.platform==='win32'?['e2ee-client.dpapi']:process.platform==='darwin'?['e2ee-client.keychain']:[]);
    for(const file of files){
      const content=await fs.readFile(path.join(directory,file),'utf8');
      assert.ok(!content.includes(record.identity.privateKey));
      assert.ok(!content.includes(record.identity.publicKey));
    }
    record.peers.push({fingerprint:'synthetic-test-peer',mode:'read'});
    await vault.write(record);
    assert.deepEqual(await vault.read(),record);
    if(process.platform==='linux'){
      // The MCP SDK intentionally omits DBUS_SESSION_BUS_ADDRESS and
      // XDG_RUNTIME_DIR from stdio child environments by default.
      const vaultUrl=new URL('../src/cli/e2ee-vault.mjs',import.meta.url).href;
      const childScript=`import {createE2eeVault} from ${JSON.stringify(vaultUrl)};
        const record=await createE2eeVault({directory:process.argv[1],profile:'client'}).read();
        if(!record?.identity||!Array.isArray(record.peers))throw new Error('native vault unavailable');
        process.stdout.write('vault-session-read-ok');`;
      const childEnv={HOME:os.homedir(),PATH:process.env.PATH,
        USER:process.env.USER,LOGNAME:process.env.LOGNAME};
      const sessionBus=process.env.DBUS_SESSION_BUS_ADDRESS;
      const standardBus='unix:path=/run/user/'+process.getuid()+'/bus';
      // The default owner bus can be recovered from a stripped stdio env.
      // dbus-run-session instead creates a private /tmp bus; removing that
      // address would look up the *real login* vault rather than this QA vault.
      // Preserve only the isolated address and let the vault verify its owner.
      if(sessionBus&&sessionBus!==standardBus&&
          !sessionBus.startsWith(standardBus+',guid=')){
        childEnv.DBUS_SESSION_BUS_ADDRESS=sessionBus;
      }
      const child=spawnSync(process.execPath,['--input-type=module','--eval',childScript,directory],{
        env:childEnv,encoding:'utf8',timeout:20000,
      });
      assert.equal(child.status,0,child.stderr.slice(0,400));
      assert.equal(child.stdout.trim(),'vault-session-read-ok');
    }
    await vault.remove();assert.equal(await vault.read(),null);
  }finally{await vault.remove();await fs.rm(directory,{recursive:true,force:true});}
});
