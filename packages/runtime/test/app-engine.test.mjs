import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAppLaunchAlias } from '../src/extended/app-launch-registry.mjs';
import { createAppInventoryCache } from '../src/extended/app-inventory-cache.mjs';

test('friendly app names resolve to native launch targets on every OS', () => {
  for (const [platform, expected] of [
    ['linux', 'code'], ['win32', 'Visual Studio Code'], ['darwin', 'Visual Studio Code'],
  ]) {
    assert.deepEqual(resolveAppLaunchAlias('VS Code', platform), {
      id:'vscode', requested:'VS Code', target:expected,
    });
  }
  assert.equal(resolveAppLaunchAlias('chrome', 'linux').target, 'google-chrome');
  assert.equal(resolveAppLaunchAlias('Mozilla Firefox', 'darwin').target, 'Firefox');
  assert.equal(resolveAppLaunchAlias('VLC', 'linux').target, 'vlc');
  assert.deepEqual(resolveAppLaunchAlias('LibreOffice Writer','linux').args,['--writer']);
  assert.deepEqual(resolveAppLaunchAlias('LibreOffice Calc','darwin').args,['--calc']);
  assert.equal(resolveAppLaunchAlias('LibreOffice Writer','win32').args,undefined);
});

test('explicit executables, paths and unknown applications are not rewritten', () => {
  for (const name of ['/usr/bin/code', './code', 'C:\\Apps\\code.exe', 'code', 'My custom app']) {
    assert.equal(resolveAppLaunchAlias(name, 'linux'), null);
  }
  assert.equal(resolveAppLaunchAlias('VS Code', 'freebsd'), null);
  assert.equal(resolveAppLaunchAlias(null, 'linux'), null);
});

test('inventory cache coalesces concurrent scans, honors TTL and refresh', async () => {
  let tick = 100;
  let calls = 0;
  const cache = createAppInventoryCache({ ttlMs:30_000, now:() => tick });
  const loader = async () => {
    calls += 1;
    await Promise.resolve();
    return { rows:[{ name:'Code' }], backend:'test', call:calls };
  };
  const [first, second] = await Promise.all([cache(loader), cache(loader)]);
  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  assert.equal((await cache(loader)).call, 1);
  tick += 30_001;
  assert.equal((await cache(loader)).call, 2);
  assert.equal((await cache(loader, { refresh:true })).call, 3);
});

test('inventory scan failure is not cached', async () => {
  let calls = 0;
  const cache = createAppInventoryCache();
  await assert.rejects(cache(async () => { calls += 1; throw new Error('OS unavailable'); }), /OS unavailable/);
  assert.deepEqual(await cache(async () => { calls += 1; return [1]; }), [1]);
  assert.equal(calls, 2);
});
