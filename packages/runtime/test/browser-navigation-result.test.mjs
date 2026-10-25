import test from 'node:test';
import assert from 'node:assert/strict';
import { requireSuccessfulBrowserNavigation } from '../src/extended/browser-navigation-result.mjs';
import { classifyRuntimeToolError } from '../src/error-classes.mjs';

test('successful CDP navigation has no failure', () => {
  assert.doesNotThrow(() => requireSuccessfulBrowserNavigation({frameId:'frame'}));
  assert.doesNotThrow(() => requireSuccessfulBrowserNavigation({frameId:'frame',errorText:''}));
});

test('Chrome errorText is a failure without leaking URL or response details', () => {
  const result = {frameId:'frame',errorText:'net::ERR_ABORTED https://example.test/private?q=secret'};
  assert.throws(() => requireSuccessfulBrowserNavigation(result), error => {
    assert.equal(error.message, 'Browser navigation failed: Chrome reported an unsuccessful navigation');
    assert.equal(classifyRuntimeToolError(error, 'browser_navigate'), 'browser_navigation_failed');
    assert.doesNotMatch(error.message, /private|secret|example/);
    return true;
  });
});
