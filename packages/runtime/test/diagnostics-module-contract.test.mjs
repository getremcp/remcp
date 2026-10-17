import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as diagnostics from '../src/extended/diagnostics.mjs';
import * as platform from '../src/extended/diagnostics-platform.mjs';
import * as audio from '../src/extended/diagnostics-audio.mjs';

test('all original diagnostics exports survive the module split', () => {
  const originalExports = [
    'POWER_ACTION_MAX_DELAY_SECONDS',
    'audioTool', 'compactNetworkSummary', 'diagnosticHandlers',
    'environmentTool', 'eventLog', 'filterMacosTcpListeners',
    'gnomeScreencastCandidate', 'gnomeScreencastSupported',
    'installedApps', 'installedAppsPayload', 'linuxListenerBackend',
    'macosLaunchctlDomain', 'networkTool', 'normalizeInstalledApp',
    'normalizePowerActionDelay', 'parseAmixerAudioStatus',
    'parseAvfoundationScreenInput', 'parseInstalledAppsTsv',
    'parsePactlAudioStatus', 'parseWpctlAudioStatus', 'powerAction',
    'recordScreen', 'recordScreenAvailable', 'recordScreenBackend',
    'resolveRecordScreenFfmpeg', 'serviceTool',
    'validateRecordingDestinationFormat', 'waitForPowerActionDelay',
    'windowsAudioPowerShell', 'windowsInstalledAppsPowerShell',
  ];
  assert.deepEqual(Object.keys(diagnostics).sort(), originalExports.sort());
  const implementationNames = [
    ...Object.keys(platform), ...Object.keys(audio),
  ];
  assert.equal(new Set(implementationNames).size, implementationNames.length,
    'split modules must not silently shadow exports');
  for (const module of [platform, audio]) {
    for (const [name, implementation] of Object.entries(module)) {
      assert.equal(diagnostics[name], implementation, `export ${name} identity changed`);
    }
  }
});

test('eight diagnostic handlers keep their original implementation identity', () => {
  assert.deepEqual(diagnostics.diagnosticHandlers, {
    service: platform.serviceTool,
    event_log: platform.eventLog,
    network: platform.networkTool,
    installed_apps: platform.installedApps,
    environment: audio.environmentTool,
    audio: audio.audioTool,
    power_action: diagnostics.powerAction,
    record_screen: diagnostics.recordScreen,
  });
});

test('each diagnostic implementation remains at or below 500 source lines', () => {
  for (const file of [
    'diagnostics.mjs',
    'diagnostics-platform.mjs',
    'diagnostics-audio.mjs',
  ]) {
    const source = readFileSync(new URL(`../src/extended/${file}`, import.meta.url), 'utf8');
    assert.ok(source.split('\n').length <= 501, `${file} exceeds 500 lines`);
  }
});
