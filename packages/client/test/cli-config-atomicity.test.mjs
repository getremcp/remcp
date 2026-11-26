import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remcp-config-audit-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  return {dir, client:path.join(dir,'config.json'), runtime:path.join(dir,'runtime.json'),
    run(code) {
      return spawnSync(process.execPath, ['--input-type=module','-e',code], {
        encoding:'utf8', env:{...process.env, REMCP_CONFIG_DIR:dir}, timeout:10000,
      });
    }};
}
test('telemetry mutation does not overwrite corrupt configuration on either side', t => {
  const f=fixture(t);
  for (const corrupt of [f.client,f.runtime]) {
    fs.writeFileSync(f.client,'{"deviceId":"fixture","deviceToken":"fixture"}');
    fs.writeFileSync(f.runtime,'{"existing":true}');
    fs.writeFileSync(corrupt,'{"truncated":');
    const before=[fs.readFileSync(f.client),fs.readFileSync(f.runtime)];
    const result=f.run("const {setTelemetry}=await import('./src/cli/config.mjs'); setTelemetry(false);");
    assert.notEqual(result.status,0,result.stderr);
    assert.deepEqual([fs.readFileSync(f.client),fs.readFileSync(f.runtime)],before);
  }
});
test('failed partial config write preserves the previous pairing', t => {
  const f=fixture(t);
  const before='{"deviceId":"fixture","deviceToken":"fixture"}';
  fs.writeFileSync(f.client,before);
  const result=f.run("import fs from 'node:fs'; const {saveConfig}=await import('./src/cli/config.mjs'); const write=fs.writeFileSync; fs.writeFileSync=(file,data,options)=>{write(file,String(data).slice(0,4),options);throw Object.assign(new Error('fixture EIO'),{code:'EIO'});}; saveConfig({deviceId:'replacement'});");
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/fixture EIO/);
  assert.equal(fs.readFileSync(f.client,'utf8'),before);
  assert.deepEqual(fs.readdirSync(f.dir),['config.json']);
});
test('telemetry still creates missing preference files and preserves existing fields', t => {
  const f=fixture(t);
  fs.writeFileSync(f.client,'{"deviceId":"fixture","deviceToken":"fixture"}');
  const result=f.run("const {setTelemetry}=await import('./src/cli/config.mjs'); setTelemetry(false);");
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.client)),{deviceId:'fixture',deviceToken:'fixture',telemetryEnabled:false});
  assert.deepEqual(JSON.parse(fs.readFileSync(f.runtime)),{telemetryEnabled:false});
});

test('macOS profile and plist survive a partial write without replacing a profile symlink', t => {
  const f=fixture(t);
  const profile=path.join(f.dir,'.zshrc');
  const profileTarget=path.join(f.dir,'profile');
  const plist=path.join(f.dir,'Library','LaunchAgents','com.remcp.agent.plist');
  fs.mkdirSync(path.dirname(plist),{recursive:true});
  fs.writeFileSync(profileTarget,'# user profile\n',{mode:0o644});
  // Native Windows runs the config tests; POSIX symlink and launchd fixture
  // are meaningful on Linux and macOS.
  if(process.platform==='win32') return t.skip('POSIX shell profile fixture');
  fs.symlinkSync(profileTarget,profile);
  fs.writeFileSync(plist,'previous plist');
  const script=[
    "import fs from 'node:fs';",
    "const {ensureMacCliCommand,installMacService}=await import('./src/cli/service-macos.mjs');",
    "const write=fs.writeFileSync; fs.writeFileSync=(file,data,options)=>{if(typeof file!=='number')return write(file,data,options);write(file,String(data).slice(0,4),options);throw new Error('fixture EIO');};",
    "for(const call of [()=>ensureMacCliCommand({}, {cliPath:'/opt/remcp/remcp',nodePath:'/opt/node/bin/node'}),()=>installMacService('/opt/remcp/remcp')]){try{call();throw new Error('write unexpectedly succeeded');}catch(error){if(error.message!=='fixture EIO')throw error;}}",
  ].join('\n');
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000,
    env:{...process.env,HOME:f.dir,REMCP_CONFIG_DIR:f.dir,NODE_ENV:'test',REMCP_TEST_PLATFORM:'darwin',REMCP_TEST_SHELL:'/bin/zsh'}});
  assert.equal(result.status,0,result.stderr);
  assert.equal(fs.readFileSync(profileTarget,'utf8'),'# user profile\n');
  assert.equal(fs.readFileSync(plist,'utf8'),'previous plist');
  assert.equal(fs.lstatSync(profile).isSymbolicLink(),true);
  assert.equal(fs.statSync(profileTarget).mode & 0o777,0o644);
});

test('newer schema with an unfamiliar runtime permits local metadata and preferences without execution', t => {
  const f=fixture(t);
  const before={configSchemaVersion:99,deviceId:'fixture-id',deviceToken:'private-fixture-token',
    serverUrl:'https://invalid.example',serviceInstalled:true,autoUpdate:true,
    runtime:{kind:'future-container',opaque:{keep:true}},futureEnvelope:{keep:['all']}};
  fs.writeFileSync(f.client,JSON.stringify(before));
  fs.writeFileSync(f.runtime,JSON.stringify({opaqueRuntimeField:true}));
  const code="const {handleFutureConfigCommand,loadConfig}=await import('./src/cli/config.mjs');";
  const status=f.run(code+"handleFutureConfigCommand('status',null,'fixture');");
  assert.equal(status.status,0,status.stderr);
  assert.equal(JSON.parse(status.stdout).diagnosis.verdict,'unsupported-config-schema');
  assert.doesNotMatch(status.stdout,/private-fixture-token|fixture-id|invalid.example/);
  const doctor=f.run(code+"handleFutureConfigCommand('doctor',null,'fixture');");
  assert.equal(doctor.status,1);
  assert.equal(fs.readFileSync(f.client,'utf8'),JSON.stringify(before));
  const updates=f.run(code+"handleFutureConfigCommand('auto-update','off','fixture'); handleFutureConfigCommand('telemetry','off','fixture');");
  assert.equal(updates.status,0,updates.stderr);
  assert.match(updates.stdout,/Agent was not restarted/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.client)),{...before,autoUpdate:false,telemetryEnabled:false});
  assert.deepEqual(JSON.parse(fs.readFileSync(f.runtime)),{opaqueRuntimeField:true,telemetryEnabled:false});
  const unsafe=f.run(code+"loadConfig();");
  assert.notEqual(unsafe.status,0);
  assert.match(unsafe.stderr,/supported local runtime/);
  const unrestricted=f.run(code+"handleFutureConfigCommand('godmode','on','fixture');");
  assert.notEqual(unrestricted.status,0);
  assert.equal(JSON.parse(fs.readFileSync(f.runtime)).unrestricted,undefined);
});
