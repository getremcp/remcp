import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as desktop from '../src/extended/desktop.mjs';

const modules = [
  'desktop.mjs', 'desktop-core.mjs', 'desktop-ui-actions.mjs',
  'desktop-vision.mjs', 'desktop-computer-snapshot.mjs',
  'desktop-computer-actions.mjs',
];

test('desktop API is unchanged after capability module separation', () => {
  assert.deepEqual(Object.keys(desktop), [
    'boundedComputerSnapshot', 'clipboard', 'computerAction',
    'computerActionWindowTextArgs', 'computerSnapshot', 'cursorPosition',
    'desktopHandlers', 'displayInventory', 'dragDrop', 'keyboard',
    'launchApp', 'listWindows', 'mapOcrBoxToDesktop', 'notification',
    'openPath', 'pointer', 'revealPath', 'screenshotRegion', 'scroll',
    'typeText', 'uiAction', 'uiFind', 'uiSnapshot', 'waitForUi', 'windowAction',
  ]);
  assert.equal(typeof desktop.computerSnapshot, 'function');
  assert.equal(typeof desktop.desktopHandlers, 'object');
});
test('no split cross-platform desktop file exceeds 500 lines', async () => {
  for (const name of modules) {
    const source = await readFile(new URL('../src/extended/' + name, import.meta.url), 'utf8');
    assert.ok(source.trimEnd().split(/\r?\n/).length <= 500, name);
  }
});
