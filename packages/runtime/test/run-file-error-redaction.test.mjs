import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { runFile } from '../src/extended/common.mjs';

test('failed PowerShell-style process must not echo executable arguments', async () => {
  const sensitiveArgument = 'private-path-marker-9e2d';
  await assert.rejects(
    runFile(process.execPath, ['-e', 'process.exit(7)', sensitiveArgument], { label:'Windows GUI probe' }),
    error => {
      assert.match(error.message, /^Windows GUI probe failed:/);
      assert.match(error.message, /exit(?:ed)? (?:code|with code) 7/i);
      assert.doesNotMatch(error.message, /private-path-marker-9e2d|process\.exit\(7\)/);
      return true;
    },
  );
});
