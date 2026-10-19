import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnDetached } from '../src/extended/common.mjs';
import { classifyBrowserLaunchExit, observeBrowserLaunchExit, browserLaunchExitHint } from '../src/extended/browser-launch-lifecycle.mjs';

test('dedicated browser exit classification is bounded and never infers a crash from clean exit', () => {
  assert.equal(classifyBrowserLaunchExit({ code:0 }), 'clean_exit');
  assert.equal(classifyBrowserLaunchExit({ code:137 }), 'nonzero_exit');
  assert.equal(classifyBrowserLaunchExit({ code:null, signal:'SIGTERM' }), 'signaled');
  assert.equal(classifyBrowserLaunchExit({ error:'ENOENT' }), 'spawn_error');
  assert.equal(classifyBrowserLaunchExit({}), 'unknown_exit');
  assert.equal(classifyBrowserLaunchExit({ signal:'untrusted', code:null }), 'unknown_exit');
});

test('detached child reports a safe numeric exit without command, arguments, or profile paths', async () => {
  const actual = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('exit callback did not run')), 6000);
    spawnDetached(process.execPath, ['-e', 'process.exit(7)'], {
      onExit: value => { clearTimeout(timeout); resolve(value); },
      onError: value => { clearTimeout(timeout); reject(new Error(value.code)); },
    });
  });
  assert.equal(actual.code, 7);
  assert.equal(actual.signal, null);
  assert.equal(typeof actual.pid, 'number');
  assert.deepEqual(Object.keys(actual).sort(), ['code', 'pid', 'signal']);
});

test('detached child spawn failure has a typed callback instead of an uncaught error', async () => {
  const actual = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('error callback did not run')), 6000);
    spawnDetached('/does-not-exist/remcp-browser-executable', [], {
      onError: value => { clearTimeout(timeout); resolve(value); },
    });
  });
  assert.equal(actual.code, 'ENOENT');
  assert.equal(actual.pid, null);
  assert.deepEqual(Object.keys(actual).sort(), ['code', 'pid']);
});


test('short-lived browser exit is reported only as a bounded advisory hint', () => {
  const logged = [];
  const now = 100_000;
  observeBrowserLaunchExit({
    code:0, signal:null, url:'https://private.example/secret', profile:'/home/private/cookies',
  }, { startedAt:now - 15000, now, restore:true, isolated:true, log:value => logged.push(value) });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /clean_exit/);
  assert.match(logged[0], /"elapsed_ms":15000/);
  assert.doesNotMatch(logged[0], /private|secret|cookies|home|url/i);
  assert.match(browserLaunchExitHint({ now:now + 1000 }), /clean_exit/);
  assert.doesNotMatch(browserLaunchExitHint({ now:now + 1000 }), /root cause|Chrome crashed/i);
  assert.equal(browserLaunchExitHint({ now:now + 61_000 }), '');
  assert.equal(browserLaunchExitHint({ now:now - 1 }), '');
  assert.equal(browserLaunchExitHint({ now:now + 1000, configured:true }), '');
});
