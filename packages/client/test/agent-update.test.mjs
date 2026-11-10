import test from 'node:test';
import assert from 'node:assert/strict';
import { supervisorRestart, updateDecision } from '../src/agent.mjs';
import { globalCliEntry, globalInstalledVersion, updateInvocationArgs } from '../src/agent-update.mjs';
import { VERSION } from '../src/version.mjs';

test('agent refuses a non-loopback plaintext relay unless explicitly overridden', async () => {
  const { runAgent } = await import('../src/agent.mjs');
  await assert.rejects(() => runAgent({
    serverUrl: 'http://relay.example.test',
    deviceToken: 'fixture-token',
    deviceId: 'fixture-device',
    autoUpdate: false,
  }), /must use https/i);
});

const advertised = (cli, runtime) => ({ cli, runtime, minimum: '0.1.0' });
const decide = input => updateDecision({ runtimePackageName: '@remcp/runtime', ...input });

test('auto-updater resolves the CLI and installed version from the package that is actually running', () => {
  const cli = globalCliEntry();
  assert.ok(cli, 'package-local CLI is available without relying on npm prefix discovery');
  assert.match(cli.replaceAll('\\\\','/'), /\/bin\/remcp\.mjs$/);
  assert.equal(globalInstalledVersion(), VERSION);
});

// The update hands the device over by exiting, so the agent must know whether anything will start it
// again. systemd sets INVOCATION_ID and JOURNAL_STREAM for a unit and every child of that unit
// inherits them, so a `remcp start` run from a shell inside a service (a CI runner, a systemd-run
// scope, another unit) used to exit into nothing: the machine stayed in `/health` as connected and
// read offline in the workspace until someone started the agent by hand.
test('only a service manager that owns this process restarts the agent after an update', () => {
  assert.equal(supervisorRestart({ platform: 'linux', parentOurs: true }), 'systemd');
  assert.equal(supervisorRestart({ platform: 'darwin', parentOurs: true }), 'launchd');
  assert.equal(supervisorRestart({ platform: 'linux', parentOurs: false, dockerenv: true }), 'docker');
  assert.equal(supervisorRestart({ platform: 'linux', parentOurs: false, dockerenv: false }), null);
  assert.equal(supervisorRestart({ platform: 'win32', parentOurs: false, dockerenv: false }), null);
});

test('the agent pins its updater to the exact advertised client/runtime pair', () => {
  assert.deepEqual(
    updateInvocationArgs(
      { target: '@remcp/remcp@0.2.40', runtime: '@remcp/runtime@0.2.40' },
      true,
    ),
    ['update', '--trust-runtime', '--client', '@remcp/remcp@0.2.40', '--runtime', '@remcp/runtime@0.2.40'],
  );
  assert.deepEqual(
    updateInvocationArgs({ target: '@remcp/remcp@0.2.40', runtime: '' }, false),
    ['update', '--client', '@remcp/remcp@0.2.40'],
  );
});

test('the agent updates the client, the runtime, or both', () => {
  // Nothing to do: the machine already runs what the server advertises.
  assert.deepEqual(
    decide({ advertised: advertised('@remcp/remcp@0.2.7', '@remcp/runtime@0.2.7'), cliVersion: '0.2.7', runtimeVersion: '0.2.7' }),
    { needed: false, target: '@remcp/remcp@0.2.7', runtime: '@remcp/runtime@0.2.7', reason: 'current' },
  );
  // Newer client.
  assert.equal(decide({ advertised: advertised('@remcp/remcp@0.2.8', '@remcp/runtime@0.2.8'), cliVersion: '0.2.7', runtimeVersion: '0.2.7' }).reason, 'client');
  // The client is current but the local runtime is behind: this is the case that used to be missed,
  // and the runtime is what actually executes the tools.
  const runtimeOnly = decide({ advertised: advertised('@remcp/remcp@0.2.7', '@remcp/runtime@0.2.7'), cliVersion: '0.2.7', runtimeVersion: '0.2.6' });
  assert.equal(runtimeOnly.reason, 'runtime');
  assert.equal(runtimeOnly.needed, true);
  assert.equal(runtimeOnly.runtime, '@remcp/runtime@0.2.7');
  // An unknown runtime version (the runtime has not reported yet) must not trigger a reinstall.
  assert.equal(decide({ advertised: advertised('@remcp/remcp@0.2.7', '@remcp/runtime@0.2.7'), cliVersion: '0.2.7', runtimeVersion: 'unknown' }).needed, false);
  // A prerelease install moves forward to the release of the same version.
  assert.equal(decide({ advertised: advertised('@remcp/remcp@0.3.0', '@remcp/runtime@0.3.0'), cliVersion: '0.3.0-beta.2', runtimeVersion: '0.3.0-beta.2' }).reason, 'client');
  // An older server must not downgrade a newer machine.
  assert.equal(decide({ advertised: advertised('@remcp/remcp@0.2.6', '@remcp/runtime@0.2.6'), cliVersion: '0.2.7', runtimeVersion: '0.2.7' }).needed, false);
});

test('runtime recovery must not downgrade a client ahead of the server release', () => {
  const olderRelease = advertised('@remcp/remcp@0.2.245', '@remcp/runtime@0.2.245');
  for (const [runtimeVersion, runtimeDown] of [
    ['unknown', true],
    ['offline', true],
    ['0.2.244', false],
    ['0.2.246', false],
  ]) {
    const decision = decide({ advertised: olderRelease, cliVersion: '0.2.246', runtimeVersion, runtimeDown });
    assert.equal(decision.needed, false, `never install the server's older pair from runtime=${runtimeVersion}`);
  }
  const invalidClient = decide({
    advertised: advertised('@unknown/client@9.9.9', '@remcp/runtime@0.2.245'),
    cliVersion: '0.2.246', runtimeVersion: 'unknown', runtimeDown: true,
  });
  assert.equal(invalidClient.needed, false, 'an invalid CLI spec cannot trigger a downgrade via runtime repair');
  const sameRelease = decide({
    advertised: advertised('@remcp/remcp@0.2.246', '@remcp/runtime@0.2.246'),
    cliVersion: '0.2.246', runtimeVersion: 'unknown', runtimeDown: true,
  });
  assert.equal(sameRelease.needed, true, 'a broken runtime can still repair the current release');
  assert.equal(sameRelease.reason, 'runtime-repair');
});

test('only a plain version of the configured runtime package is ever installed', async () => {
  const { isRuntimeSpecFor, normalizeRuntime } = await import('../src/runtime.mjs');
  for (const spec of ['@remcp/runtime@0.2.9', '@remcp/runtime@1.0.0-beta.1', '@remcp/runtime@0.2.9+build.4']) {
    assert.equal(isRuntimeSpecFor('@remcp/runtime', spec), true, spec);
  }
  // Each of these would make npm run code the user never agreed to.
  for (const spec of [
    '@remcp/runtime@npm:@attacker/backdoor@1.0.0',
    '@remcp/runtime@git+https://attacker.example/x.git',
    '@remcp/runtime@https://attacker.example/x.tgz',
    '@remcp/runtime@file:/tmp/payload',
    '@remcp/runtime@latest',
    '@remcp/runtime@^0.2.0',
    '@remcp/runtime@0.2.9@extra',
    '@attacker/backdoor@1.0.0',
  ]) {
    assert.equal(isRuntimeSpecFor('@remcp/runtime', spec), false, spec);
  }
  // A hostile server cannot smuggle a spec through the agent's update decision either: the runtime
  // half is dropped, so the client still updates but nothing else is installed.
  const decision = decide({
    advertised: { cli: '@remcp/remcp@0.2.9', runtime: '@remcp/runtime@npm:@attacker/backdoor@9.9.9', minimum: '0.1.0' },
    cliVersion: '0.2.8', runtimeVersion: '0.2.8', runtimePackageName: '@remcp/runtime',
  });
  assert.equal(decision.needed, true);
  assert.equal(decision.runtime, '', 'the untrusted runtime spec is dropped');
  assert.throws(() => normalizeRuntime({ kind: 'npm', packageName: '..', packageSpec: '..@1.0.0', entry: 'index.mjs' }), /invalid runtime package name/);
  assert.throws(() => normalizeRuntime({ kind: 'npm', packageName: '@remcp/runtime', packageSpec: '@remcp/runtime@1.0.0', entry: '../index.mjs' }), /invalid runtime entry/);

  const hostileClient = decide({
    advertised: { cli: '@attacker/client@9.9.9', runtime: '@remcp/runtime@0.2.8', minimum: '0.1.0' },
    cliVersion: '0.2.8', runtimeVersion: '0.2.8', runtimePackageName: '@remcp/runtime',
  });
  assert.equal(hostileClient.needed, false, 'a server cannot redirect the client updater to another package');
  assert.equal(hostileClient.target, '', 'the untrusted client spec is dropped');
});

test('a device whose runtime never started can repair itself', () => {
  const advertised = { cli: '@remcp/remcp@0.2.9', runtime: '@remcp/runtime@0.2.10', minimum: '0.1.0' };
  // The runtime has never reported a version (broken install) and the runtime is down: comparing
  // versions is impossible, so without this the device would stay broken forever.
  const broken = decide({ advertised, cliVersion: '0.2.9', runtimeVersion: 'unknown', runtimePackageName: '@remcp/runtime', runtimeDown: true });
  assert.equal(broken.needed, true);
  assert.equal(broken.reason, 'runtime-repair');
  assert.equal(broken.runtime, '@remcp/runtime@0.2.10');
  // A healthy runtime that reports its version is only updated when the server advertises a newer one.
  assert.equal(decide({ advertised, cliVersion: '0.2.9', runtimeVersion: '0.2.10', runtimePackageName: '@remcp/runtime', runtimeDown: false }).needed, false, 'already on the advertised runtime');
  assert.equal(decide({ advertised, cliVersion: '0.2.9', runtimeVersion: '0.2.9', runtimePackageName: '@remcp/runtime', runtimeDown: false }).needed, true, 'a newer advertised runtime is installed');
  // A running runtime is never reinstalled just because the agent is unsure.
  assert.equal(decide({ advertised, cliVersion: '0.2.9', runtimeVersion: 'unknown', runtimePackageName: '@remcp/runtime', runtimeDown: false }).needed, false);
});

test('automatic release checks continue at a bounded five-minute interval', async () => {
  const { UPDATE_CHECK_INTERVAL_MS } = await import('../src/agent-update-monitor.mjs');
  assert.equal(UPDATE_CHECK_INTERVAL_MS, 5 * 60 * 1000);
});
