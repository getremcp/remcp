import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VERSION } from '../src/version.mjs';
import { createAgentUpdateMonitor } from '../src/agent-update-monitor.mjs';

test('available update is informational, not an installed-success claim', async t => {
  isolatedRecoveryConfig(t);
  const originalFetch = globalThis.fetch;
  let requests=0;
  globalThis.fetch=async () => {
    requests += 1;
    return new Response(JSON.stringify({
      cli:'@remcp/remcp@999.0.0',
      runtime:'@remcp/runtime@999.0.0',
    }),{status:200,headers:{'content-type':'application/json'}});
  };
  t.after(()=>{globalThis.fetch=originalFetch;});
  const events=[];
  const monitor=createAgentUpdateMonitor({
    options:{autoUpdate:true,updateCheckMinGapMs:0,runtime:{packageName:'@remcp/runtime'}},
    serverUrl:'https://relay.example.invalid',
    resolveCli:()=>null,
    resolveInvocation:()=>null, // never spawn a real updater, including Windows fallback
    queueEvent:event=>events.push(event),
    getRuntimeState:()=>({runtimeVersion:'0.2.0',runtimeDown:false}),
  });
  await monitor.checkForUpdate({scheduled:true});
  await monitor.checkForUpdate({scheduled:true});
  await monitor.checkForUpdate({scheduled:true});
  assert.equal(requests,3,'scheduled release checks continue to detect changes');
  assert.equal(events.length,2,'availability and blocked launch each reported once within cooldown');
  assert.equal(events[1].reason,'updater-unavailable');
  assert.equal(events[1].success,false);
  assert.equal(events[0].event,'agent_update_available');
  assert.equal(events[0].success,undefined,'availability is not verified installation');
  assert.ok(Number.isFinite(events[0].at));
  assert.equal(events.some(event=>event.event==='agent_update'&&event.success===true),false);
});

test('a current advertised version never emits availability telemetry', async t=>{
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async ()=>new Response(JSON.stringify({cli:'@remcp/remcp@0.0.1'}),{status:200});
  t.after(()=>{globalThis.fetch=originalFetch;});
  const events=[];
  const monitor=createAgentUpdateMonitor({
    options:{autoUpdate:true,runtime:{packageName:'@remcp/runtime'}},
    serverUrl:'https://relay.example.invalid',
    resolveCli:()=>null,
    queueEvent:event=>events.push(event),
    getRuntimeState:()=>({runtimeVersion:'0.2.0',runtimeDown:false}),
  });
  await monitor.checkForUpdate({scheduled:true});
  assert.deepEqual(events,[]);
});


function isolatedRecoveryConfig(t) {
  const before = process.env.REMCP_CONFIG_DIR;
  const root = mkdtempSync(path.join(tmpdir(),'remcp-update-fixture-'));
  process.env.REMCP_CONFIG_DIR = root;
  t.after(()=>{
    if(before===undefined) delete process.env.REMCP_CONFIG_DIR;
    else process.env.REMCP_CONFIG_DIR=before;
    rmSync(root,{recursive:true,force:true});
  });
  return root;
}
function fixtureMonitor(t, overrides = {}) {
  const configRoot=isolatedRecoveryConfig(t);
  const original = globalThis.fetch;
  const manifest = v => new Response(JSON.stringify({
    cli:'@remcp/remcp@'+v, runtime:'@remcp/runtime@'+v,
  }),{status:200});
  globalThis.fetch = async () => manifest('999.0.0');
  t.after(()=>{globalThis.fetch=original;});
  const events=[];
  const monitor=createAgentUpdateMonitor({
    options:{autoUpdate:true,runtime:{packageName:'@remcp/runtime'}},
    serverUrl:'https://relay.example.invalid',
    resolveCli:()=>null,
    resolveInvocation:()=>({command:'fixture',args:[]}),
    queueEvent:event=>events.push(event),
    getRuntimeState:()=>({runtimeVersion:VERSION,runtimeDown:false}),
    ...overrides,
  });
  return {monitor,events,manifest,configRoot};
}
function fakeUpdater(){
  const child=new EventEmitter();
  child.stdout=new EventEmitter();
  child.stderr=new EventEmitter();
  child.unref=()=>{};
  return child;
}

test('synchronous start failure releases the in-flight gate for a newer release', async t=>{
  let starts=0;
  const {monitor,events,manifest}=fixtureMonitor(t,{
    spawnUpdater:()=>{starts++;throw new Error('private fixture path');},
  });
  await monitor.checkForUpdate({scheduled:true});
  await monitor.checkForUpdate({scheduled:true});
  assert.equal(starts,1,'same release retains retry cooldown');
  globalThis.fetch=async()=>manifest('999.0.1');
  await monitor.checkForUpdate({scheduled:true});
  assert.equal(starts,2);
  assert.equal(events.filter(e=>e.reason==='updater-start-failed').length,2);
  assert.doesNotMatch(JSON.stringify(events),/private fixture path/);
});

test('child start error and exit do not double-report',async t=>{
  const child=fakeUpdater();
  const {monitor,events}=fixtureMonitor(t,{spawnUpdater:()=>child});
  await monitor.checkForUpdate({scheduled:true});
  child.emit('error',new Error('private fixture message'));
  child.emit('exit',1);
  child.emit('close',1);
  assert.deepEqual(events.filter(e=>e.success===false).map(e=>e.reason),['updater-start-failed']);
  assert.doesNotMatch(JSON.stringify(events),/private fixture message/);
});

test('nonzero exit reports failed installation, not successful installation',async t=>{
  const child=fakeUpdater();
  const {monitor,events}=fixtureMonitor(t,{spawnUpdater:()=>child});
  await monitor.checkForUpdate({scheduled:true});
  child.emit('exit',1);
  child.emit('close',1);
  assert.deepEqual(events.filter(e=>e.success===false).map(e=>e.reason),['updater-install-failed']);
  assert.equal(events.some(e=>e.success===true),false);
});

test('successful exit without replacement launcher reports incomplete replacement',async t=>{
  const child=fakeUpdater();
  const {monitor,events}=fixtureMonitor(t,{spawnUpdater:()=>child});
  await monitor.checkForUpdate({scheduled:true});
  child.emit('exit',0);
  assert.equal(events.filter(e=>e.success===false).length,0,'must not settle before output drains');
  child.emit('close',0);
  assert.deepEqual(events.filter(e=>e.success===false).map(e=>e.reason),['replacement-unavailable']);
});

test('zero exit with an old installed client must not restart the live runtime',async t=>{
  const child=fakeUpdater();
  let restarts=0;
  let entry;
  const {monitor,events,configRoot}=fixtureMonitor(t,{
    spawnUpdater:()=>child,resolveCli:()=>entry,restartRuntime:()=>{restarts++;},
  });
  entry=path.join(configRoot,'old-cli.mjs');
  writeFileSync(entry,'// existing old client');
  await monitor.checkForUpdate({scheduled:true});
  child.emit('exit',0);
  child.emit('close',0);
  assert.equal(restarts,0,'an updater exit code is not installed-version evidence');
  assert.deepEqual(events.filter(e=>e.success===false).map(e=>e.reason),['updater-install-failed']);
});

test('verified current client still permits runtime-only recovery',async t=>{
  const child=fakeUpdater();
  let restarts=0;
  let entry;
  const {monitor,events,configRoot,manifest}=fixtureMonitor(t,{
    spawnUpdater:()=>child,resolveCli:()=>entry,restartRuntime:()=>{restarts++;},
    getRuntimeState:()=>({runtimeVersion:'unknown',runtimeDown:true}),
  });
  entry=path.join(configRoot,'current-cli.mjs');
  writeFileSync(entry,'// current client fixture');
  globalThis.fetch=async()=>manifest(VERSION);
  await monitor.checkForUpdate({scheduled:true});
  child.emit('exit',0);
  child.emit('close',0);
  assert.equal(restarts,1,'valid current-client runtime repair must still work');
  assert.deepEqual(events.filter(e=>e.success===false),[]);
});

test('concurrent manifests with different versions cannot start overlapping installers',async t=>{
  const child=fakeUpdater();
  let starts=0;
  const {monitor,manifest}=fixtureMonitor(t,{spawnUpdater:()=>{starts++;return child;}});
  const pending=[];
  globalThis.fetch=()=>new Promise(resolve=>pending.push(resolve));
  const first=monitor.checkForUpdate({scheduled:true});
  const second=monitor.checkForUpdate({scheduled:true});
  assert.equal(pending.length,2);
  pending[0](manifest('999.0.0'));
  await first;
  pending[1](manifest('999.0.1'));
  await second;
  assert.equal(starts,1);
  child.emit('exit',1);
  child.emit('close',1);
});


test('inherited output pipe cannot indefinitely block subsequent release checks',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const child=fakeUpdater();
  const {monitor,events,manifest}=fixtureMonitor(t,{spawnUpdater:()=>child});
  await monitor.checkForUpdate({scheduled:true});
  child.emit('exit',0);
  t.mock.timers.tick(5000);
  assert.deepEqual(events.filter(e=>e.success===false).map(e=>e.reason),['updater-output-incomplete']);
  child.emit('close',0);
  assert.equal(events.filter(e=>e.success===false).length,1,'late close cannot restart or duplicate an outcome');
  globalThis.fetch=async()=>manifest('999.0.1');
  await monitor.checkForUpdate({scheduled:true});
  assert.equal(events.filter(e=>e.event==='agent_update_available').length,2);
  child.emit('error',new Error('fixture cleanup'));
});


test('late Windows blocked marker is read before handoff and holds the exact release',async t=>{
  const platform=Object.getOwnPropertyDescriptor(process,'platform');
  Object.defineProperty(process,'platform',{...platform,value:'win32'});
  t.after(()=>Object.defineProperty(process,'platform',platform));
  const child=fakeUpdater();
  let starts=0;
  const {monitor,events,configRoot}=fixtureMonitor(t,{spawnUpdater:()=>{starts++;return child;}});
  await monitor.checkForUpdate({scheduled:true});
  child.emit('exit',1);
  assert.equal(events.filter(e=>e.success===false).length,0);
  child.stderr.emit('data',Buffer.from('REMCP_WINDOWS_PAYLOAD_'));
  child.stderr.emit('data',Buffer.from('BLOCKED'));
  child.emit('close',1);
  assert.deepEqual(events.filter(e=>e.success===false).map(e=>e.reason),['payload-blocked']);
  const hold=JSON.parse(readFileSync(path.join(configRoot,'windows-recovery-hold.json'),'utf8'));
  assert.equal(hold.target,'@remcp/remcp@999.0.0|@remcp/runtime@999.0.0');
  assert.equal(hold.reason,'payload-validation-failed');
  await monitor.checkForUpdate({scheduled:true});
  assert.equal(starts,1,'held release must not be relaunched');
});


test('Windows blocked payload marker is detected before trimming a large output chunk',async t=>{
  const platform=Object.getOwnPropertyDescriptor(process,'platform');
  Object.defineProperty(process,'platform',{...platform,value:'win32'});
  t.after(()=>Object.defineProperty(process,'platform',platform));
  t.mock.method(console,'error',()=>{});
  const child=fakeUpdater();
  const {monitor,events}=fixtureMonitor(t,{spawnUpdater:()=>child});
  await monitor.checkForUpdate({scheduled:true});
  child.stderr.emit('data',Buffer.from('REMCP_WINDOWS_PAYLOAD_BLOCKED\n'+'x'.repeat(8192)));
  child.emit('exit',1);
  child.emit('close',1);
  assert.deepEqual(events.filter(e=>e.success===false).map(e=>e.reason),['payload-blocked']);
});

test('interleaved stdout cannot hide a split blocked-payload marker on stderr',async t=>{
  const platform=Object.getOwnPropertyDescriptor(process,'platform');
  Object.defineProperty(process,'platform',{...platform,value:'win32'});
  t.after(()=>Object.defineProperty(process,'platform',platform));
  const child=fakeUpdater();
  const {monitor,events}=fixtureMonitor(t,{spawnUpdater:()=>child});
  await monitor.checkForUpdate({scheduled:true});
  child.stderr.emit('data',Buffer.from('REMCP_WINDOWS_PAYLOAD_'));
  child.stdout.emit('data',Buffer.from('unrelated output'));
  child.stderr.emit('data',Buffer.from('BLOCKED'));
  child.emit('exit',1);
  child.emit('close',1);
  assert.deepEqual(events.filter(e=>e.success===false).map(e=>e.reason),['payload-blocked']);
});

test('different pipes cannot synthesize a blocked-payload marker',async t=>{
  const platform=Object.getOwnPropertyDescriptor(process,'platform');
  Object.defineProperty(process,'platform',{...platform,value:'win32'});
  t.after(()=>Object.defineProperty(process,'platform',platform));
  const child=fakeUpdater();
  const {monitor,events}=fixtureMonitor(t,{spawnUpdater:()=>child});
  await monitor.checkForUpdate({scheduled:true});
  child.stdout.emit('data',Buffer.from('REMCP_WINDOWS_PAYLOAD_'));
  child.stderr.emit('data',Buffer.from('BLOCKED'));
  child.emit('exit',1);
  child.emit('close',1);
  assert.deepEqual(events.filter(e=>e.success===false).map(e=>e.reason),['updater-install-failed']);
});
