import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uiAction } from '../src/extended/desktop-windows.mjs';

const cases = [
  { action:'invoke', name:'QA button' },
  { action:'focus', name:'QA text' },
  { action:'set_value', name:'QA text', value:"Привет 'Windows'" },
  { action:'set_value', name:'QA text', value:'Infinity' },
  { action:'set_range_value', name:'QA slider', value:47.5 },
];

async function scripts() {
  const captured = [];
  for (const args of cases) {
    await uiAction(args, { runPowerShellFn:async script => {
      captured.push(script);
      return { stdout:'{}' };
    } });
  }
  return captured;
}

test('non-range UI actions never embed non-finite numbers in their PowerShell program', async () => {
  const generated = await scripts();
  for (let i = 0; i < cases.length; i += 1) {
    assert.doesNotMatch(generated[i], /\[double\](?:NaN|-?Infinity)/, cases[i].action);
  }
  assert.match(generated.at(-1), /SetValue\(\[double\]47\.5\)/);
});

test('invalid range values fail before launching PowerShell', async () => {
  for (const value of [undefined, 'not a number', NaN, Infinity, -Infinity]) {
    await assert.rejects(() => uiAction({ action:'set_range_value', name:'QA', value }, {
      runPowerShellFn:async () => assert.fail('must not launch PowerShell'),
    }), /finite numeric value/);
  }
});

test('all generated UI action programs parse in Windows PowerShell 5.1', {
  skip:process.platform !== 'win32', timeout:30000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'remcp-uia-parser-'));
  t.after(() => rmSync(directory, { recursive:true, force:true }));
  const payload = join(directory, 'scripts.json');
  writeFileSync(payload, JSON.stringify(await scripts()), 'utf8');
  const escapedPath = payload.replace(/'/g, "''");
  const program = `$ErrorActionPreference='Stop';$scripts=[IO.File]::ReadAllText('${escapedPath}',[Text.Encoding]::UTF8)|ConvertFrom-Json;foreach($s in $scripts){$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseInput($s,[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors|Out-String)}};'UIA_PARSE_OK '+$scripts.Count`;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', program,
  ], { encoding:'utf8', timeout:25000, windowsHide:true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /UIA_PARSE_OK 5/);
});
