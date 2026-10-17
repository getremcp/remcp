import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { releasePairPresentAtCli } from '../src/cli/service.mjs';
import { VERSION } from '../src/version.mjs';

const bin = path.resolve('bin/remcp.mjs');

function fakeExecutable(file, body) {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

test('a legacy Linux user service is inferred, repaired, and recorded during update', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const prefix = path.join(root, 'global');
  const configDir = path.join(root, 'config');
  const log = path.join(root, 'calls.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    serverUrl: 'https://example.invalid',
    deviceId: 'test',
    deviceToken: 'test',
    deviceName: 'test',
    runtime: { kind: 'npm', packageName: '@example/local-runtime', packageSpec: '@example/local-runtime@1.2.3', entry: 'dist/index.js' },
  }));
  fakeExecutable(path.join(fakeBin, 'npm'), 'echo "npm $@" >> "$REMCP_TEST_LOG"\nif [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi');
  fakeExecutable(path.join(fakeBin, 'systemctl'), 'echo "systemctl $@" >> "$REMCP_TEST_LOG"');
  const serviceFile = path.join(home, '.config', 'systemd', 'user', 'remcp-agent.service');
  mkdirSync(path.dirname(serviceFile), { recursive: true });
  writeFileSync(serviceFile, '[Service]\nExecStart="/old/node/bin/remcp" start\nRestart=always\n');
  const env = {
    ...process.env,
    HOME: home,
    REMCP_CONFIG_DIR: configDir,
    REMCP_TEST_LOG: log,
    REMCP_TEST_PREFIX: prefix,
    NODE_ENV: 'test',
    REMCP_TEST_PLATFORM: 'linux',
    PATH: `${fakeBin}:${process.env.PATH}`,
    REMCP_NPM: path.join(fakeBin, 'npm'),
  };

  const update = spawnSync(process.execPath, [bin, 'update'], { env, encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const launcherFile = path.join(configDir, 'remcp-agent-launcher');
  assert.match(readFileSync(serviceFile, 'utf8'), new RegExp(launcherFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(readFileSync(launcherFile, 'utf8'), new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/remcp`));
  const saved = JSON.parse(readFileSync(path.join(configDir, 'config.json'), 'utf8'));
  assert.equal(saved.serviceInstalled, true);
  assert.equal(saved.configSchemaVersion, 1);
});

test('a legacy Windows scheduled task is inferred and refreshed during update', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const prefix = path.join(root, 'global');
  const configDir = path.join(root, 'config');
  const log = path.join(root, 'calls.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    serverUrl: 'https://example.invalid',
    deviceId: 'test',
    deviceToken: 'test',
    deviceName: 'test',
    runtime: { kind: 'npm', packageName: '@example/local-runtime', packageSpec: '@example/local-runtime@1.2.3', entry: 'dist/index.js' },
  }));
  fakeExecutable(path.join(fakeBin, 'npm'), 'echo "npm $@" >> "$REMCP_TEST_LOG"\nif [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi');
  fakeExecutable(path.join(fakeBin, 'schtasks.exe'), 'echo "schtasks $@" >> "$REMCP_TEST_LOG"\nexit 0');
  const env = {
    ...process.env,
    HOME: home,
    REMCP_CONFIG_DIR: configDir,
    REMCP_TEST_LOG: log,
    REMCP_TEST_PREFIX: prefix,
    NODE_ENV: 'test',
    REMCP_TEST_PLATFORM: 'win32',
    PATH: `${fakeBin}:${process.env.PATH}`,
    REMCP_NPM: path.join(fakeBin, 'npm'),
  };

  const update = spawnSync(process.execPath, [bin, 'update'], { env, encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /schtasks \/Query \/TN ReMCP Agent/);
  assert.match(calls, /schtasks \/Create \/TN ReMCP Agent .* \/SC ONLOGON \/RL HIGHEST \/IT \/F/,
    'Windows service creation must be interactive from the first Task Scheduler write');
  assert.doesNotMatch(calls, /schtasks \/Change \/TN ReMCP Agent/,
    'fresh/update repair must not use schtasks /Change, which can prompt for the Windows account password');
  const launcherFile = path.join(configDir, 'remcp-agent.cmd');
  const launcher = readFileSync(launcherFile, 'utf8');
  assert.ok(calls.includes(launcherFile),
    'the scheduled task points at the stable ReMCP launcher rather than an npm-generated shim');
  assert.ok(launcher.includes(`set \"NPM_CONFIG_PREFIX=${prefix}\"`),
    'the launcher preserves the private npm prefix for background updates');
  assert.ok(launcher.includes(`set \"PATH=${path.dirname(process.execPath)};%PATH%\"`),
    'the launcher pins the runtime directory without adding it to the system PATH');
  assert.ok(launcher.includes(`call \"${path.join(prefix, 'remcp.cmd')}\" start --service`));
  const saved = JSON.parse(readFileSync(path.join(configDir, 'config.json'), 'utf8'));
  assert.equal(saved.serviceInstalled, true);
  assert.equal(saved.configSchemaVersion, 1);
});

test('managed Windows private-prefix update restores packages and shims when npm fails', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-win-rollback-'));
  const home = path.join(root, 'home');
  const localAppData = path.join(root, 'local');
  const prefix = path.join(localAppData, 'ReMCP', 'runtime');
  const fakeBin = path.join(root, 'bin');
  const configDir = path.join(root, 'config');
  const clientDir = path.join(prefix, 'node_modules', '@remcp', 'remcp');
  const runtimeDir = path.join(prefix, 'node_modules', '@remcp', 'runtime');
  mkdirSync(clientDir, { recursive:true });
  mkdirSync(runtimeDir, { recursive:true });
  mkdirSync(fakeBin, { recursive:true });
  mkdirSync(configDir, { recursive:true });
  writeFileSync(path.join(clientDir, 'marker.txt'), 'old-client');
  writeFileSync(path.join(runtimeDir, 'marker.txt'), 'old-runtime');
  for (const [name, contents] of [
    ['remcp', 'old-shim'],
    ['remcp.cmd', 'old-cmd'],
    ['remcp.ps1', 'old-ps1'],
  ]) writeFileSync(path.join(prefix, name), contents);

  fakeExecutable(path.join(fakeBin, 'npm'), `
if [ "$1" = "prefix" ]; then
  echo "$REMCP_TEST_PREFIX"
  exit 0
fi
if [ "$1" = "install" ]; then
  mkdir -p "$REMCP_TEST_PREFIX/node_modules/@remcp/remcp" "$REMCP_TEST_PREFIX/node_modules/@remcp/runtime"
  echo corrupt-client > "$REMCP_TEST_PREFIX/node_modules/@remcp/remcp/marker.txt"
  echo corrupt-runtime > "$REMCP_TEST_PREFIX/node_modules/@remcp/runtime/marker.txt"
  echo corrupt-shim > "$REMCP_TEST_PREFIX/remcp"
  echo corrupt-cmd > "$REMCP_TEST_PREFIX/remcp.cmd"
  echo corrupt-ps1 > "$REMCP_TEST_PREFIX/remcp.ps1"
  exit 7
fi
exit 0
`);

  const script = [
    "const { npmGlobalUpdate } = await import('./src/cli/service.mjs');",
    "npmGlobalUpdate(['@remcp/remcp','@remcp/runtime'], '@remcp/remcp@9.9.9', '@remcp/runtime@9.9.9');",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      LOCALAPPDATA: localAppData,
      REMCP_CONFIG_DIR: configDir,
      REMCP_TEST_PREFIX: prefix,
      NODE_ENV: 'test',
      REMCP_TEST_PLATFORM: 'win32',
      REMCP_NPM: path.join(fakeBin, 'npm'),
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
  });
  assert.notEqual(result.status, 0, 'the injected npm failure must propagate');
  assert.equal(readFileSync(path.join(clientDir, 'marker.txt'), 'utf8'), 'old-client');
  assert.equal(readFileSync(path.join(runtimeDir, 'marker.txt'), 'utf8'), 'old-runtime');
  assert.equal(readFileSync(path.join(prefix, 'remcp'), 'utf8'), 'old-shim');
  assert.equal(readFileSync(path.join(prefix, 'remcp.cmd'), 'utf8'), 'old-cmd');
  assert.equal(readFileSync(path.join(prefix, 'remcp.ps1'), 'utf8'), 'old-ps1');
  assert.deepEqual(
    readdirSync(prefix).filter(name => name.startsWith('.remcp-update-backup-')),
    [],
    'rollback backup must be consumed after restoration',
  );
});

test('Windows npm shims report installed client and runtime versions from the prefix root', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-win-prefix-'));
  const prefix = path.join(root, 'runtime');
  const configDir = path.join(root, 'config');
  const cliPath = path.join(prefix, 'remcp.cmd');
  mkdirSync(path.join(prefix, 'node_modules', '@remcp', 'remcp'), { recursive: true });
  mkdirSync(path.join(prefix, 'node_modules', '@remcp', 'runtime'), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(cliPath, '@echo off\r\n');
  writeFileSync(path.join(prefix, 'node_modules', '@remcp', 'remcp', 'package.json'), JSON.stringify({ version: '7.8.9' }));
  writeFileSync(path.join(prefix, 'node_modules', '@remcp', 'runtime', 'package.json'), JSON.stringify({ version: '7.8.9' }));

  const script = [
    "const { installationVersionsAtCliPath } = await import('./src/cli/service.mjs');",
    "process.stdout.write(JSON.stringify(installationVersionsAtCliPath(process.env.REMCP_TEST_CLI, '@remcp/runtime')));",
  ].join('\n');
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      NODE_ENV: 'test',
      REMCP_TEST_PLATFORM: 'win32',
      REMCP_CONFIG_DIR: configDir,
      REMCP_TEST_CLI: cliPath,
    },
  });
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  const versions = JSON.parse(probe.stdout);
  assert.equal(versions.cliVersion, '7.8.9');
  assert.equal(versions.runtimeVersion, '7.8.9');
  assert.equal(versions.cliPath, cliPath);
});


test('an update of an already-loaded macOS service never boots out its own updater', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const prefix = path.join(root, 'global');
  const configDir = path.join(root, 'config');
  const log = path.join(root, 'calls.log');
  const loaded = path.join(root, 'launchd-loaded');
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    configSchemaVersion: 1,
    serverUrl: 'https://example.invalid',
    deviceId: 'test',
    deviceToken: 'test',
    deviceName: 'test',
    serviceInstalled: true,
    runtime: { kind: 'npm', packageName: '@example/local-runtime', packageSpec: '@example/local-runtime@1.2.3', entry: 'dist/index.js' },
  }));
  fakeExecutable(path.join(fakeBin, 'npm'), 'echo "npm $@" >> "$REMCP_TEST_LOG"\nif [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi');
  fakeExecutable(path.join(fakeBin, 'launchctl'), [
    'echo "launchctl $@" >> "$REMCP_TEST_LOG"',
    'if [ "$1" = "print" ]; then [ -f "$REMCP_LAUNCHD_LOADED" ]; exit $?; fi',
    'if [ "$1" = "bootout" ]; then rm -f "$REMCP_LAUNCHD_LOADED"; exit 0; fi',
    'if [ "$1" = "bootstrap" ]; then touch "$REMCP_LAUNCHD_LOADED"; exit 0; fi',
    'exit 0',
  ].join('\n'));
  const env = {
    ...process.env,
    HOME: home,
    REMCP_CONFIG_DIR: configDir,
    REMCP_TEST_LOG: log,
    REMCP_TEST_PREFIX: prefix,
    REMCP_LAUNCHD_LOADED: loaded,
    NODE_ENV: 'test',
    REMCP_TEST_PLATFORM: 'darwin',
    PATH: `${fakeBin}:${process.env.PATH}`,
    REMCP_NPM: path.join(fakeBin, 'npm'),
  };

  const install = spawnSync(process.execPath, [bin, 'install'], { env, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr || install.stdout);
  writeFileSync(log, '');

  const update = spawnSync(process.execPath, [bin, 'update'], { env, encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /launchctl print gui\/\d+\/com\.remcp\.agent/);
  assert.doesNotMatch(calls, /launchctl bootout/, 'an in-place update must not unload the job that owns the updater');
  assert.doesNotMatch(calls, /launchctl bootstrap/, 'an already-loaded unchanged job does not need re-bootstrap');
  assert.match(calls, /launchctl submit -l com\.remcp\.agent\.restart\./,
    'the loaded service is restarted out-of-process after the updater returns');
});


test('macOS preference changes restart a loaded agent through the detached helper too', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const configDir = path.join(root, 'config');
  const log = path.join(root, 'calls.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    configSchemaVersion: 1,
    serverUrl: 'https://example.invalid',
    serviceInstalled: true,
  }));
  writeFileSync(path.join(configDir, 'runtime.json'), JSON.stringify({ telemetryEnabled: true }));
  fakeExecutable(path.join(fakeBin, 'launchctl'), [
    'echo "launchctl $@" >> "$REMCP_TEST_LOG"',
    'if [ "$1" = "print" ]; then exit 0; fi',
    'exit 0',
  ].join('\n'));
  const plistFile = path.join(home, 'Library', 'LaunchAgents', 'com.remcp.agent.plist');
  mkdirSync(path.dirname(plistFile), { recursive: true });
  writeFileSync(plistFile, '<plist><dict></dict></plist>\n');

  const env = {
    ...process.env,
    HOME: home,
    REMCP_CONFIG_DIR: configDir,
    REMCP_TEST_LOG: log,
    NODE_ENV: 'test',
    REMCP_TEST_PLATFORM: 'darwin',
    PATH: `${fakeBin}:${process.env.PATH}`,
  };
  const result = spawnSync(process.execPath, [bin, 'telemetry', 'off'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /launchctl print gui\/\d+\/com\.remcp\.agent/);
  assert.match(calls, /launchctl submit -l com\.remcp\.agent\.restart\./);
  assert.doesNotMatch(calls, /launchctl bootout/);
  assert.doesNotMatch(calls, /launchctl kickstart -k/, 'the caller must return before the helper performs the destructive restart');
});


test('update synchronizes an exact release pair into a distinct canonical service Node installation', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-sync-'));
  const home = path.join(root, 'home');
  const configDir = path.join(root, 'config');
  const fakeBin = path.join(root, 'bin');
  const log = path.join(root, 'calls.log');
  const servicePrefix = path.join(root, 'service-node');
  const serviceNode = path.join(servicePrefix, 'bin', 'node');
  const serviceCli = path.join(servicePrefix, 'lib', 'node_modules', '@remcp', 'remcp', 'bin', 'remcp.mjs');
  const serviceClientPackage = path.join(servicePrefix, 'lib', 'node_modules', '@remcp', 'remcp', 'package.json');
  const serviceRuntimePackage = path.join(servicePrefix, 'lib', 'node_modules', '@remcp', 'runtime', 'package.json');

  mkdirSync(home, { recursive:true });
  mkdirSync(configDir, { recursive:true });
  mkdirSync(fakeBin, { recursive:true });
  mkdirSync(path.dirname(serviceNode), { recursive:true });
  mkdirSync(path.dirname(serviceCli), { recursive:true });
  mkdirSync(path.dirname(serviceRuntimePackage), { recursive:true });
  fakeExecutable(serviceNode, 'exit 0');
  writeFileSync(serviceCli, '#!/usr/bin/env node\n');
  writeFileSync(serviceClientPackage, JSON.stringify({ name:'@remcp/remcp', version:VERSION }));
  writeFileSync(serviceRuntimePackage, JSON.stringify({ name:'@remcp/runtime', version:VERSION }));

  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    serverUrl:'https://remcp.site',
    deviceId:'test',
    deviceToken:'test',
    deviceName:'test',
    trustRuntime:true,
    serviceInstalled:true,
    serviceNodePath:serviceNode,
    serviceCliPath:serviceCli,
    runtime:{ kind:'npm', packageName:'@remcp/runtime', packageSpec:'@remcp/runtime@' + VERSION, entry:'src/index.mjs' },
  }));
  const serviceFile = path.join(home, '.config', 'systemd', 'user', 'remcp-agent.service');
  mkdirSync(path.dirname(serviceFile), { recursive:true });
  writeFileSync(serviceFile, '[Service]\nExecStart="/old/launcher" start\n');

  fakeExecutable(path.join(fakeBin, 'npm'), [
    'echo "npm $@" >> "$REMCP_TEST_LOG"',
    'if [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi',
    'exit 0',
  ].join('\n'));
  fakeExecutable(path.join(fakeBin, 'systemctl'), 'echo "systemctl $@" >> "$REMCP_TEST_LOG"\nexit 0');

  const env = {
    ...process.env,
    HOME:home,
    REMCP_CONFIG_DIR:configDir,
    REMCP_TEST_LOG:log,
    REMCP_TEST_PREFIX:path.join(root, 'interactive-prefix'),
    REMCP_NPM:path.join(fakeBin, 'npm'),
    NODE_ENV:'test',
    REMCP_TEST_PLATFORM:'linux',
    INVOCATION_ID:'',
    PATH:fakeBin + ':' + process.env.PATH,
  };
  const result = spawnSync(process.execPath, [
    bin, 'update',
    '--client', '@remcp/remcp@' + VERSION,
    '--runtime', '@remcp/runtime@' + VERSION,
  ], { env, encoding:'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const calls = readFileSync(log, 'utf8');
  const needle = 'npm install --global @remcp/remcp@' + VERSION + ' @remcp/runtime@' + VERSION;
  const exactPairInstalls = calls.split('\n').filter(line => line.includes(needle));
  assert.ok(exactPairInstalls.length >= 2,
    'the exact release pair is installed in the invoking prefix and canonical service prefix');
  assert.ok(exactPairInstalls.every(line => line.includes('--prefer-online')),
    'every exact release-pair update must revalidate npm metadata instead of trusting a stale packument');
  const launcher = readFileSync(path.join(configDir, 'remcp-agent-launcher'), 'utf8');
  assert.ok(launcher.includes(serviceNode));
  assert.ok(launcher.includes(serviceCli));
  const saved = JSON.parse(readFileSync(path.join(configDir, 'config.json'), 'utf8'));
  assert.equal(saved.serviceNodePath, serviceNode);
  assert.equal(saved.serviceCliPath, serviceCli);
});
