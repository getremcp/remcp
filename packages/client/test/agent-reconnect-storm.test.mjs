import test from 'node:test';
import assert from 'node:assert/strict';
import { nextDeployReconnect } from '../src/agent-deploy-reconnect.mjs';
import { createAgentUpdateMonitor } from '../src/agent-update-monitor.mjs';
import { VERSION } from '../src/version.mjs';

test('relay handovers stay fast and repeated overload reconnects back off', () => {
  const delays = [];
  let rapidDisconnects = 0;
  for (let i = 0; i < 7; i += 1) {
    const next = nextDeployReconnect({ requestedDelayMs: 200, rapidDisconnects, connectionUptimeMs: 500 });
    delays.push(next.delayMs);
    rapidDisconnects = next.rapidDisconnects;
  }
  assert.deepEqual(delays, [200, 250, 500, 1000, 2000, 4000, 8000]);
  const longHint = nextDeployReconnect({ requestedDelayMs: 60000, rapidDisconnects: 6, connectionUptimeMs: 500 });
  assert.equal(longHint.delayMs, 60000, 'relay capacity delays are never shortened');
  const stable = nextDeployReconnect({ requestedDelayMs: 200, rapidDisconnects: 7, connectionUptimeMs: 15000 });
  assert.equal(stable.delayMs, 200, 'healthy connections reset the burst penalty');
});

test('reconnect storms do not spam the agent version endpoint', async t => {
  const previousFetch = globalThis.fetch;
  let checks = 0;
  globalThis.fetch = async () => {
    checks += 1;
    return new Response(JSON.stringify({ cli:`@remcp/remcp@${VERSION}`, runtime:`@remcp/runtime@${VERSION}` }), {
      status:200, headers:{ 'content-type':'application/json' },
    });
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const monitor = createAgentUpdateMonitor({
    options: { autoUpdate:true, updateCheckMinGapMs:30000, runtime: { packageName:'@remcp/runtime' } },
    serverUrl:'https://relay.example.invalid',
    queueEvent:()=>{},
    getRuntimeState:()=>({ runtimeVersion:VERSION, runtimeDown:false }),
  });
  await Promise.all(Array.from({length:15}, () => monitor.checkForUpdate()));
  assert.equal(checks, 1, 'repeated connects must not launch version requests');
  await monitor.checkForUpdate();
  assert.equal(checks, 1);
  await monitor.checkForUpdate({ scheduled:true });
  assert.equal(checks, 2, 'bounded scheduled convergence polls must bypass reconnect cooldown');
  await monitor.checkForUpdate();
  assert.equal(checks, 2, 'a new reconnect is still throttled after a scheduled poll');
});
