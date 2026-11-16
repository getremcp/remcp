import test from 'node:test';
import assert from 'node:assert/strict';
import {e2eePairingBinding,initializeDeviceE2ee,loadDeviceE2eeProfile,manageE2eePeer} from '../src/cli/e2ee-identity.mjs';
import {createE2eeIdentity} from '../src/agent-e2ee-crypto.mjs';
import {createE2eeVault} from '../src/cli/e2ee-vault.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const config={deviceId:'device-binding-1234',deviceToken:'synthetic-local-pairing-token',serverUrl:'https://remcp.site'};
test('encryption trust binds server, device and local pairing credential',()=>{
  const pin=e2eePairingBinding(config);assert.match(pin,/^[0-9a-f]{64}$/);
  for(const change of [{deviceToken:'replacement-owner-token'},{deviceId:'another-device'},
    {serverUrl:'https://different.example'}])
    assert.notEqual(e2eePairingBinding({...config,...change}),pin);
  assert.equal(e2eePairingBinding({...config,serverUrl:'https://remcp.site/'}),pin);
  assert.throws(()=>e2eePairingBinding({deviceId:config.deviceId}),/complete local device pairing/);
});
test('OS vault rejects cross-pairing key reuse and explicit rotation revokes old peers',{
  skip:process.env.REMCP_E2EE_NATIVE_VAULT_QA!=='1'?'Requires unlocked OS vault':false,
},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'remcp-pairing-binding-'));
  const vault=createE2eeVault({directory});
  try{
    const original=await initializeDeviceE2ee(config,{directory}),client=await createE2eeIdentity();
    await manageE2eePeer(config,'trust',{'public-key':client.publicKey,fingerprint:client.fingerprint,
      mode:'control'},{directory});
    const loaded=await loadDeviceE2eeProfile({...config,e2eeIdentity:true},{directory});
    assert.equal((await loaded.getPeer(client.fingerprint)).mode,'control');
    const changed={...config,deviceToken:'replacement-owner-token'};
    await assert.rejects(loadDeviceE2eeProfile({...changed,e2eeIdentity:true},{directory}),/identity missing/);
    await assert.rejects(initializeDeviceE2ee(changed,{directory}),/another pairing/);
    const rotated=await initializeDeviceE2ee(changed,{directory,rotate:true});
    assert.notEqual(rotated.fingerprint,original.fingerprint);
    const next=await loadDeviceE2eeProfile({...changed,e2eeIdentity:true},{directory});
    assert.equal(await next.getPeer(client.fingerprint),null);
    assert.equal(await loaded.getPeer(client.fingerprint),null,'old running identity cannot keep using rotated peers');
  }finally{await vault.remove();await fs.rm(directory,{recursive:true,force:true});}
});
