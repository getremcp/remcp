import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { syncKnownInstallations, serviceNpmPrefixFromCliPath, serviceInstallationInfo } from '../src/cli/service-inventory.mjs';

test('canonical service npm prefix comes from its package path, not the Node binary', () => {
  assert.equal(
    serviceNpmPrefixFromCliPath('/home/alice/.local/share/remcp/managed-agent/lib/node_modules/@remcp/remcp/bin/remcp.mjs', 'linux'),
    '/home/alice/.local/share/remcp/managed-agent',
  );
  assert.equal(
    serviceNpmPrefixFromCliPath('C:\\Users\\alice\\AppData\\Roaming\\npm\\remcp.cmd', 'win32'),
    'C:\\Users\\alice\\AppData\\Roaming\\npm',
  );
  for (const unsafe of ['/tmp/bin/foreign', '/tmp/lib/node_modules/@remcp/runtime/bin/remcp.mjs', 'relative/lib/node_modules/@remcp/remcp/bin/remcp.mjs']) {
    assert.throws(() => serviceNpmPrefixFromCliPath(unsafe, 'linux'), /canonical|prefix|service/i);
  }
});

for(const platform of ['linux','darwin'])test('same Node executable with a different managed prefix updates the service, not the CLI prefix ('+platform+')', {skip:process.platform === 'win32' && 'POSIX fixture; Windows package/shim behavior has separate native tests'}, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remcp-managed-prefix-')));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const prefix = path.join(root, 'managed-agent');
  const cli = path.join(prefix, 'lib/node_modules/@remcp/remcp/bin/remcp.mjs');
  const clientManifest = path.join(prefix, 'lib/node_modules/@remcp/remcp/package.json');
  const runtimeManifest = path.join(prefix, 'lib/node_modules/@remcp/runtime/package.json');
  fs.mkdirSync(path.dirname(cli), {recursive:true});
  fs.mkdirSync(path.dirname(runtimeManifest), {recursive:true});
  fs.writeFileSync(cli, '// owned test launcher\\n');
  fs.writeFileSync(clientManifest, JSON.stringify({name:'@remcp/remcp',version:'0.2.239'}));
  fs.writeFileSync(runtimeManifest, JSON.stringify({name:'@remcp/runtime',version:'0.2.239'}));
  fs.mkdirSync(path.join(prefix,'bin'),{recursive:true});
  fs.symlinkSync('../lib/node_modules/@remcp/remcp/bin/remcp.mjs',path.join(prefix,'bin/remcp'));
  fs.mkdirSync(path.join(prefix,'lib/node_modules/@remcp/runtime/src'),{recursive:true});
  fs.writeFileSync(path.join(prefix,'lib/node_modules/@remcp/runtime/src/index.mjs'),'// previous runtime');
  const log = path.join(root, 'npm-args.json');
  const fakeNpm = path.join(root, 'npm-fixture.cjs');
  fs.writeFileSync(fakeNpm, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
fs.writeFileSync(process.env.REMCP_PREFIX_TEST_LOG,JSON.stringify(args));
const p=args[args.lastIndexOf('--prefix')+1];
const expected=fs.realpathSync(process.env.REMCP_PREFIX_TEST_EXPECTED);
const isMac=process.env.REMCP_TEST_PLATFORM==='darwin';
if(args.indexOf('--prefix')<0||(isMac?
  path.dirname(fs.realpathSync(p))!==expected||!path.basename(p).startsWith('.remcp-release-'):
  fs.realpathSync(p)!==expected))process.exit(23);
for(const [name,version] of [['remcp','0.2.241'],['runtime','0.2.241']]){
  const manifest=path.join(p,'lib/node_modules/@remcp',name,'package.json');
  fs.mkdirSync(path.dirname(manifest),{recursive:true});
  fs.writeFileSync(manifest,JSON.stringify({name:'@remcp/'+name,version}));
}
const entry=path.join(p,'lib/node_modules/@remcp/remcp/bin/remcp.mjs');
fs.mkdirSync(path.dirname(entry),{recursive:true});
fs.writeFileSync(entry,'// simulated npm-owned CLI');
const runtime=path.join(p,'lib/node_modules/@remcp/runtime/src/index.mjs');
fs.mkdirSync(path.dirname(runtime),{recursive:true});
fs.writeFileSync(runtime,'// simulated runtime');
`, {mode:0o755});
  const saved = {NODE_ENV:process.env.NODE_ENV,REMCP_TEST_PLATFORM:process.env.REMCP_TEST_PLATFORM,npm:process.env.REMCP_NPM,log:process.env.REMCP_PREFIX_TEST_LOG,prefix:process.env.REMCP_PREFIX_TEST_EXPECTED};
  t.after(() => {
    for (const [key,value] of Object.entries({NODE_ENV:saved.NODE_ENV,REMCP_TEST_PLATFORM:saved.REMCP_TEST_PLATFORM,REMCP_NPM:saved.npm,REMCP_PREFIX_TEST_LOG:saved.log,REMCP_PREFIX_TEST_EXPECTED:saved.prefix})) {
      if (value === undefined) delete process.env[key]; else process.env[key]=value;
    }
  });
  process.env.NODE_ENV='test';
  process.env.REMCP_TEST_PLATFORM=platform;
  process.env.REMCP_NPM=fakeNpm;
  process.env.REMCP_PREFIX_TEST_LOG=log;
  process.env.REMCP_PREFIX_TEST_EXPECTED=prefix;
  const cfg={
    serviceInstalled:true,
    serviceCliPath:cli,
    serviceNodePath:process.execPath, // both npm prefixes share the same node executable
    runtime:{packageName:'@remcp/runtime',packageSpec:'@remcp/runtime@0.2.239'},
  };
  const specs=['@remcp/remcp@0.2.241','@remcp/runtime@0.2.241'];
  const first=syncKnownInstallations(cfg,...specs);
  assert.equal(first.length,1,'stale managed prefix needs an explicit installation');
  assert.equal(first[0].ok,true);
  const installed=serviceInstallationInfo(cfg);
  assert.equal(installed.cliVersion,'0.2.241');
  assert.equal(installed.runtimeVersion,'0.2.241');
  const originalVersion=platform==='darwin'?'0.2.239':'0.2.241';
  assert.equal(JSON.parse(fs.readFileSync(clientManifest,'utf8')).version,originalVersion);
  assert.equal(JSON.parse(fs.readFileSync(runtimeManifest,'utf8')).version,originalVersion);
  const args=JSON.parse(fs.readFileSync(log,'utf8'));
  assert.ok(args.includes('--prefix'));
  assert.equal(fs.realpathSync(args[args.indexOf('--prefix')+1]), fs.realpathSync(prefix));
  assert.ok(args.includes('--ignore-scripts'));
  assert.deepEqual(syncKnownInstallations(cfg,...specs),[],'up-to-date managed prefix is not reinstalled');
});
