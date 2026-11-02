import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshWorkspace } from './helpers.mjs';
import { browserExecutable } from '../src/extended/browser-endpoint.mjs';

const root = freshWorkspace('windows-browser-discovery');

test('Windows browser discovery finds Edge installed under Program Files (x86)', {
  skip: process.platform !== 'win32',
}, (t) => {
  const keys = ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA', 'REMCP_BROWSER_BINARY'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  process.env.PROGRAMFILES = path.join(root, 'Program Files');
  process.env['PROGRAMFILES(X86)'] = path.join(root, 'Program Files (x86)');
  process.env.LOCALAPPDATA = path.join(root, 'Local');
  delete process.env.REMCP_BROWSER_BINARY;
  const edge = path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  fs.mkdirSync(path.dirname(edge), { recursive: true });
  fs.writeFileSync(edge, 'synthetic discovery fixture; never executed');
  assert.equal(browserExecutable(), edge);
});
