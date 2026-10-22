import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { xmlEscape } from '../src/cli/service.mjs';
import { resolvedCliScript, shellQuote } from '../src/cli/service-paths.mjs';

test('platform service quoting remains escaped and public XML helper remains available', () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(xmlEscape('<node path="a&b">'), '&lt;node path=&quot;a&amp;b&quot;&gt;');
  assert.equal(resolvedCliScript('/a/nonexistent/remcp'), path.resolve('/a/nonexistent/remcp'));
});

test('macOS CLI shim is idempotent and uninstall removes only its managed markers', t => {
  const home = mkdtempSync(path.join(tmpdir(), 'remcp-macos-shim-'));
  t.after(() => rmSync(home, { recursive:true, force:true }));
  const modulePath = fileURLToPath(new URL('../src/cli/service-macos.mjs', import.meta.url));
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const { ensureMacCliCommand, removeMacCliCommand } = await import(pathToFileURL(${JSON.stringify(modulePath)}));
    const shim = ensureMacCliCommand({}, { cliPath:'/opt/remcp/remcp', nodePath:'/opt/node/bin/node' });
    const content = fs.readFileSync(shim, 'utf8');
    const profilePath = path.join(process.env.HOME, '.zshrc');
    const originalProfile = fs.readFileSync(profilePath, 'utf8');
    const again = ensureMacCliCommand({}, { cliPath:'/opt/remcp/remcp', nodePath:'/opt/node/bin/node' });
    const repeatedProfile = fs.readFileSync(profilePath, 'utf8');
    removeMacCliCommand();
    const removed = !fs.existsSync(shim);
    const cleanedProfile = fs.readFileSync(profilePath, 'utf8');
    fs.writeFileSync(shim, '#!/bin/sh\\necho user-owned\\n');
    const refused = ensureMacCliCommand({}, { cliPath:'/opt/remcp/remcp', nodePath:'/opt/node/bin/node' });
    const untouched = fs.readFileSync(shim, 'utf8').includes('user-owned');
    console.log(JSON.stringify({
      content, validPath:shim === again,
      repeatedProfile:repeatedProfile === originalProfile,
      removed, cleanedProfile, refused, untouched,
    }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding:'utf8', timeout:10_000,
    env: { ...process.env, HOME:home, NODE_ENV:'test', REMCP_TEST_PLATFORM:'darwin', REMCP_TEST_SHELL:'/bin/zsh' },
  });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.match(report.content, /ReMCP managed CLI shim/);
  assert.match(report.content, /opt\/node\/bin\/node/);
  assert.equal(report.validPath,true);
  assert.equal(report.repeatedProfile,true);
  assert.equal(report.removed,true);
  assert.doesNotMatch(report.cleanedProfile,/ReMCP CLI PATH/);
  assert.equal(report.refused,null);
  assert.equal(report.untouched,true);
});
