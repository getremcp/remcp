import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `remcp doctor` is the command a stuck user runs, so it must answer "can this machine run a tool?"
// with a verdict instead of a stack trace.
test('doctor resolves the runtime, performs a real handshake and reports a verdict', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'remcp-doctor-'));
  try {
    writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
      serverUrl: 'http://127.0.0.1:9', deviceId: 'doctor-device', deviceToken: 'x', deviceName: 'Doctor',
      runtime: { kind: 'npm', packageName: '@remcp/runtime', packageSpec: '@remcp/runtime@0.2.0', entry: 'src/index.mjs' },
    }));
    const result = spawnSync(process.execPath, ['bin/remcp.mjs', 'doctor'], {
      cwd: new URL('..', import.meta.url).pathname,
      // A legacy Linux service can export a package-nested npm prefix. Doctor is read-only
      // and must remain available to diagnose and repair that exact broken installation.
      env: { ...process.env, REMCP_CONFIG_DIR: configDir,
        NPM_CONFIG_PREFIX: path.join(configDir, 'lib', 'node_modules', '@remcp', 'remcp') },
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    const output = `${result.stdout}`;
    const start = output.indexOf('{');
    assert.ok(start >= 0, `doctor printed a report: ${output.slice(0, 200)}`);
    // stderr may carry Node warnings, so only stdout is parsed.
    const report = JSON.parse(output.slice(start, output.lastIndexOf('}') + 1));
    assert.equal(report.configured, true);
    // The server is unreachable on port 9, which must be reported, not thrown.
    assert.equal(report.server.reachable, false);
    assert.ok(report.server.error);
    assert.ok(report.diagnosis, 'the diagnosis is always present');
    assert.ok(['ok', 'runtime-not-installed', 'runtime-entry-missing', 'runtime-handshake-failed'].includes(report.diagnosis.verdict));
    assert.equal(typeof report.diagnosis.entryExists, 'boolean');
    assert.equal(report.diagnosis.nodeVersion, process.versions.node);
    if (report.diagnosis.verdict !== 'ok') assert.ok(report.diagnosis.hint, 'a failure explains how to fix it');
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('diagnostic deadline rejects stalled handshakes without AbortSignal cooperation', async () => {
  const { doctorDeadline } = await import('../src/cli/doctor.mjs');
  const started = Date.now();
  await assert.rejects(doctorDeadline(new Promise(() => {}), 30), /timed out/);
  assert.ok(Date.now() - started < 500);
});

test('Windows missing-runtime diagnosis is quarantine-aware without bypassing AV', async () => {
  const { missingRuntimeHint } = await import('../src/cli/doctor.mjs');
  const windows = missingRuntimeHint('win32');
  assert.match(windows, /antivirus quarantine/i);
  assert.match(windows, /Keep protection enabled/);
  assert.match(windows, /do not restore flagged files/i);
  assert.match(windows, /update --repair --no-restart/);
  assert.match(windows, /approved release/);
  assert.ok(windows.indexOf('antivirus') < windows.indexOf('repair with:'));
  const linux = missingRuntimeHint('linux');
  assert.match(linux, /^Reinstall with: npx --yes @remcp\/remcp@latest update$/);
});
