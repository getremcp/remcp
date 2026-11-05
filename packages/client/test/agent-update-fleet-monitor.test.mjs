import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentUpdateMonitor} from '../src/agent-update-monitor.mjs';
import {VERSION} from '../src/version.mjs';

test('future fleet slot defers updater startup but still reports availability', async t => {
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({
    cli:'@remcp/remcp@999.0.0',
    runtime:'@remcp/runtime@999.0.0',
    minimum:'0.1.0',
    rollout:{startAtMs:Date.now()+86400000,windowMs:86400000},
  }),{status:200});
  t.after(()=>{globalThis.fetch=original;});
  let cliProbes=0;
  const events=[];
  const monitor=createAgentUpdateMonitor({
    options:{deviceId:'fixture-backend',autoUpdate:true,runtime:{packageName:'@remcp/runtime'}},
    serverUrl:'https://relay.example.invalid',
    resolveCli:()=>{cliProbes++; return null;},
    queueEvent:event=>events.push(event),
    getRuntimeState:()=>({runtimeVersion:VERSION,runtimeDown:false}),
  });
  await monitor.checkForUpdate({scheduled:true});
  assert.equal(cliProbes,0,'no npm install or CLI probe before the device slot');
  assert.equal(events.filter(e=>e.event==='agent_update_available').length,1);
});

test('raised minimum version bypasses normal fleet delay without starting unauthorized install', async t=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({
    cli:'@remcp/remcp@999.0.0',
    runtime:'@remcp/runtime@999.0.0',
    minimum:'999.0.0',
    rollout:{startAtMs:Date.now()+86400000,windowMs:86400000},
  }),{status:200});
  t.after(()=>{globalThis.fetch=original;});
  let probes=0;
  const monitor=createAgentUpdateMonitor({
    options:{deviceId:'fixture-critical',autoUpdate:true,runtime:{packageName:'@remcp/runtime'}},
    serverUrl:'https://relay.example.invalid',
    resolveCli:()=>{probes++;return null;},
    queueEvent:()=>{},
    getRuntimeState:()=>({runtimeVersion:VERSION,runtimeDown:false}),
  });
  await monitor.checkForUpdate({scheduled:true});
  assert.equal(probes,1,'urgent path proceeds to normal guarded CLI validation');
});

test('unavailable runtime repair bypasses normal fleet delay', async t=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({
    cli:'@remcp/remcp@'+VERSION,
    runtime:'@remcp/runtime@'+VERSION,
    minimum:'0.1.0',
    rollout:{startAtMs:Date.now()+86400000,windowMs:86400000},
  }),{status:200});
  t.after(()=>{globalThis.fetch=original;});
  let probes=0;
  const monitor=createAgentUpdateMonitor({
    options:{deviceId:'fixture-repair',autoUpdate:true,runtime:{packageName:'@remcp/runtime'}},
    serverUrl:'https://relay.example.invalid',
    resolveCli:()=>{probes++;return null;},
    queueEvent:()=>{},
    getRuntimeState:()=>({runtimeVersion:'unknown',runtimeDown:true}),
  });
  await monitor.checkForUpdate({scheduled:true});
  assert.equal(probes,1);
});
