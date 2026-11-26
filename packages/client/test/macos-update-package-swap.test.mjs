import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {activeMacReleasePrefix,stableMacCliPath,macOuterPrefix,uninstallMacGlobalPreservingReleases,stageAndActivateMacRelease,withMacReleaseMutation} from '../src/cli/mac-release-anchor.mjs';

const serviceUrl = pathToFileURL(path.resolve('src/cli/service.mjs')).href;

function executable(file, body) {
  writeFileSync(file, '#!/bin/sh\n' + body + '\n');
  chmodSync(file, 0o755);
}

function packageDir(prefix, name) {
  return path.join(prefix, 'lib', 'node_modules', ...name.split('/'));
}

function seedOldInstall(prefix) {
  const client = packageDir(prefix, '@remcp/remcp');
  const runtime = packageDir(prefix, '@remcp/runtime');
  mkdirSync(path.join(client, 'bin'), { recursive:true });
  mkdirSync(path.join(runtime, 'src'), { recursive:true });
  mkdirSync(path.join(prefix, 'bin'), { recursive:true });
  writeFileSync(path.join(client, 'package.json'), JSON.stringify({ name:'@remcp/remcp', version:'0.2.50' }));
  writeFileSync(path.join(client, 'bin', 'remcp.mjs'), 'import shared from "shared-lib"; console.log(shared);\n');
  writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ name:'@remcp/runtime', version:'0.2.50' }));
  writeFileSync(path.join(runtime, 'src', 'index.mjs'), 'old-runtime\n');
  const shared=packageDir(prefix,'shared-lib');
  mkdirSync(shared,{recursive:true});
  writeFileSync(path.join(shared,'package.json'),JSON.stringify({name:'shared-lib',version:'1.0.0',type:'module',main:'index.mjs'}));
  writeFileSync(path.join(shared,'index.mjs'),'export default "old-shared"\n');
  symlinkSync('../lib/node_modules/@remcp/remcp/bin/remcp.mjs', path.join(prefix, 'bin', 'remcp'));
}

function runUpdateHelper(root, npmBody, { initial = false, reuse=false } = {}) {
  const prefix = path.join(root, 'prefix');
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive:true });
  if (!initial && !reuse) seedOldInstall(prefix);
  executable(path.join(bin, 'npm'), npmBody);
  const env = {
    ...process.env,
    NODE_ENV:'test',
    REMCP_TEST_PLATFORM:'darwin',
    REMCP_TEST_PREFIX:prefix,
    REMCP_NPM:path.join(bin, 'npm'),
    PATH:bin + ':' + process.env.PATH,
  };
  const code = 'import { npmGlobalInstall, npmGlobalUpdate } from ' + JSON.stringify(serviceUrl) + ';\n'
    + (initial ? "npmGlobalInstall('@remcp/remcp@0.2.54', '@remcp/runtime@0.2.54');\n"
      : "npmGlobalUpdate(['@remcp/remcp','@remcp/runtime'], '@remcp/remcp@0.2.54', '@remcp/runtime@0.2.54');\n");
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding:'utf8' });
  return { prefix, result };
}

function stageNpmBody(extra=''){
  return [
    'if [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; exit 0; fi',
    'if [ "$1" = "--prefix" ] && [ "$3" = "install" ]; then',
    '  stage="$2"',
    '  case "$stage" in "$REMCP_TEST_PREFIX"/.remcp-release-*) ;; *) exit 90;; esac',
    '  case " $* " in *" --ignore-scripts "*) ;; *) exit 91;; esac',
    '  case " $* " in *" --prefer-online "*) ;; *) exit 92;; esac',
    '  test -e "$REMCP_TEST_PREFIX/bin/remcp" || exit 93',
    '  test -e "$REMCP_TEST_PREFIX/lib/node_modules/@remcp/runtime/src/index.mjs" || exit 94',
    '  client="$stage/lib/node_modules/@remcp/remcp"',
    '  runtime="$stage/lib/node_modules/@remcp/runtime"',
    '  addon="$runtime/node_modules/macos-temperature-sensor"',
    '  mkdir -p "$client/bin" "$runtime/src" "$addon" "$stage/lib/node_modules/shared-lib"',
    "  echo '{\"name\":\"@remcp/remcp\",\"version\":\"0.2.54\"}' > \"$client/package.json\"",
    "  echo '{\"name\":\"@remcp/runtime\",\"version\":\"0.2.54\",\"optionalDependencies\":{\"macos-temperature-sensor\":\"2.1.1\"}}' > \"$runtime/package.json\"",
    "  echo '{\"name\":\"macos-temperature-sensor\",\"version\":\"2.1.1\",\"scripts\":{\"install\":\"node-gyp rebuild\"}}' > \"$addon/package.json\"",
    "  echo '{\"name\":\"shared-lib\",\"version\":\"2.0.0\",\"type\":\"module\",\"main\":\"index.mjs\"}' > \"$stage/lib/node_modules/shared-lib/package.json\"",
    "  echo 'export default \"new-shared\"' > \"$stage/lib/node_modules/shared-lib/index.mjs\"",
    "  echo 'import shared from \"shared-lib\"; console.log(shared)' > \"$client/bin/remcp.mjs\"",
    '  echo new-runtime > "$runtime/src/index.mjs"',
    extra,
    '  exit 0',
    'fi',
    'if [ "$1" = "--prefix" ] && [ "$3" = "run" ]; then',
    '  case "$2" in "$REMCP_TEST_PREFIX"/.remcp-release-*/lib/node_modules/@remcp/runtime/node_modules/macos-temperature-sensor) ;; *) exit 95;; esac',
    '  mkdir -p "$2/build/Release"',
    '  echo trusted-native-fixture > "$2/build/Release/mac_temp_native.node"',
    '  exit 0',
    'fi',
    'exit 96',
  ].join('\n');
}

test('macOS update leaves old package and hoisted dependencies intact and atomically activates a complete staged pair', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'remcp-mac-update-swap-')));
  try{
    const {prefix,result}=runUpdateHelper(root,stageNpmBody());
    assert.equal(result.status,0,result.stderr||result.stdout);
    const anchor=path.join(packageDir(prefix,'@remcp/remcp'),'bin','remcp.mjs');
    const stage=activeMacReleasePrefix(prefix);
    assert.notEqual(stage,prefix);
    assert.equal(lstatSync(anchor).isSymbolicLink(),true);
    assert.equal(stableMacCliPath(path.join(prefix,'bin','remcp')),anchor);
    assert.equal(stableMacCliPath(path.join(stage,'lib/node_modules/@remcp/remcp/bin/remcp.mjs')),anchor);
    assert.equal(macOuterPrefix(stage),prefix);
    assert.equal(readFileSync(path.join(packageDir(prefix,'@remcp/runtime'),'src/index.mjs'),'utf8').trim(),'old-runtime');
    assert.equal(readFileSync(path.join(packageDir(prefix,'shared-lib'),'index.mjs'),'utf8').trim(),'export default "old-shared"');
    const invoked=spawnSync(process.execPath,[path.join(prefix,'bin','remcp')],{encoding:'utf8'});
    assert.equal(invoked.status,0,invoked.stderr);
    assert.equal(invoked.stdout.trim(),'new-shared');
    assert.equal(readFileSync(path.join(packageDir(stage,'@remcp/runtime'),'src/index.mjs'),'utf8').trim(),'new-runtime');
    assert.match(readFileSync(path.join(packageDir(stage,'@remcp/runtime'),'node_modules/macos-temperature-sensor/build/Release/mac_temp_native.node'),'utf8'),/trusted-native-fixture/);
    const next=runUpdateHelper(root,stageNpmBody("echo 'console.log(\"second-release\")' > \"$client/bin/remcp.mjs\""),{reuse:true});
    assert.equal(next.result.status,0,next.result.stderr||next.result.stdout);
    const second=activeMacReleasePrefix(prefix);
    assert.notEqual(second,stage);
    assert.equal(stableMacCliPath(path.join(stage,'lib/node_modules/@remcp/remcp/bin/remcp.mjs')),anchor);
    assert.equal(spawnSync(process.execPath,[anchor],{encoding:'utf8'}).stdout.trim(),'second-release');
    assert.equal(spawnSync(process.execPath,[path.join(stage,'lib/node_modules/@remcp/remcp/bin/remcp.mjs')],{encoding:'utf8'}).stdout.trim(),'new-shared');
  }finally{rmSync(root,{recursive:true,force:true});}
});

for(const [name,extra,signal] of [
  ['partial install','exit 73',null],
  ['SIGKILL while npm is writing staged dependencies','kill -KILL "$PPID"; exit 74','SIGKILL'],
]){
  test('macOS update preserves the original working release on '+name,()=>{
    const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'remcp-mac-interrupted-')));
    try{
      const {prefix,result}=runUpdateHelper(root,stageNpmBody(extra));
      assert.notEqual(result.status,0);
      if(signal)assert.equal(result.signal,signal);
      else assert.match(result.stderr,/exit code 73/);
      assert.equal(activeMacReleasePrefix(prefix),prefix);
      const bin=path.join(prefix,'bin','remcp');
      const invoked=spawnSync(process.execPath,[bin],{encoding:'utf8'});
      assert.equal(invoked.status,0,invoked.stderr);
      assert.equal(invoked.stdout.trim(),'old-shared');
      assert.equal(readFileSync(path.join(packageDir(prefix,'@remcp/runtime'),'src/index.mjs'),'utf8').trim(),'old-runtime');
      assert.equal(JSON.parse(readFileSync(path.join(packageDir(prefix,'shared-lib'),'package.json'),'utf8')).version,'1.0.0');
      // Retry without needing a backup restore, lock removal, or a functioning
      // updater from a partially moved package.
      const retry=runUpdateHelper(root,stageNpmBody(),{reuse:true});
      assert.equal(retry.result.status,0,retry.result.stderr||retry.result.stdout);
      assert.notEqual(activeMacReleasePrefix(prefix),prefix);
    }finally{rmSync(root,{recursive:true,force:true});}
  });
}

test('macOS refuses a staged release with a mismatched manifest without changing live CLI',()=>{
  const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'remcp-mac-invalid-')));
  try{
    const {prefix,result}=runUpdateHelper(root,stageNpmBody("echo '{\"name\":\"@remcp/remcp\",\"version\":\"0.2.99\"}' > \"$client/package.json\""));
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/identity or version mismatch/);
    assert.equal(activeMacReleasePrefix(prefix),prefix);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('clean macOS global install also builds the reviewed temperature addon', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-mac-native-first-install-'));
  const npmBody = [
    'if [ "$1" = "prefix" ] && [ "$2" = "--global" ]; then echo "$REMCP_TEST_PREFIX"; exit 0; fi',
    'if [ "$1" = "install" ]; then',
    '  case " $* " in *" --ignore-scripts "*) ;; *) exit 91;; esac',
    '  addon="$REMCP_TEST_PREFIX/lib/node_modules/@remcp/runtime/node_modules/macos-temperature-sensor"',
    '  mkdir -p "$addon"',
    "  echo '{\"name\":\"@remcp/runtime\",\"version\":\"0.2.54\",\"optionalDependencies\":{\"macos-temperature-sensor\":\"2.1.1\"}}' > \"$REMCP_TEST_PREFIX/lib/node_modules/@remcp/runtime/package.json\"",
    "  echo '{\"name\":\"macos-temperature-sensor\",\"version\":\"2.1.1\",\"scripts\":{\"install\":\"node-gyp rebuild\"}}' > \"$addon/package.json\"",
    '  exit 0',
    'fi',
    'if [ "$1" = "--prefix" ]; then',
    '  case " $* " in *" run install "*" --ignore-scripts=false "*) ;; *) exit 92;; esac',
    '  mkdir -p "$2/build/Release"',
    '  echo built > "$2/build/Release/mac_temp_native.node"',
    '  exit 0',
    'fi',
    'exit 93',
  ].join('\n');
  const { prefix, result } = runUpdateHelper(root, npmBody, { initial: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const binary = path.join(packageDir(prefix, '@remcp/runtime'),
    'node_modules', 'macos-temperature-sensor', 'build', 'Release', 'mac_temp_native.node');
  assert.equal(readFileSync(binary, 'utf8').trim(), 'built');
});

test('explicit macOS purge preserves retained dependency trees and foreign stages',()=>{
 const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'remcp-mac-purge-')));
 try{
   const {prefix,result}=runUpdateHelper(root,stageNpmBody());
   assert.equal(result.status,0,result.stderr||result.stdout);
   const stage=activeMacReleasePrefix(prefix);
   const next=runUpdateHelper(root,stageNpmBody(),{reuse:true});
   assert.equal(next.result.status,0,next.result.stderr||next.result.stdout);
   const active=activeMacReleasePrefix(prefix);
   const foreign=path.join(prefix,'.remcp-release-11111111-1111-4111-8111-111111111111');
   mkdirSync(foreign);writeFileSync(path.join(foreign,'keep'),'unverified data');
   assert.throws(()=>uninstallMacGlobalPreservingReleases(prefix),/launcher still exists/);
   assert.ok(existsSync(active)&&existsSync(stage));
   rmSync(path.join(prefix,'bin/remcp'));
   rmSync(packageDir(prefix,'@remcp/remcp'),{recursive:true});
   assert.deepEqual(uninstallMacGlobalPreservingReleases(prefix),{preserved:3});
   assert.equal(existsSync(stage),true);
   assert.equal(existsSync(active),true);
   assert.equal(macOuterPrefix(active),prefix);
   assert.equal(readFileSync(path.join(foreign,'keep'),'utf8'),'unverified data');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('real offline npm tarballs retain the working CLI and uninstall the anchored release', {
  skip:process.platform==='win32', timeout:60_000,
},()=>{
  const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'remcp-real-npm-')));
  const prefix=path.join(root,'prefix');
  const npmEnv={...process.env,npm_config_cache:path.join(root,'cache'),npm_config_offline:'true'};
  const npm=(args,cwd=root)=>{
    const result=spawnSync('npm',args,{cwd,env:npmEnv,encoding:'utf8',timeout:20_000});
    assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);
    return result.stdout.trim();
  };
  function fixture(version){
    const target=path.join(root,version);
    const client=path.join(target,'client'),runtime=path.join(target,'runtime');
    mkdirSync(path.join(client,'bin'),{recursive:true});
    mkdirSync(path.join(runtime,'src'),{recursive:true});
    writeFileSync(path.join(client,'package.json'),JSON.stringify({name:'@remcp/remcp',version,type:'module',bin:{remcp:'bin/remcp.mjs'}}));
    writeFileSync(path.join(runtime,'package.json'),JSON.stringify({name:'@remcp/runtime',version,type:'module',exports:'./src/index.mjs'}));
    writeFileSync(path.join(client,'bin/remcp.mjs'),'#!/usr/bin/env node\nimport value from "@remcp/runtime"; console.log(value);\n');
    writeFileSync(path.join(runtime,'src/index.mjs'),'export default '+JSON.stringify(version)+';\n');
    return [client,runtime].map(dir=>path.join(target,npm(['pack','--ignore-scripts','--offline','--pack-destination',target],dir).split('\n').at(-1)));
  }
  const install=(target,files)=>npm(['--prefix',target,'install','--global','--ignore-scripts','--offline','--no-audit','--no-fund',...files]);
  const run=entry=>{
    const result=spawnSync(process.execPath,[entry],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    return result.stdout.trim();
  };
  try{
    install(prefix,fixture('1.0.0'));
    const entry=path.join(prefix,'bin/remcp');
    assert.equal(run(entry),'1.0.0');
    const files=fixture('2.0.0');
    const stage=stageAndActivateMacRelease({prefix,packageNames:['@remcp/remcp','@remcp/runtime'],
      specs:['@remcp/remcp@2.0.0','@remcp/runtime@2.0.0'],install:target=>install(target,files),buildAddon:()=>{}});
    assert.equal(run(entry),'2.0.0');
    assert.equal(activeMacReleasePrefix(prefix),stage);
    assert.equal(JSON.parse(readFileSync(path.join(prefix,'lib/node_modules/@remcp/runtime/package.json'),'utf8')).version,'1.0.0');
    npm(['--prefix',prefix,'uninstall','--global','--ignore-scripts','--offline','--no-audit','--no-fund','@remcp/remcp','@remcp/runtime']);
    assert.equal(existsSync(entry),false);
    assert.deepEqual(uninstallMacGlobalPreservingReleases(prefix),{preserved:1});
    assert.equal(macOuterPrefix(stage),prefix);
    assert.equal(run(path.join(stage,'lib/node_modules/@remcp/remcp/bin/remcp.mjs')),'2.0.0');
    assert.deepEqual(uninstallMacGlobalPreservingReleases(stage),{preserved:1});
  }finally{rmSync(root,{recursive:true,force:true});}
});


test('macOS purge cannot enter while another process owns the promotion lock',()=>{
 const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'remcp-mac-lock-')));
 try{
   const {prefix,result}=runUpdateHelper(root,stageNpmBody());
   assert.equal(result.status,0,result.stderr||result.stdout);
   const stage=activeMacReleasePrefix(prefix);
   let uninstalled=false;
   withMacReleaseMutation(prefix,()=>{
     assert.throws(()=>uninstallMacGlobalPreservingReleases(prefix,{uninstall:()=>{uninstalled=true;}}),/update already in progress/);
     const competitor=runUpdateHelper(root,stageNpmBody(),{reuse:true});
     assert.notEqual(competitor.result.status,0);
     assert.match(competitor.result.stderr,/update already in progress/);
     assert.equal(activeMacReleasePrefix(prefix),stage);
   });
   assert.equal(uninstalled,false);
   assert.equal(existsSync(path.join(prefix,'.remcp-update-lock')),false);
   assert.equal(runUpdateHelper(root,stageNpmBody(),{reuse:true}).result.status,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
