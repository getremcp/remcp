import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveUpdateTargets, updateAlreadyCurrent } from '../src/cli/update.mjs';
import { VERSION } from '../src/version.mjs';

const currentClient = `@remcp/remcp@${VERSION}`;
const currentRuntime = `@remcp/runtime@${VERSION}`;
const staleRuntime = '@remcp/runtime@0.2.35';

const officialConfig = {
  serverUrl: 'https://remcp.site',
  trustRuntime: true,
  runtime: {
    kind: 'npm',
    packageName: '@remcp/runtime',
    packageSpec: staleRuntime,
    entry: 'src/index.mjs',
  },
};

test('manual update is a no-op when the running and managed service release pair already matches the target', () => {
  const cfg = {
    ...officialConfig,
    runtime:{ ...officialConfig.runtime, packageSpec:currentRuntime },
    installations:[],
  };
  const targets = {
    clientSpec:currentClient,
    runtimeSpec:currentRuntime,
    installable:true,
    persistRuntime:false,
  };
  assert.equal(updateAlreadyCurrent({
    cfg,
    targets,
    currentInstall:{ cliVersion:VERSION, runtimeVersion:VERSION },
    serviceInstall:{ cliVersion:VERSION, runtimeVersion:VERSION },
    serviceExpected:true,
  }), true);

  assert.equal(updateAlreadyCurrent({
    cfg:{ ...cfg, installations:[{ cliPath:process.execPath, cliVersion:'0.2.1', runtimeVersion:'0.2.1' }] },
    targets,
    currentInstall:{ cliVersion:VERSION, runtimeVersion:VERSION },
    serviceInstall:{ cliVersion:VERSION, runtimeVersion:VERSION },
    serviceExpected:true,
  }), true, 'a secondary Node manager installation must not force an update of a healthy service');

  assert.equal(updateAlreadyCurrent({
    cfg,
    targets,
    currentInstall:{ cliVersion:VERSION, runtimeVersion:VERSION },
    serviceInstall:{ cliVersion:VERSION, runtimeVersion:'0.2.35' },
    serviceExpected:true,
  }), false, 'a stale managed runtime still requires convergence');

  assert.equal(updateAlreadyCurrent({
    cfg,
    targets,
    currentInstall:{ cliVersion:VERSION, runtimeVersion:'0.2.35' },
    serviceInstall:{ cliVersion:VERSION, runtimeVersion:VERSION },
    serviceExpected:true,
  }), false, 'a stale running runtime still requires an update');
});

test('manual update follows the trusted server release pair instead of keeping a stale runtime pin', async () => {
  const requests = [];
  const result = await resolveUpdateTargets({
    cfg: officialConfig,
    flags: {},
    env: {},
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return {
        ok: true,
        async json() { return { cli: currentClient, runtime: currentRuntime }; },
      };
    },
  });

  assert.deepEqual(requests.map(request => request.url), ['https://remcp.site/api/agent/version']);
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(result.clientSpec, currentClient);
  assert.equal(result.runtimeSpec, currentRuntime);
  assert.equal(result.persistRuntime, true);
  assert.equal(result.installable, true);
  assert.equal(result.source, 'server');
});

test('an untrusted custom server cannot silently choose code for a manual update', async () => {
  let fetched = false;
  const result = await resolveUpdateTargets({
    cfg: { ...officialConfig, serverUrl: 'https://custom.example', trustRuntime: false },
    flags: {},
    env: {},
    fetchImpl: async () => { fetched = true; throw new Error('must not be called'); },
  });

  assert.equal(fetched, false);
  assert.equal(result.clientSpec, '@remcp/remcp@latest');
  assert.equal(result.runtimeSpec, staleRuntime);
  assert.equal(result.persistRuntime, false);
  assert.equal(result.installable, true);
  assert.equal(result.source, 'configured');
});

test('manual update refuses an insecure configured server before fetching release metadata', async () => {
  await assert.rejects(
    () => resolveUpdateTargets({
      cfg: { ...officialConfig, serverUrl: 'http://custom.example', trustRuntime: true },
      flags: {},
      env: {},
      fetchImpl: async () => { throw new Error('must not fetch over insecure transport'); },
    }),
    /Remote server must use https/,
  );
});

test('trusted-server discovery failure refuses a partial update', async () => {
  const result = await resolveUpdateTargets({
    cfg: officialConfig,
    flags: {},
    env: {},
    fetchImpl: async () => { throw new Error('offline'); },
  });

  assert.equal(result.clientSpec, currentClient);
  assert.equal(result.runtimeSpec, staleRuntime);
  assert.equal(result.persistRuntime, false);
  assert.equal(result.installable, false);
  assert.equal(result.source, 'configured');
  assert.match(result.warning || '', /could not resolve/i);
});

test('invalid server release metadata cannot become an install target', async () => {
  const result = await resolveUpdateTargets({
    cfg: officialConfig,
    flags: {},
    env: {},
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          cli: '@attacker/client@9.9.9',
          runtime: '@remcp/runtime@npm:@attacker/runtime@9.9.9',
        };
      },
    }),
  });

  assert.equal(result.clientSpec, currentClient);
  assert.equal(result.runtimeSpec, staleRuntime);
  assert.equal(result.persistRuntime, false);
  assert.equal(result.installable, false);
  assert.equal(result.source, 'configured');
  assert.match(result.warning || '', /valid server release pair/i);
});

test('first-party server metadata must advertise one client/runtime release version', async () => {
  const result = await resolveUpdateTargets({
    cfg: officialConfig,
    flags: {},
    env: {},
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { cli: currentClient, runtime: '@remcp/runtime@0.0.1' };
      },
    }),
  });

  assert.equal(result.clientSpec, currentClient);
  assert.equal(result.runtimeSpec, staleRuntime);
  assert.equal(result.installable, false);
  assert.match(result.warning || '', /valid server release pair/i);
});

test('explicit update targets remain exact, trusted package versions', async () => {
  await assert.rejects(
    () => resolveUpdateTargets({
      cfg: { ...officialConfig, serverUrl: 'https://custom.example', trustRuntime: false },
      flags: { client: currentClient, runtime: currentRuntime },
      env: {},
      fetchImpl: async () => { throw new Error('must not fetch for explicit targets'); },
    }),
    /without trusting/,
  );

  await assert.rejects(
    () => resolveUpdateTargets({
      cfg: officialConfig,
      flags: { runtime: '@remcp/runtime@latest' },
      env: {},
      fetchImpl: async () => { throw new Error('must not fetch for an explicit runtime'); },
    }),
    /@remcp\/runtime@<version>/,
  );

  await assert.rejects(
    () => resolveUpdateTargets({
      cfg: officialConfig,
      flags: { client: '@attacker/client@9.9.9', runtime: currentRuntime },
      env: {},
      fetchImpl: async () => { throw new Error('must not fetch for explicit targets'); },
    }),
    /@remcp\/remcp@<version>/,
  );

  await assert.rejects(
    () => resolveUpdateTargets({
      cfg: officialConfig,
      flags: { client: currentClient, runtime: '@remcp/runtime@0.0.1' },
      env: {},
      fetchImpl: async () => { throw new Error('must not fetch for explicit targets'); },
    }),
    /same exact release version/,
  );

  const exact = await resolveUpdateTargets({
    cfg: officialConfig,
    flags: { client: currentClient, runtime: currentRuntime },
    env: {},
    fetchImpl: async () => { throw new Error('must not fetch for explicit targets'); },
  });
  assert.equal(exact.clientSpec, currentClient);
  assert.equal(exact.runtimeSpec, currentRuntime);
  assert.equal(exact.installable, true);
  assert.equal(exact.source, 'explicit-pair');
});
