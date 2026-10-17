import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const helperUrl = new URL('./helpers.mjs', import.meta.url).href;

for (const exitCode of [0, 7]) {
  test(`freshWorkspace cleans up when a child exits with code ${exitCode}`, () => {
    const command = [
      `import { freshWorkspace } from ${JSON.stringify(helperUrl)};`,
      "console.log(freshWorkspace('exit-regression'));",
      `process.exitCode = ${exitCode};`,
    ].join('\n');
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', command],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(child.status, exitCode, child.stderr);
    const workspace = child.stdout.trim();
    assert.match(workspace, /remcp-runtime-exit-regression-/);
    assert.equal(existsSync(workspace), false, 'test workspace must not leak to /tmp');
  });
}
