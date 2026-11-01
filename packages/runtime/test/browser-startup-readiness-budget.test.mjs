import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  browserStartupReadyTimeoutMs,
  browserAutoLaunchArgs,
  waitForBrowserEndpoint,
} from '../src/extended/browser-endpoint.mjs';

test('macOS cold Chrome CDP readiness allowance exceeds measured 5.9s startup', () => {
  const timeout = browserStartupReadyTimeoutMs('darwin');
  assert.ok(timeout >= 9000 && timeout <= 15000, 'bounded macOS cold-start allowance');
});

test('Linux and Windows browser startup readiness retain the 5-second fast path', () => {
  assert.equal(browserStartupReadyTimeoutMs('linux'), 5000);
  assert.equal(browserStartupReadyTimeoutMs('win32'), 5000);
});

test('readiness change does not expand browser debugging bind or remove session isolation', () => {
  // Isolated fixture paths only: never execute a launch against a personal profile.
  const profile = '/tmp/remcp-test-only-browser-cdp';
  const mac = browserAutoLaunchArgs(profile, { platform: 'darwin' });
  assert.ok(mac.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(mac.includes('--remote-debugging-port=9222'));
  assert.ok(mac.includes('--user-data-dir=' + profile));
  assert.ok(!mac.some(flag => flag.includes('0.0.0.0')));
});

test('macOS cold-start poll accepts CDP becoming ready at 6.1s, Linux stays bounded', async () => {
  const simulate = timeoutMs => {
    let elapsed = 0;
    return waitForBrowserEndpoint(timeoutMs, {
      now: () => elapsed,
      pause: async ms => { elapsed += ms; },
      available: async () => elapsed >= 6100,
    });
  };
  assert.equal(await simulate(browserStartupReadyTimeoutMs('linux')), false);
  assert.equal(await simulate(browserStartupReadyTimeoutMs('darwin')), true);
});
