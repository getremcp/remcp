import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberBrowserViewport, getBrowserViewport } from '../src/extended/browser-viewport.mjs';

const metrics = { width: 320, height: 568, deviceScaleFactor: 1, mobile: false, screenWidth: 320, screenHeight: 568 };

test('viewport survives a new CDP session for the same target only', () => {
  rememberBrowserViewport('http://127.0.0.1:9222|target-a', metrics, 100);
  assert.deepEqual(getBrowserViewport('http://127.0.0.1:9222|target-a', 150), metrics);
  assert.equal(getBrowserViewport('http://127.0.0.1:9222|target-b', 150), null);
  assert.equal(getBrowserViewport('http://127.0.0.1:9444|target-a', 150), null);
});

test('viewport cache expires and cannot grow unbounded', () => {
  rememberBrowserViewport('expiry-target', metrics, 200);
  assert.equal(getBrowserViewport('expiry-target', 200 + 10 * 60_000), null);
  for (let i = 0; i < 70; i++) rememberBrowserViewport('bounded-' + i, metrics, 1000 + i);
  assert.equal(getBrowserViewport('bounded-0', 1100), null);
  assert.deepEqual(getBrowserViewport('bounded-69', 1100), metrics);
});
