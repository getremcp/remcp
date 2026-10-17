import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolError } from '../src/util.mjs';
import { classifyRuntimeToolError } from '../src/error-classes.mjs';

test('browser CDP outages are distinguishable from unrelated runtime errors', () => {
  assert.equal(classifyRuntimeToolError(
    new Error('Browser CDP endpoint is unavailable at http://127.0.0.1:9222'), 'browser_tabs',
  ), 'browser_unavailable');
  assert.equal(classifyRuntimeToolError(
    new Error('CDP websocket connection timed out'), 'browser_action',
  ), 'browser_unavailable');
  assert.equal(classifyRuntimeToolError(
    new Error('Browser CDP endpoint is unavailable'), 'read_file',
  ), 'runtime_error');
  assert.equal(classifyRuntimeToolError(Object.assign(new Error('unavailable'), {code:'ECONNREFUSED'}), 'browser_wait'), 'browser_unavailable');
});

test('safe categories distinguish permission, policy, missing targets and timeout', () => {
  const cases = [
    ['Permission denied to use Accessibility', 'ui_snapshot', 'permission'],
    ['Path is outside the directories this device allows: /secret', 'read_file', 'blocked'],
    ['expression contains a blocked private browser destination', 'browser_evaluate', 'blocked'],
    ['Element not found', 'browser_action', 'not_found'],
    ['Wayland EIS helper timed out after 5000 ms', 'pointer', 'timeout'],
    ['Browser workflow action requires a CSS selector at step 2', 'browser_action', 'invalid_input'],
    ['Cancelled by the client; stopped before the next item.', 'read_file', 'cancelled'],
  ];
  for (const [message, tool, expected] of cases) {
    assert.equal(classifyRuntimeToolError(new ToolError(message), tool), expected);
  }
});

test('safe codes and unknown messages cannot leak secret data through telemetry', () => {
  for (const code of ['CUSTOM_SECRET_abc', 'https://attacker.test/password', 'super-long'.repeat(50)]) {
    const error = Object.assign(new Error('/home/ada/.ssh/id_rsa ' + code), {code});
    assert.equal(classifyRuntimeToolError(error, 'read_file'), 'runtime_error');
  }
  assert.equal(classifyRuntimeToolError(new ToolError('an arbitrary secret token'), 'terminal'), 'tool_error');
  assert.equal(classifyRuntimeToolError(Object.assign(new Error('access denied'), {code:'EACCES'}), 'read_file'), 'permission');
  assert.equal(classifyRuntimeToolError(Object.assign(new Error('path'), {code:'ENOENT'}), 'read_file'), 'not_found');
  assert.equal(classifyRuntimeToolError(Object.assign(new Error('deadline'), {code:'ETIMEDOUT'}), 'read_file'), 'timeout');
});

test('malformed errors still return a stable category', () => {
  assert.equal(classifyRuntimeToolError(null), 'runtime_error');
  assert.equal(classifyRuntimeToolError(undefined), 'runtime_error');
  assert.equal(classifyRuntimeToolError({message:null,code:'irrelevant'}), 'runtime_error');
});
