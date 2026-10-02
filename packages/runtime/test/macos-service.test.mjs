import test from 'node:test';
import assert from 'node:assert/strict';

import { macosLaunchctlDomain, serviceTool } from '../src/extended/diagnostics.mjs';

test('macOS service domains honor user and system scope explicitly', () => {
  assert.equal(macosLaunchctlDomain('user', 501), 'gui/501');
  assert.equal(macosLaunchctlDomain('system', 501), 'system');
});

test('macOS system service list reads the system launchd domain', { skip: process.platform !== 'darwin' }, async () => {
  const result = await serviceTool({ action:'list', scope:'system' });
  const output = result?.content?.[0]?.text || '';
  assert.ok(output.length > 0, 'launchctl system-domain inventory must not be empty');
  assert.match(output, /^system\s*=\s*\{/m);
  assert.match(output, /\bservices\s*=\s*\{/);
});
