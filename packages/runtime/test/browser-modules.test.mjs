import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as browser from '../src/extended/browser.mjs';

const modules = [
  'browser.mjs', 'browser-endpoint.mjs', 'browser-session.mjs',
  'browser-read.mjs', 'browser-actions.mjs',
];

test('browser public exports remain exactly compatible after capability split', () => {
  assert.deepEqual(Object.keys(browser), [
    'browserAction', 'browserActionInputValue', 'browserActionLocatorText',
    'browserAutoLaunchArgs', 'browserAutoLaunchAvailable', 'browserCapabilityAvailable',
    'browserControlAvailable', 'browserEvaluate', 'browserFind', 'browserHandlers',
    'browserNavigate', 'browserRemoteEnabled', 'browserScrollDeltas',
    'browserSnapshot', 'browserTabs', 'browserWait', 'filterBrowserTargets',
    'findExpression', 'listBrowserTargets', 'shouldRestoreBrowserSession',
  ]);
  assert.equal(typeof browser.browserAction, 'function');
  assert.equal(typeof browser.browserHandlers, 'object');
});

test('browser capability modules all fit the 500-line source budget', async () => {
  for (const name of modules) {
    const source = await readFile(new URL('../src/extended/' + name, import.meta.url), 'utf8');
    assert.ok(source.trimEnd().split(/\r?\n/).length <= 500, name);
  }
});
