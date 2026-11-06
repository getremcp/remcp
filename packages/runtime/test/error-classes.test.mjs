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
    new Error('The configured CDP endpoint is unavailable at http://127.0.0.1:9222'), 'browser_tabs',
  ), 'browser_unavailable');
  assert.equal(classifyRuntimeToolError(
    new Error('The configured CDP endpoint is unavailable at http://127.0.0.1:9222'), 'read_file',
  ), 'runtime_error');
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
  assert.equal(classifyRuntimeToolError(Object.assign(new Error('quota'), {code:'EDQUOT'}), 'copy_file'), 'resource_exhausted');
  assert.equal(classifyRuntimeToolError(Object.assign(new Error('disk'), {code:'ENOSPC'}), 'write_file'), 'resource_exhausted');
  assert.equal(classifyRuntimeToolError(Object.assign(new Error('locked'), {code:'EBUSY'}), 'copy_file'), 'busy');
  assert.equal(classifyRuntimeToolError(new ToolError('Path not found: C:\\Missing'), 'list_directory'), 'not_found');
});

test('malformed errors still return a stable category', () => {
  assert.equal(classifyRuntimeToolError(null), 'runtime_error');
  assert.equal(classifyRuntimeToolError(undefined), 'runtime_error');
  assert.equal(classifyRuntimeToolError({message:null,code:'irrelevant'}), 'runtime_error');
});

test('browser CDP failures use bounded actionable categories, not raw exception text', () => {
  const cases = [
    ['BROWSER_TARGET_DISAPPEARED', 'Browser CDP target disappeared during startup', 'browser_target_stale'],
    ['', 'No target with given id: secret-target-id', 'browser_target_stale'],
    ['', 'CDP websocket closed', 'browser_session_lost'],
    ['', 'CDP websocket is not open', 'browser_session_lost'],
    ['', 'Browser child guard failed: error details', 'browser_guard_failed'],
    ['', 'Cannot navigate back: no history entry is available', 'browser_navigation_failed'],
    ['', 'Browser navigation failed: Chrome reported an unsuccessful navigation', 'browser_navigation_failed'],
  ];
  for (const [code, message, expected] of cases) {
    const error = Object.assign(new Error(message), {code});
    assert.equal(classifyRuntimeToolError(error, 'browser_navigate'), expected);
    assert.equal(classifyRuntimeToolError(error, 'read_file'), 'runtime_error');
  }
  assert.equal(classifyRuntimeToolError(new Error('CDP websocket connection timed out'), 'browser_tabs'), 'browser_unavailable');
  assert.equal(classifyRuntimeToolError(new Error('Page.navigate timed out'), 'browser_navigate'), 'timeout');
});

test('known missing terminal sessions and edit targets are not generic failures', () => {
  const missingSession = new ToolError('No ReMCP session with pid 12345678');
  for (const tool of ['read_process_output','wait_for_process_output','force_terminate','interact_with_process']) {
    assert.equal(classifyRuntimeToolError(missingSession, tool),'not_found',tool);
  }
  assert.equal(classifyRuntimeToolError(missingSession, 'read_file'),'tool_error');
  for (const message of [
    'old_string was not found in the file',
    'old_string was not found in the file, even after whitespace normalization',
  ]) {
    assert.equal(classifyRuntimeToolError(new ToolError(message),'edit_block'),'not_found');
  }
  for (const message of [
    'Expected 2 occurrence(s) of old_string but found 1. Add more surrounding context.',
    'old_string matched 2 block(s) after whitespace normalization, expected 1. Add more surrounding context.',
  ]) {
    assert.equal(classifyRuntimeToolError(new ToolError(message),'edit_block'),'invalid_input');
  }
});

test('scope classification to supported tool names and anchored signatures', () => {
  const cases=[
    ['No ReMCP session with pid 12345678 from unrelated response','read_process_output'],
    ['No ReMCP session with pid xyz','read_process_output'],
    ['old_string was not found in the file while parsing payload','edit_block'],
    ['old_string was not found in the file','start_process'],
    ['Expected 2 occurrence(s) of old_string but found 1. Add more surrounding context.','read_file'],
  ];
  for(const [message, tool] of cases){
    assert.equal(classifyRuntimeToolError(new ToolError(message),tool),'tool_error');
  }
});
