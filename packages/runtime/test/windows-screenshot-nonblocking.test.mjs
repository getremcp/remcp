import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runWindowsScreenshot, screenshotAdvice, windowsScreenshotScript } from '../src/tools/files-screenshots.mjs';

const execFileAsync = promisify(execFile);

test('Windows screenshot uses bounded, hidden, asynchronous PowerShell execution', async () => {
  const calls = [];
  const result = await runWindowsScreenshot("C:\\Temp\\a'b.png", async (...args) => {
    calls.push(args);
    return { stdout: '', stderr: '' };
  });
  assert.deepEqual(result, { stdout: '', stderr: '' });
  assert.equal(calls.length, 1);
  const [command, argv, options] = calls[0];
  assert.equal(command, 'powershell.exe');
  assert.deepEqual(argv.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  assert.ok(argv[4].includes("a''b.png"));
  assert.equal(options.timeout, 30_000);
  assert.equal(options.windowsHide, true);
  assert.equal(options.maxBuffer, 64 * 1024);
});

test('Windows screenshot does not block other event loop tasks while child is running', async () => {
  let childCompleted = false;
  const capture = runWindowsScreenshot('C:\\Temp\\test.png', () =>
    execFileAsync(process.execPath, ['-e', 'setTimeout(() => process.stdout.write("done"), 160)'], {
      timeout: 1000, encoding: 'utf8', maxBuffer: 1024,
    }).finally(() => { childCompleted = true; }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(childCompleted, false);
  assert.equal((await capture).stdout, 'done');
});

test('Windows screenshot propagates child process timeout for caller diagnostics', async () => {
  await assert.rejects(
    runWindowsScreenshot('C:\\Temp\\test.png', () => Promise.reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))),
    error => error.code === 'ETIMEDOUT',
  );
});

test('GDI allocation and cleanup are guarded when the desktop is unavailable', () => {
  const script = windowsScreenshotScript('C:\\Temp\\test.png');
  assert.ok(script.includes("$ErrorActionPreference = 'Stop'"));
  assert.ok(script.includes('No valid desktop geometry for screenshot'));
  assert.match(script, /try \{/);
  assert.match(script, /finally \{/);
  assert.ok(script.indexOf('try {') < script.indexOf('New-Object System.Drawing.Bitmap'));
  assert.ok(script.includes('if ($null -ne $g) { $g.Dispose() }'));
  assert.ok(script.includes('if ($null -ne $bmp) { $bmp.Dispose() }'));
});

test('overlapping Windows full-screen captures fail fast instead of creating extra PowerShell processes', async () => {
  let completeFirst;
  const firstPending = new Promise(resolve => { completeFirst = resolve; });
  const first = runWindowsScreenshot('C:\\Temp\\first.png', () => firstPending);
  await assert.rejects(
    runWindowsScreenshot('C:\\Temp\\second.png', () => {
      throw new Error('A second PowerShell process should never be spawned');
    }),
    /already in progress/,
  );
  completeFirst({ stdout: 'first', stderr: '' });
  assert.equal((await first).stdout, 'first');
  const after = await runWindowsScreenshot('C:\\Temp\\third.png', async () => ({ stdout: 'third', stderr: '' }));
  assert.equal(after.stdout, 'third');
});

test('failed Windows capture releases its single-flight admission for retry', async () => {
  await assert.rejects(
    runWindowsScreenshot('C:\\Temp\\failed.png', async () => { throw new Error('GDI unavailable'); }),
    /GDI unavailable/,
  );
  const retried = await runWindowsScreenshot('C:\\Temp\\retry.png', async () => ({ stdout: 'ok' }));
  assert.equal(retried.stdout, 'ok');
});

test('overlapping Windows capture reports retry instead of suggesting a logon', () => {
  const message = screenshotAdvice(['powershell: A Windows screen capture is already in progress'], { platform:'win32' });
  assert.match(message, /already in progress/);
  assert.match(message, /Retry/);
  assert.doesNotMatch(message, /Sign in/);
});
