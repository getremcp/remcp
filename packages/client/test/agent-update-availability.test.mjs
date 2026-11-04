import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentUpdateMonitor } from '../src/agent-update-monitor.mjs';

test('available update is informational, not an installed-success claim', async t => {
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
    resolveCli:()=>null, // never spawn a real updater on the developer's machine
    queueEvent:event=>events.push(event),
    getRuntimeState:()=>({runtimeVersion:'0.2.0',runtimeDown:false}),
  });
  await monitor.checkForUpdate({scheduled:true});
  await monitor.checkForUpdate({scheduled:true});
  await monitor.checkForUpdate({scheduled:true});
  assert.equal(requests,3,'scheduled release checks continue to detect changes');
  assert.equal(events.length,1,'same release is announced once within cooldown');
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
