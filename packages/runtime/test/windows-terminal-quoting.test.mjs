import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshWorkspace } from './helpers.mjs';

const root = freshWorkspace('windows-terminal-quoting');
const { startProcessTool, readProcessOutputTool, forceTerminateTool } =
  await import('../src/tools/terminal.mjs');

async function execute(command) {
  const started = await startProcessTool({ command, timeout_ms: 1000 });
  const pid = started.structuredContent.pid;
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const page = await readProcessOutputTool({ pid, offset: 0, length: 100, timeout_ms: 0 });
      if (page.structuredContent.exited) {
        assert.equal(page.structuredContent.exitCode, 0, page.structuredContent.output);
        return page.structuredContent.output.trim();
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('Windows shell command did not exit');
  } finally {
    await forceTerminateTool({ pid });
  }
}

test('Windows terminal executes quoted PowerShell code instead of printing it', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async () => {
  const result = await execute(
    'powershell.exe -NoProfile -NonInteractive -Command "Write-Output (\'quoted value \'+(1+2))"');
  assert.equal(result, 'quoted value 3');
});

test('Windows terminal preserves executable paths, spaced arguments and quoted ampersands', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async () => {
  const script = path.join(root, 'script space.mjs');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const result = await execute(
    '"' + process.execPath + '" "' + script + '" "value with spaces" "a&b"');
  assert.deepEqual(JSON.parse(result), ['value with spaces', 'a&b']);
});

test('Windows terminal supports a configured PowerShell shell', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const script = path.join(root, 'configured-shell-runner.mjs');
  fs.writeFileSync(script, [
    "import assert from 'node:assert/strict';",
    'import { startProcessTool, readProcessOutputTool, forceTerminateTool } from '
      + JSON.stringify(new URL('../src/tools/terminal.mjs', import.meta.url).href) + ';',
    execute.toString(),
    'console.log(await execute(' + JSON.stringify("Write-Output ('configured '+(2+3))") + '));',
  ].join('\n'));
  const { stdout } = await promisify(execFile)(process.execPath, [script], {
    env: { ...process.env, REMCP_RUNTIME_SHELL: path.join(process.env.SystemRoot,
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') },
    timeout: 25000, windowsHide: true,
  });
  assert.equal(stdout.trim(), 'configured 5');
});
