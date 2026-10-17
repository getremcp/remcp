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

test('persistent install reuses an already complete exact client/runtime pair', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-release-pair-'));
  const modules = path.join(root, 'node_modules');
  const clientDir = path.join(modules, '@remcp', 'remcp');
  const runtimeDir = path.join(modules, '@remcp', 'runtime');
  const cliPath = path.join(clientDir, 'bin', 'remcp.mjs');
  mkdirSync(path.dirname(cliPath), { recursive:true });
  mkdirSync(runtimeDir, { recursive:true });
  writeFileSync(cliPath, '#!/usr/bin/env node\n');
  writeFileSync(path.join(clientDir, 'package.json'), JSON.stringify({ name:'@remcp/remcp', version:VERSION }));
  writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({ name:'@remcp/runtime', version:VERSION }));

  const config = {
    runtime:{ kind:'npm', packageName:'@remcp/runtime', packageSpec:`@remcp/runtime@${VERSION}`, entry:'src/index.mjs' },
  };
  assert.equal(releasePairPresentAtCli(cliPath, config), true);

  writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({ name:'@remcp/runtime', version:'0.0.1' }));
  assert.equal(releasePairPresentAtCli(cliPath, config), false,
    'a stale runtime must force the normal install path instead of reusing a partial pair');
});

test('install uses a stable global CLI path and update refreshes/restarts it', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const prefix = path.join(root, 'global');
  const configDir = path.join(root, 'config');
  const log = path.join(root, 'calls.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ serverUrl: 'https://example.invalid', deviceId: 'test', deviceToken: 'test', deviceName: 'test', runtime: { kind: 'npm', packageName: '@example/local-runtime', packageSpec: '@example/local-runtime@1.2.3', entry: 'dist/index.js' } }));
  fakeExecutable(path.join(fakeBin, 'npm'), 'echo "npm $@" >> "$REMCP_TEST_LOG"\nif [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi');
  fakeExecutable(path.join(fakeBin, 'systemctl'), 'echo "systemctl $@" >> "$REMCP_TEST_LOG"');
  const env = { ...process.env, HOME: home, REMCP_CONFIG_DIR: configDir, REMCP_TEST_LOG: log, REMCP_TEST_PREFIX: prefix, PATH: `${fakeBin}:${process.env.PATH}`, REMCP_NPM: path.join(fakeBin, 'npm') };

  const install = spawnSync(process.execPath, [bin, 'install'], { env, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr || install.stdout);
  const serviceFile = path.join(home, '.config', 'systemd', 'user', 'remcp-agent.service');
  const launcherFile = path.join(configDir, 'remcp-agent-launcher');
  const unit = readFileSync(serviceFile, 'utf8');
  const escapedLauncher = launcherFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(unit, new RegExp(`ExecStart="${escapedLauncher}" start --service`));
  assert.match(readFileSync(launcherFile, 'utf8'), new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/remcp`));
  let calls = readFileSync(log, 'utf8');
  assert.match(calls, new RegExp(`npm install --global @remcp/remcp@${VERSION.replaceAll('.', '\\.')}`));
  assert.match(calls, /@example\/local-runtime@1\.2\.3/);
  assert.match(calls, /systemctl --user enable --now remcp-agent\.service/);

  // Reproduce a real upgrade from one Node manager to another: an old unit points directly at the
  // previous manager and the stable launcher is stale too. Update must migrate the unit to the fixed
  // launcher path and refresh only the launcher target for the current Node/npm installation.
  writeFileSync(serviceFile, readFileSync(serviceFile, 'utf8').replace(launcherFile, '/old/nvm/bin/remcp'));
  writeFileSync(launcherFile, '#!/bin/sh\nexec "/old/node" "/old/nvm/bin/remcp" "$@"\n');

  const update = spawnSync(process.execPath, [bin, 'update'], { env, encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const repairedUnit = readFileSync(serviceFile, 'utf8');
  const repairedLauncher = readFileSync(launcherFile, 'utf8');
  assert.match(repairedUnit, new RegExp(`ExecStart="${escapedLauncher}" start --service`));
  assert.doesNotMatch(repairedUnit, /old\/nvm/);
  assert.match(repairedLauncher, new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/remcp`));
  assert.doesNotMatch(repairedLauncher, /old\/nvm/);
  calls = readFileSync(log, 'utf8');
  assert.match(calls, /npm install --global @remcp\/remcp@latest/);
  assert.match(calls, /systemctl --user daemon-reload/);
  assert.match(calls, /systemctl --user restart remcp-agent\.service/);
});

// A unit that lost its ExecStart line cannot be patched by substitution; the launcher has to be
// rewritten, or the machine keeps starting the CLI from a prefix npm no longer installs into.
test('a systemd unit without ExecStart is rewritten instead of leaving the old CLI running', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const prefix = path.join(root, 'global');
  const configDir = path.join(root, 'config');
  const log = path.join(root, 'calls.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ serverUrl: 'https://example.invalid', deviceId: 'test', deviceToken: 'test', deviceName: 'test', serviceInstalled: true, runtime: { kind: 'npm', packageName: '@example/local-runtime', packageSpec: '@example/local-runtime@1.2.3', entry: 'dist/index.js' } }));
  fakeExecutable(path.join(fakeBin, 'npm'), 'echo "npm $@" >> "$REMCP_TEST_LOG"\nif [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi');
  fakeExecutable(path.join(fakeBin, 'systemctl'), 'echo "systemctl $@" >> "$REMCP_TEST_LOG"');
  const env = { ...process.env, HOME: home, REMCP_CONFIG_DIR: configDir, REMCP_TEST_LOG: log, REMCP_TEST_PREFIX: prefix, PATH: `${fakeBin}:${process.env.PATH}`, REMCP_NPM: path.join(fakeBin, 'npm') };

  const unitFile = path.join(home, '.config', 'systemd', 'user', 'remcp-agent.service');
  mkdirSync(path.dirname(unitFile), { recursive: true });
  writeFileSync(unitFile, '[Unit]\nDescription=ReMCP device agent\n\n[Service]\n# hand-edited, the launcher line is gone\nRestart=always\n');

  const update = spawnSync(process.execPath, [bin, 'update'], { env, encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const unit = readFileSync(unitFile, 'utf8');
  const launcherFile = path.join(configDir, 'remcp-agent-launcher');
  assert.match(unit, new RegExp(`ExecStart="${launcherFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" start --service`), 'the unit is rewritten to the stable supervisor-owned launcher');
  assert.match(readFileSync(launcherFile, 'utf8'), new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/remcp`), 'the launcher targets the prefix npm installed into');
  assert.doesNotMatch(unit, /hand-edited/);
});

test('macOS CLI repair never overwrites or deletes an unrelated user-local command', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-conflict-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const prefix = path.join(root, 'global');
  const configDir = path.join(root, 'config');
  const log = path.join(root, 'calls.log');
  const shim = path.join(home, '.local', 'bin', 'remcp');
  mkdirSync(path.dirname(shim), { recursive:true });
  mkdirSync(fakeBin, { recursive:true });
  mkdirSync(configDir, { recursive:true });
  writeFileSync(shim, '#!/bin/sh\necho unrelated-command\n');
  chmodSync(shim, 0o755);
  writeFileSync(path.join(home, '.zshrc'), '# keep me\n');
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    serverUrl:'https://example.invalid',
    deviceId:'test',
    deviceToken:'test',
    deviceName:'test',
    runtime:{ kind:'npm', packageName:'@example/local-runtime', packageSpec:'@example/local-runtime@1.2.3', entry:'dist/index.js' },
  }));
  fakeExecutable(path.join(fakeBin, 'npm'), [
    'if [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi',
    'exit 0',
  ].join('\n'));
  fakeExecutable(path.join(fakeBin, 'launchctl'), 'exit 0');
  const env = {
    ...process.env,
    HOME:home,
    SHELL:'/bin/zsh',
    REMCP_TEST_SHELL:'/bin/zsh',
    REMCP_CONFIG_DIR:configDir,
    REMCP_TEST_LOG:log,
    REMCP_TEST_PREFIX:prefix,
    REMCP_NPM:path.join(fakeBin, 'npm'),
    NODE_ENV:'test',
    REMCP_TEST_PLATFORM:'darwin',
    PATH:fakeBin + ':' + process.env.PATH,
  };

  const install = spawnSync(process.execPath, [bin, 'install'], { env, encoding:'utf8' });
  assert.equal(install.status, 0, install.stderr || install.stdout);
  assert.equal(readFileSync(shim, 'utf8'), '#!/bin/sh\necho unrelated-command\n');
  assert.doesNotMatch(readFileSync(path.join(home, '.zshrc'), 'utf8'), /ReMCP CLI PATH/,
    'PATH is not changed when the stable command name belongs to somebody else');

  const uninstall = spawnSync(process.execPath, [bin, 'uninstall'], { env, encoding:'utf8' });
  assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  assert.equal(readFileSync(shim, 'utf8'), '#!/bin/sh\necho unrelated-command\n',
    'uninstall leaves a non-ReMCP command untouched');
});

test('macOS install creates an interactive remcp command and uninstall removes only its managed shell block', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-path-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const prefix = path.join(root, 'fnm node with spaces');
  const configDir = path.join(root, 'config');
  const log = path.join(root, 'calls.log');
  mkdirSync(home, { recursive:true });
  mkdirSync(fakeBin, { recursive:true });
  mkdirSync(configDir, { recursive:true });
  writeFileSync(path.join(home, '.zshrc'), '# user setting\nexport KEEP_ME=1\n');
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    serverUrl:'https://example.invalid',
    deviceId:'test',
    deviceToken:'test',
    deviceName:'test',
    runtime:{ kind:'npm', packageName:'@example/local-runtime', packageSpec:'@example/local-runtime@1.2.3', entry:'dist/index.js' },
  }));
  fakeExecutable(path.join(fakeBin, 'npm'), [
    'echo "npm $@" >> "$REMCP_TEST_LOG"',
    'if [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi',
    'exit 0',
  ].join('\n'));
  fakeExecutable(path.join(fakeBin, 'launchctl'), [
    'echo "launchctl $@" >> "$REMCP_TEST_LOG"',
    'if [ "$1" = "print" ]; then exit 1; fi',
    'exit 0',
  ].join('\n'));
  const env = {
    ...process.env,
    HOME:home,
    SHELL:'/bin/zsh',
    REMCP_TEST_SHELL:'/bin/zsh',
    REMCP_CONFIG_DIR:configDir,
    REMCP_TEST_LOG:log,
    REMCP_TEST_PREFIX:prefix,
    REMCP_NPM:path.join(fakeBin, 'npm'),
    NODE_ENV:'test',
    REMCP_TEST_PLATFORM:'darwin',
    PATH:fakeBin + ':' + process.env.PATH,
  };

  const install = spawnSync(process.execPath, [bin, 'install'], { env, encoding:'utf8' });
  assert.equal(install.status, 0, install.stderr || install.stdout);

  const shim = path.join(home, '.local', 'bin', 'remcp');
  assert.equal(existsSync(shim), true, 'install creates a stable user-local remcp command');
  const shimBody = readFileSync(shim, 'utf8');
  assert.match(shimBody, /^#!\/bin\/sh\n# ReMCP managed CLI shim\nexec /);
  assert.ok(shimBody.includes(process.execPath), 'the wrapper pins the node interpreter used by the service');
  assert.ok(shimBody.includes(prefix + '/bin/remcp'), 'the wrapper targets the npm-global CLI even when its prefix contains spaces');
  const firstProfile = readFileSync(path.join(home, '.zshrc'), 'utf8');
  assert.match(firstProfile, /# user setting/);
  assert.match(firstProfile, /# >>> ReMCP CLI PATH >>>/);
  assert.match(firstProfile, /\$HOME\/\.local\/bin/);

  const update = spawnSync(process.execPath, [bin, 'update'], { env, encoding:'utf8' });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const secondProfile = readFileSync(path.join(home, '.zshrc'), 'utf8');
  assert.equal((secondProfile.match(/# >>> ReMCP CLI PATH >>>/g) || []).length, 1,
    'repeated updates keep one idempotent PATH block');
  assert.equal((secondProfile.match(/# <<< ReMCP CLI PATH <<</g) || []).length, 1);

  const uninstall = spawnSync(process.execPath, [bin, 'uninstall'], { env, encoding:'utf8' });
  assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  assert.equal(existsSync(shim), false, 'uninstall removes the ReMCP wrapper');
  const finalProfile = readFileSync(path.join(home, '.zshrc'), 'utf8');
  assert.match(finalProfile, /# user setting/);
  assert.match(finalProfile, /export KEEP_ME=1/);
  assert.doesNotMatch(finalProfile, /ReMCP CLI PATH/);
});

// macOS keeps the interpreter and the CLI path inside the launchd plist, so the same prefix change
// leaves launchd starting a deleted file. The plist has to be rewritten, not just recreated when
// missing — the machine otherwise loops like the Linux unit used to.
test('a macOS plist pointing at an old prefix is rewritten', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const prefix = path.join(root, 'global');
  const configDir = path.join(root, 'config');
  const log = path.join(root, 'calls.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ serverUrl: 'https://example.invalid', deviceId: 'test', deviceToken: 'test', deviceName: 'test', serviceInstalled: true, runtime: { kind: 'npm', packageName: '@example/local-runtime', packageSpec: '@example/local-runtime@1.2.3', entry: 'dist/index.js' } }));
  fakeExecutable(path.join(fakeBin, 'npm'), 'echo "npm $@" >> "$REMCP_TEST_LOG"\nif [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi');
  fakeExecutable(path.join(fakeBin, 'launchctl'), 'echo "launchctl $@" >> "$REMCP_TEST_LOG"');
  const plistFile = path.join(home, 'Library', 'LaunchAgents', 'com.remcp.agent.plist');
  mkdirSync(path.dirname(plistFile), { recursive: true });
  writeFileSync(plistFile, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>ProgramArguments</key><array><string>${process.execPath}</string><string>/old/nvm/bin/remcp</string><string>start</string></array></dict></plist>\n`);
  const env = {
    ...process.env,
    HOME: home,
    REMCP_CONFIG_DIR: configDir,
    REMCP_TEST_LOG: log,
    REMCP_TEST_PREFIX: prefix,
    // `servicePlatform()` only honours the override under NODE_ENV=test.
    NODE_ENV: 'test',
    REMCP_TEST_PLATFORM: 'darwin',
    PATH: `${fakeBin}:${process.env.PATH}`,
    REMCP_NPM: path.join(fakeBin, 'npm'),
  };

  const update = spawnSync(process.execPath, [bin, 'update'], { env, encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const plist = readFileSync(plistFile, 'utf8');
  assert.doesNotMatch(plist, /old\/nvm/, 'the plist no longer launches the deleted CLI');
  assert.match(plist, new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/remcp`));
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /launchctl print gui\/\d+\/com\.remcp\.agent/);
  assert.match(calls, /launchctl submit -l com\.remcp\.agent\.reload\./,
    'a loaded stale job is handed to an independent launchd repair helper');
  assert.equal((calls.match(/launchctl submit -l com\.remcp\.agent\.(?:reload|restart)\./g) || []).length, 1,
    'a plist reload already owns the restart handoff and must not race a second detached restart helper');
  assert.doesNotMatch(calls, /launchctl bootout/, 'the updater itself never boots out its owning job inline');
});


// Releases before serviceInstalled was persisted can still have a valid LaunchAgent plist on disk.
// If launchd has forgotten that job (logout cleanup, migration, manual bootout), update must infer
// that this is a managed install from the plist and bootstrap it again before trying kickstart.
test('a legacy macOS install re-bootstraps an unloaded LaunchAgent during update', () => {
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
  // Intentionally no serviceInstalled flag: this is the persisted shape from older clients.
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ serverUrl: 'https://example.invalid', deviceId: 'test', deviceToken: 'test', deviceName: 'test', runtime: { kind: 'npm', packageName: '@example/local-runtime', packageSpec: '@example/local-runtime@1.2.3', entry: 'dist/index.js' } }));
  fakeExecutable(path.join(fakeBin, 'npm'), 'echo "npm $@" >> "$REMCP_TEST_LOG"\nif [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi');
  fakeExecutable(path.join(fakeBin, 'launchctl'), [
    'echo "launchctl $@" >> "$REMCP_TEST_LOG"',
    'if [ "$1" = "print" ]; then [ -f "$REMCP_LAUNCHD_LOADED" ]; exit $?; fi',
    'if [ "$1" = "bootout" ]; then rm -f "$REMCP_LAUNCHD_LOADED"; exit 0; fi',
    'if [ "$1" = "bootstrap" ]; then touch "$REMCP_LAUNCHD_LOADED"; exit 0; fi',
    'if [ "$1" = "kickstart" ] && [ ! -f "$REMCP_LAUNCHD_LOADED" ]; then echo "Could not find service com.remcp.agent" >&2; exit 113; fi',
    'exit 0',
  ].join('\n'));
  const plistFile = path.join(home, 'Library', 'LaunchAgents', 'com.remcp.agent.plist');
  mkdirSync(path.dirname(plistFile), { recursive: true });
  writeFileSync(plistFile, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>ProgramArguments</key><array><string>${process.execPath}</string><string>${prefix}/bin/remcp</string><string>start</string></array></dict></plist>\n`);
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

  const update = spawnSync(process.execPath, [bin, 'update'], { env, encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const calls = readFileSync(log, 'utf8');
  assert.doesNotMatch(calls, /launchctl bootout/, 'an already-unloaded job can be bootstrapped directly');
  assert.match(calls, /launchctl bootstrap/);
  assert.match(calls, /launchctl submit -l com\.remcp\.agent\.restart\./,
    'the post-update restart is handed to an independent launchd helper');
});


test('an explicit service opt-out is stronger than a stale macOS plist', () => {
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
    configSchemaVersion: 1,
    serverUrl: 'https://example.invalid',
    deviceId: 'test',
    deviceToken: 'test',
    deviceName: 'test',
    serviceInstalled: false,
    runtime: { kind: 'npm', packageName: '@example/local-runtime', packageSpec: '@example/local-runtime@1.2.3', entry: 'dist/index.js' },
  }));
  fakeExecutable(path.join(fakeBin, 'npm'), 'echo "npm $@" >> "$REMCP_TEST_LOG"\nif [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi');
  fakeExecutable(path.join(fakeBin, 'launchctl'), 'echo "launchctl $@" >> "$REMCP_TEST_LOG"');
  const plistFile = path.join(home, 'Library', 'LaunchAgents', 'com.remcp.agent.plist');
  mkdirSync(path.dirname(plistFile), { recursive: true });
  writeFileSync(plistFile, '<plist><dict></dict></plist>\n');
  const env = {
    ...process.env,
    HOME: home,
    REMCP_CONFIG_DIR: configDir,
    REMCP_TEST_LOG: log,
    REMCP_TEST_PREFIX: prefix,
    NODE_ENV: 'test',
    REMCP_TEST_PLATFORM: 'darwin',
    PATH: `${fakeBin}:${process.env.PATH}`,
    REMCP_NPM: path.join(fakeBin, 'npm'),
  };

  const update = spawnSync(process.execPath, [bin, 'update'], { env, encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const calls = readFileSync(log, 'utf8');
  assert.doesNotMatch(calls, /launchctl/, 'an explicit opt-out must not restart or recreate the stale job');
});
