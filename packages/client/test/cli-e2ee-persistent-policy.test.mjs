import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertAgentE2eeAdmission, createAgentRelayConnection } from '../src/agent-relay-connection.mjs';
import { runAgent } from '../src/agent.mjs';
import {
  effectiveE2eeRequirement, persistedE2eeRequired, setE2eeRequirement,
} from '../src/cli/e2ee-policy.mjs';

const bin = resolve('bin/remcp.mjs');

test('persistent E2EE opt-in rejects TLS-only, while missing pairing fails before vault access', async () => {
  // The persisted requirement remains strict even if the environment says "0".
  assert.throws(() => assertAgentE2eeAdmission({REMCP_REQUIRE_E2EE:'0'}, true),
    /E2EE required but unavailable/);
  assert.throws(() => createAgentRelayConnection({requireE2ee:true}),
    /E2EE required but unavailable/);
  // Invalid pairing is rejected earlier than strict admission: never touch the
  // signed-in owner's real OS vault or attempt to dial this synthetic relay.
  await assert.rejects(runAgent({
    requireE2ee:true,
    serverUrl:'http://127.0.0.1:1',
    allowInsecureTransport:true,
    deviceToken:'synthetic', deviceId:'', telemetryEnabled:false, autoUpdate:false,
  }), /serverUrl, deviceToken and deviceId are required/);
});

test('CLI persists and audits strict policy on Linux, macOS and Windows service configuration', () => {
  for(const platform of ['linux','darwin','win32']) {
    const dir = mkdtempSync(join(tmpdir(), 'remcp-e2ee-policy-'));
    const cfgDir = join(dir, 'config');
    mkdirSync(cfgDir);
    const env = {...process.env, REMCP_CONFIG_DIR:cfgDir,
      HOME:dir, NODE_ENV:'test', REMCP_TEST_PLATFORM:platform};
    delete env.REMCP_REQUIRE_E2EE;
    const cli = (...args) => spawnSync(process.execPath,[bin,'e2ee',...args],
      {env,encoding:'utf8',timeout:6000});
    try {
      const enabled = cli('require');
      assert.equal(enabled.status,0, enabled.stderr);
      assert.match(enabled.stdout, /E2EE required/);
      const persisted = JSON.parse(readFileSync(join(cfgDir,'config.json'),'utf8'));
      assert.equal(persisted.requireE2ee,true);
      assert.equal(JSON.parse(cli('status').stdout).required,true);
      assert.equal(JSON.parse(cli('status').stdout).available,false);
      assert.equal(JSON.parse(cli('status').stdout).identityConfigured,false);
      assert.match(JSON.parse(cli('status').stdout).reason,/accessible owner OS vault/);
      assert.equal(JSON.parse(cli('status').stdout).transport,'tls-only');
      assert.equal(cli('require').status,0,'idempotent require');
      const disabled = cli('off');
      assert.equal(disabled.status,0, disabled.stderr);
      assert.equal(JSON.parse(cli('status').stdout).required,false);
      assert.equal(JSON.parse(readFileSync(join(cfgDir,'config.json'),'utf8')).requireE2ee,false);
      assert.equal(cli('unknown').status===0,false,'invalid command must reject');
      env.REMCP_REQUIRE_E2EE='1';
      assert.equal(JSON.parse(cli('status').stdout).required,true,
        'persistent off may not disable a stricter service environment');
      env.REMCP_REQUIRE_E2EE='garbage';
      assert.notEqual(cli('status').status,0,'malformed service env must fail closed');
    } finally {rmSync(dir,{recursive:true,force:true});}
  }
});

test('policy changes request deferred supervised reload without losing paired config', () => {
  const calls=[], input={deviceToken:'keep-secret',autoUpdate:false};
  const deps={
    persist:cfg=>calls.push({kind:'save',cfg}),
    restart:(cfg,opts)=>{calls.push({kind:'restart',cfg,opts});return 'scheduled';},
  };
  assert.equal(setE2eeRequirement(input,true,deps),'scheduled');
  assert.deepEqual(calls[0].cfg,{deviceToken:'keep-secret',autoUpdate:false,requireE2ee:true});
  assert.deepEqual(calls[1].opts,{deferLinux:true,deferWindows:true});
  assert.equal(setE2eeRequirement(calls[0].cfg,true,deps),'scheduled',
    'retry a supervisor restart if the persisted strict policy is unchanged');
  assert.equal(calls.length,3);
  assert.equal(calls.filter(x=>x.kind==='save').length,1,'avoid redundant writes');
  assert.equal(effectiveE2eeRequirement(calls[0].cfg,{REMCP_REQUIRE_E2EE:'0'}),true);
});

test('corrupted persisted policy cannot silently fall back to TLS-only',()=>{
  for(const malformed of [null,1,0,'true','false',{},[]]){
    assert.throws(()=>persistedE2eeRequired({requireE2ee:malformed}),/Invalid persisted/);
    assert.throws(()=>assertAgentE2eeAdmission({},malformed),/Invalid persisted/);
  }
  assert.equal(effectiveE2eeRequirement({requireE2ee:undefined},{}),false);
  assert.equal(effectiveE2eeRequirement({requireE2ee:false},{REMCP_REQUIRE_E2EE:'1'}),true);
});

test('operator may retry failed supervised reload without writing a weaker policy',()=>{
  let saved=null,attempts=0,extraWrites=0;
  assert.throws(()=>setE2eeRequirement({},true,{
    persist:cfg=>{saved=cfg;},
    restart:()=>{attempts++;throw Error('supervisor unavailable');},
  }),/supervisor unavailable/);
  assert.equal(saved.requireE2ee,true,'fail closed on next start even if reload fails');
  assert.equal(setE2eeRequirement(saved,true,{
    persist:()=>{extraWrites++;},
    restart:()=>{attempts++;return 'scheduled';},
  }),'scheduled');
  assert.equal(attempts,2);
  assert.equal(extraWrites,0);
});
