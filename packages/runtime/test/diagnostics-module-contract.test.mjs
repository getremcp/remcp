import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as diagnostics from '../src/extended/diagnostics.mjs';
import * as system from '../src/extended/diagnostics-system.mjs';
import * as audioPower from '../src/extended/diagnostics-audio-power.mjs';
import * as recordScreen from '../src/extended/diagnostics-record-screen.mjs';

test('split diagnostic modules retain the original named exports and handler identities', () => {
  const modules = [system, audioPower, recordScreen];
  const expectedHandlers = {
    service:system.serviceTool,
    event_log:system.eventLog,
    network:system.networkTool,
    installed_apps:system.installedApps,
    environment:system.environmentTool,
    audio:audioPower.audioTool,
    power_action:audioPower.powerAction,
    record_screen:recordScreen.recordScreen,
  };
  assert.deepEqual(diagnostics.diagnosticHandlers, expectedHandlers);
  const implementationExports = modules.flatMap(module => Object.keys(module));
  assert.equal(new Set(implementationExports).size, implementationExports.length,
    'diagnostic implementation modules must not shadow each other');
  assert.deepEqual(
    Object.keys(diagnostics).sort(),
    [...implementationExports, 'diagnosticHandlers'].sort(),
    'the public diagnostic module must re-export all implementation functions',
  );
  for (const module of modules) {
    for (const [name, implementation] of Object.entries(module)) {
      assert.equal(diagnostics[name], implementation, `compatibility export ${name}`);
    }
  }
});

test('diagnostic implementations stay within the 500-line source budget', () => {
  for (const file of [
    'diagnostics.mjs',
    'diagnostics-system.mjs',
    'diagnostics-audio-power.mjs',
    'diagnostics-record-screen.mjs',
  ]) {
    const source = readFileSync(new URL(`../src/extended/${file}`, import.meta.url), 'utf8');
    assert.ok(source.split('\n').length <= 501, `${file} exceeds 500 lines`);
  }
});
