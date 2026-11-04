import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { launchApp } from '../src/extended/desktop-windows.mjs';

test('Windows launch_app preserves argv boundaries, quotes, Unicode and cwd', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remcp launch argv '));
  try {
    const script = path.join(root, 'capture arguments.mjs');
    const output = path.join(root, 'received.json');
    await writeFile(script, 'import {writeFileSync} from "node:fs";writeFileSync("received.json",JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}));');
    const expected = ['', 'two words', 'say "hello"', 'C:\\path with spaces\\', 'slash\\"quote', "apostrophe's", 'Ж ✓ 日本語', '& | < > % ^ ( )'];
    await launchApp(process.execPath, [script, ...expected], { cwd: root });
    const deadline = Date.now() + 10000;
    let actual;
    while (Date.now() < deadline) {
      try { actual = JSON.parse(await readFile(output, 'utf8')); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(actual, 'launched child must execute and create its read-back file');
    assert.deepEqual(actual.argv, expected);
    assert.equal(actual.cwd.toLowerCase(), root.toLowerCase());
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('Windows launch_app preserves inline executable code arguments', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remcp launch inline '));
  try {
    const output = path.join(root, 'inline.json');
    await launchApp(process.execPath, ['-e', 'require("fs").writeFileSync("inline.json",JSON.stringify(process.argv.slice(1)))', 'a b', 'say "quoted"'], { cwd: root });
    const deadline = Date.now() + 10000;
    let actual;
    while (Date.now() < deadline) {
      try { actual = JSON.parse(await readFile(output, 'utf8')); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual(actual, ['a b', 'say "quoted"']);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
