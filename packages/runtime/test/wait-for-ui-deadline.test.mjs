import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const linux = process.platform === 'linux';
const actionUrl = pathToFileURL(path.resolve('src/extended/desktop-ui-actions.mjs')).href;
const coreUrl = pathToFileURL(path.resolve('src/extended/desktop-core.mjs')).href;

function runWithPythonShim(shell, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remcp-ui-deadline-'));
  const shim = path.join(root, 'python3');
  fs.writeFileSync(shim, '#!/bin/sh\n' + shell + '\n', { mode:0o755 });
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd:path.resolve('.'),
      encoding:'utf8',
      timeout:6000,
      env:{ ...process.env, PATH:root + path.delimiter + process.env.PATH },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
    const line = result.stdout.trim().split('\n').find(row => row.startsWith('WAIT_RESULT='));
    assert.ok(line, result.stdout || 'missing result');
    return JSON.parse(line.slice('WAIT_RESULT='.length));
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
}

for (const options of [
  { state:'present', name:'never-a-ui-element' },
  { condition:'text_exists', text:'never-a-ui-element' },
  { state:'changed' },
]) {
  test(`wait_for_ui honors the deadline during a stalled AT-SPI snapshot (${options.state || options.condition})`, {
    skip:!linux,
  }, () => {
    // The shim replaces only the AT-SPI subprocess, so this exercises real
    // uiMatches -> uiSnapshot -> Linux adapter -> runFile deadline plumbing.
    const source = `import { waitForUi } from ${JSON.stringify(actionUrl)};
      const started=Date.now();
      const result=await waitForUi(${JSON.stringify({ ...options, timeout_ms:500, poll_ms:100 })});
      console.log('WAIT_RESULT='+JSON.stringify({
        ...result.structuredContent,
        wall_ms:Date.now()-started
      }));`;
    const result = runWithPythonShim('exec /bin/sleep 4', source);
    assert.equal(result.state, 'timeout', JSON.stringify(result));
    assert.ok(result.wall_ms >= 350 && result.wall_ms < 1800,
      `500ms deadline exceeded: ${result.wall_ms}ms`);
    assert.ok(result.elapsed_ms < 1800, JSON.stringify(result));
  });
}

test('wait_for_ui resolves a cached label before refreshing the accessibility tree', {
  skip:!linux,
}, () => {
  const node = { id:'linux:123:r.0', pid:123, role:'button', name:'Fixture button',
    x:10, y:10, width:100, height:30 };
  const source = `import { waitForUi } from ${JSON.stringify(actionUrl)};
    import { enrichUiPayload } from ${JSON.stringify(coreUrl)};
    enrichUiPayload({ nodes:[${JSON.stringify(node)}] });
    const result=await waitForUi({state:'present', label:0, timeout_ms:900, poll_ms:100});
    console.log('WAIT_RESULT='+JSON.stringify(result.structuredContent));`;
  const result = runWithPythonShim(
    "printf '%s\\n' '" + JSON.stringify([node]) + "'", source);
  assert.equal(result.state, 'present', JSON.stringify(result));
  assert.equal(result.matched, 1);
  assert.equal(result.nodes[0].id, node.id);
});
