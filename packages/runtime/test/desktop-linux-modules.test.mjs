import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as linux from '../src/extended/desktop-linux.mjs';

const modules = [
  'desktop-linux.mjs',
  'desktop-linux-windows.mjs',
  'desktop-linux-window-actions.mjs',
  'desktop-linux-ui.mjs',
  'desktop-linux-input.mjs',
  'desktop-linux-displays.mjs',
  'desktop-linux-screen.mjs',
];

test('split Linux Desktop adapter preserves exact supported public exports', () => {
  assert.deepEqual(Object.keys(linux), [
    'clipboard', 'cursorPosition', 'displayInventory', 'displayInventoryAvailable',
    'dragDrop', 'keyboard', 'launchApp', 'listWindows', 'notification',
    'openPath', 'parseWlrRandrOutput', 'parseX11PixelBounds', 'parseXrandrDisplayOutput',
    'pointer', 'portalCropGeometry', 'regionScreenshotBackends',
    'resolveLinuxDisplayInventory', 'revealPath', 'screenshotRegion',
    'scroll', 'typeTextFocused', 'typeTextKeys', 'typeTextWindowTarget',
    'uiAction', 'uiSnapshot', 'windowAction',
  ]);
  for (const [name, fn] of Object.entries(linux)) {
    assert.equal(typeof fn, 'function', name);
  }
});

test('all Linux adapter modules remain under the 500-line budget', async () => {
  for (const file of modules) {
    const contents = await readFile(new URL('../src/extended/' + file, import.meta.url), 'utf8');
    const lines = contents.trimEnd().split(/\r?\n/).length;
    assert.ok(lines <= 500, file + ': ' + lines + ' lines');
  }
});
