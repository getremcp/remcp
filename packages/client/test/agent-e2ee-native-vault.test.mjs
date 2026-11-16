import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
    await vault.remove();assert.equal(await vault.read(),null);
  }finally{await vault.remove();await fs.rm(directory,{recursive:true,force:true});}
});
