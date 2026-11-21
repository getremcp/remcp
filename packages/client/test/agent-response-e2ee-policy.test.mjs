import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentResponder, E2EE_REQUEST_REFUSED } from '../src/agent-responder.mjs';
import { assertAgentE2eeAdmission } from '../src/agent-relay-connection.mjs';

// Mirrors agent.mjs: only authenticated E2EE frames count as encrypted transport.
const encryptedMethod = method => ['e2ee/packet', 'e2ee/identity', 'ping'].includes(method);
const messagePolicy = (message, strict) =>
  assertAgentE2eeAdmission({}, strict, encryptedMethod(message?.method));

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

test('strict policy refuses a new plaintext call without ending the encrypted session', async () => {
  const frames = [], inFlight = new Map();
  let terminated = 0, pending = 0, invoked = 0;
  const e2eeEndpoint = {
    identity: () => ({ version: 'remcp-hpke-auth-p256-v1', fingerprint: 'qa-fingerprint' }),
    handle: async () => ({ content: [{ type: 'text', text: 'encrypted-qa-result' }] }),
  };
  const ws = { readyState: 1, bufferedAmount: 0,
    send: raw => frames.push(JSON.parse(raw)),
    terminate: () => { terminated++; },
  };
  const respond = createAgentResponder({
    inFlight, onPendingChange: delta => { pending += delta; }, e2eeEndpoint,
    getRuntimeState: () => ({
      mcp: { callTool: async () => { invoked++; return { content: [] }; } },
      runtimeDown: false, callTimeoutMs: 1000,
    }),
    assertRequestAllowed: message => messagePolicy(message, true),
    assertResponseAllowed: message => messagePolicy(message, true),
  });

  await respond(ws, { id: 'plaintext-call', method: 'tools/call',
    params: { name: 'write', arguments: { text: 'must not execute' } } });
  assert.equal(invoked, 0, 'a refused plaintext request never reaches the runtime');
  assert.deepEqual(frames, [{ type: 'response', id: 'plaintext-call',
    error: { message: E2EE_REQUEST_REFUSED } }]);
  assert.equal(terminated, 0, 'one plaintext request must not interrupt the authenticated socket');
  assert.equal(inFlight.size, 0);
  assert.equal(pending, 0);

  // The same authenticated WebSocket keeps serving encrypted traffic after the refusal.
  await respond(ws, { id: 'encrypted-identity', method: 'e2ee/identity', params: {} });
  assert.deepEqual(frames.at(-1), { type: 'response', id: 'encrypted-identity',
    result: { version: 'remcp-hpke-auth-p256-v1', fingerprint: 'qa-fingerprint' } });
  assert.equal(terminated, 0);
  assert.equal(frames.filter(frame => frame.error).length, 1);
});

test('a request refusal never leaks policy internals', async () => {
  const frames = [];
  const respond = createAgentResponder({
    inFlight: new Map(), onPendingChange: () => {},
    getRuntimeState: () => ({ mcp: { callTool: async () => { throw new Error('must not run'); } },
      runtimeDown: false, callTimeoutMs: 1000 }),
    assertRequestAllowed: () => { throw new Error('private-policy-detail'); },
  });
  await respond({ readyState: 1, bufferedAmount: 0,
    send: raw => frames.push(JSON.parse(raw)) },
  { id: 'qa-refused', method: 'tools/call', params: { name: 'write' } });
  assert.deepEqual(frames, [{ type: 'response', id: 'qa-refused',
    error: { message: E2EE_REQUEST_REFUSED } }]);
});
