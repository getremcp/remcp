import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepareAgentE2eeProfile} from '../src/cli/e2ee-automatic.mjs';
import {initializeDeviceE2ee,loadDeviceE2eeProfile} from '../src/cli/e2ee-identity.mjs';
import {createE2eeVault} from '../src/cli/e2ee-vault.mjs';

test('first strict E2EE boot on the owner OS persists its HPKE identity and safely reconnects',{
  skip:process.env.REMCP_E2EE_NATIVE_VAULT_QA!=='1'?
    'Requires an unlocked owner OS vault; never run during generic CI':false,
  timeout:process.platform==='win32'?65000:process.platform==='darwin'?50000:25000,
},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'remcp-e2ee-firstboot-'));
  const vault=createE2eeVault({directory});
  const persisted=[];
  const config={deviceId:randomUUID(),deviceToken:randomUUID(),
    serverUrl:'https://remcp.site',requireE2ee:true,
    persistState:async change=>persisted.push(change)};
  const deps={initialize:cfg=>initializeDeviceE2ee(cfg,{directory}),
    load:cfg=>loadDeviceE2eeProfile(cfg,{directory}),
    // Native QA may not wait indefinitely for somebody to unlock a desktop.
    delay:async()=>{throw new Error('native_qa_owner_vault_locked');},report:()=>{}};
  try{
    assert.equal(await vault.read(),null);
    const first=await prepareAgentE2eeProfile(config,deps);
    assert.match(first.identity.fingerprint,/^[0-9a-f]{64}$/);
    assert.deepEqual(persisted,[{e2eeIdentity:true}]);
    const record=await vault.read();
    assert.equal(record.deviceId,config.deviceId);
    assert.deepEqual(record.peers,[]);
    for(const filename of await fs.readdir(directory)){
      const contents=await fs.readFile(path.join(directory,filename),'utf8');
      assert.ok(!contents.includes(record.identity.privateKey));
      assert.ok(!contents.includes(record.identity.publicKey));
    }
    const restarted=await prepareAgentE2eeProfile({...config,e2eeIdentity:true},{
      ...deps,initialize:()=>assert.fail('reconnect must never rotate its E2EE device identity'),
    });
    assert.equal(restarted.identity.fingerprint,first.identity.fingerprint);
    await assert.rejects(prepareAgentE2eeProfile({...config,deviceToken:randomUUID(),
      e2eeIdentity:true},deps),/identity missing from OS vault/);
    assert.equal((await vault.read()).identity.publicKey,record.identity.publicKey);
  }finally{
    await vault.remove();
    await fs.rm(directory,{recursive:true,force:true});
  }
});
