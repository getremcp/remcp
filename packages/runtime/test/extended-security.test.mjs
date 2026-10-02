import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { environmentTool } from '../src/extended/diagnostics.mjs';
import { runFileHeadLines, runWithInput, safeEnvironment } from '../src/extended/common.mjs';

test('environment variables are opt-in and credential-bearing values are redacted', async t => {
  const previous = {
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    SAFE_FIXTURE: process.env.SAFE_FIXTURE,
    OPAQUE_URL: process.env.OPAQUE_URL,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.DATABASE_URL = 'postgres://user:pass@localhost/db';
  process.env.REDIS_URL = 'redis://:secret@localhost:6379';
  process.env.SAFE_FIXTURE = 'visible';
  process.env.OPAQUE_URL = 'https://user:pass@example.test/path';

  const base = JSON.parse((await environmentTool({})).content[0].text);
  assert.equal(Object.hasOwn(base, 'environment'), false, 'environment values must be opt-in');
  for (const key of ['platform','arch','node','cwd','home','temp','shell','path_entries']) {
    assert.ok(Object.hasOwn(base, key), `environment payload exposes ${key}`);
  }
  assert.ok(Array.isArray(base.path_entries), 'PATH is exposed as a stable ordered array');
  for (const stale of ['hostname','release','path','env']) {
    assert.equal(Object.hasOwn(base, stale), false, `environment payload does not emit stale field ${stale}`);
  }

  const withEnv = JSON.parse((await environmentTool({ include_env: true })).content[0].text);
  assert.equal(withEnv.environment.DATABASE_URL, '***');
  assert.equal(withEnv.environment.REDIS_URL, '***');
  assert.equal(withEnv.environment.OPAQUE_URL, '***');
  assert.equal(withEnv.environment.SAFE_FIXTURE, 'visible');

  const sanitized = safeEnvironment();
  assert.equal(sanitized.DATABASE_URL, '***');
});

test('runFileHeadLines stops a noisy child after the requested number of lines', async () => {
  const result = await runFileHeadLines(process.execPath, ['-e', "for(let i=0;i<100000;i++) console.log('line-'+i)"], 7, { label:'line head fixture', timeout:5000 });
  assert.equal(result.stdout.split('\n').filter(Boolean).length, 7);
  assert.match(result.stdout, /^line-0\nline-1\n/);
  assert.match(result.stdout, /line-6\n?$/);
});

test('runWithInput bounds child stdout and stderr before buffering them in memory', async () => {
  await assert.rejects(
    () => runWithInput(process.execPath, ['-e', "process.stdout.write('x'.repeat(4096))"], '', { label: 'bounded fixture', maxBuffer: 1024 }),
    /exceeded the 1024 byte output limit/,
  );
});

test('runWithInput converts an early stdin close into a ToolError instead of an uncaught EPIPE', async () => {
  await assert.rejects(
    () => runWithInput(
      process.execPath,
      ['-e', "process.stdin.destroy(); setTimeout(()=>process.exit(0),50)"],
      'x'.repeat(8 * 1024 * 1024),
      { label: 'closed stdin fixture', timeout: 2000 },
    ),
    /closed stdin fixture input failed: write EPIPE/,
  );
});
