import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { syncKnownInstallations, serviceNpmPrefixFromCliPath } from '../src/cli/service-inventory.mjs';

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

test('same Node executable with a different managed prefix updates the service, not the CLI prefix', {skip:process.platform === 'win32' && 'POSIX fixture; Windows package/shim behavior has separate native tests'}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remcp-managed-prefix-'));
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
  const log = path.join(root, 'npm-args.json');
  const fakeNpm = path.join(root, 'npm-fixture.cjs');
  fs.writeFileSync(fakeNpm, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
fs.writeFileSync(process.env.REMCP_PREFIX_TEST_LOG,JSON.stringify(args));
const p=args[args.indexOf('--prefix')+1];
if(args.indexOf('--prefix')<0||p!==process.env.REMCP_PREFIX_TEST_EXPECTED)process.exit(23);
for(const [name,version] of [['remcp','0.2.241'],['runtime','0.2.241']]){
  fs.writeFileSync(path.join(p,'lib/node_modules/@remcp',name,'package.json'),JSON.stringify({name:'@remcp/'+name,version}));
}
`, {mode:0o755});
  const saved = {npm:process.env.REMCP_NPM,log:process.env.REMCP_PREFIX_TEST_LOG,prefix:process.env.REMCP_PREFIX_TEST_EXPECTED};
  t.after(() => {
    for (const [key,value] of Object.entries({REMCP_NPM:saved.npm,REMCP_PREFIX_TEST_LOG:saved.log,REMCP_PREFIX_TEST_EXPECTED:saved.prefix})) {
      if (value === undefined) delete process.env[key]; else process.env[key]=value;
    }
  });
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
  assert.equal(JSON.parse(fs.readFileSync(clientManifest,'utf8')).version,'0.2.241');
  assert.equal(JSON.parse(fs.readFileSync(runtimeManifest,'utf8')).version,'0.2.241');
  const args=JSON.parse(fs.readFileSync(log,'utf8'));
  assert.ok(args.includes('--prefix'));
  assert.ok(args.includes(prefix));
  assert.ok(args.includes('--ignore-scripts'));
  assert.deepEqual(syncKnownInstallations(cfg,...specs),[],'up-to-date managed prefix is not reinstalled');
});
