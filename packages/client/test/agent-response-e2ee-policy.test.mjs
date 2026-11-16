import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentResponder } from '../src/agent-responder.mjs';
import { assertAgentE2eeAdmission } from '../src/agent-relay-connection.mjs';

for (const outcome of ['result', 'error']) {
  test('tightened E2EE policy suppresses an in-flight plaintext ' + outcome, async () => {
    let strict = false, finish, terminated = 0, pending = 0;
    const frames = [], inFlight = new Map();
    const call = new Promise((resolve, reject) => {
      finish = () => outcome === 'result'
        ? resolve({ content: [{ type: 'text', text: 'private-qa-output' }] })
        : reject(new Error('private-qa-error'));
    });
    const ws = { readyState: 1, bufferedAmount: 0,
      send: raw => frames.push(JSON.parse(raw)),
      terminate: () => { terminated++; },
    };
    const respond = createAgentResponder({
      inFlight, onPendingChange: delta => { pending += delta; },
      getRuntimeState: () => ({ mcp: { callTool: () => call },
        runtimeDown: false, callTimeoutMs: 1000 }),
      assertResponseAllowed: () => assertAgentE2eeAdmission({}, strict),
    });
    const response = respond(ws, { id: 'qa-call', method: 'tools/call',
      params: { name: 'get_runtime_info', arguments: {} } });
    assert.equal(inFlight.size, 1);
    strict = true;
    finish();
    await response;
    assert.deepEqual(frames, [], 'neither private result nor error may leave the agent');
    assert.equal(terminated, 1, 'close the TLS-only connection');
    assert.equal(inFlight.size, 0);
    assert.equal(pending, 0);
  });
}

test('a permissive policy still returns normal MCP results', async () => {
  const frames = [], result = { content: [{ type: 'text', text: 'qa-result' }] };
  const respond = createAgentResponder({
    inFlight: new Map(), onPendingChange: () => {},
    getRuntimeState: () => ({ mcp: { callTool: async () => result },
      runtimeDown: false, callTimeoutMs: 1000 }),
    assertResponseAllowed: () => assertAgentE2eeAdmission({}, false),
  });
  await respond({ readyState: 1, bufferedAmount: 0,
    send: raw => frames.push(JSON.parse(raw)) },
  { id: 'qa-ok', method: 'tools/call', params: {} });
  assert.deepEqual(frames, [{ type: 'response', id: 'qa-ok', result }]);
});
