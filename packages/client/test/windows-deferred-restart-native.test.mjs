import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowsTaskAbsenceCommand } from '../src/cli/windows-supervisor.mjs';

const execFileAsync = promisify(execFile);
const quote = value => String(value).replaceAll("'", "''");
const powershell = script => execFileAsync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-Command', script,
], { windowsHide:true, timeout:45000 });

test('deferred restart helper survives ending its ancestor Scheduled Task', {
  skip:process.platform !== 'win32', timeout:135000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remcp-task-handoff-'));
  const taskName = 'ReMCP QA handoff ' + randomUUID();
  const marker = path.join(root, 'runs.json');
  const helper = path.join(root, 'windows-task-restart.mjs');
  const entry = path.join(root, 'task-entry.mjs');
  const helperLog = path.join(root, 'helper.log');
  let last;
  // Exercise the exact production helper against an independently owned task.
  // Only its constant task-name dependency is replaced; the real ReMCP task is untouched.
  // Redirect only ignored child output to an owned diagnostic file. Restart logic
  // remains unchanged, and failures remain inspectable after task cleanup.
  const source = fs.readFileSync(new URL('../src/cli/windows-task-restart.mjs', import.meta.url), 'utf8');
  assert.equal(source.split("stdio:'ignore'").length, 2);
  fs.writeFileSync(helper, source.replace("stdio:'ignore'",
    "stdio:['ignore',fs.openSync(" + JSON.stringify(helperLog) + ",'a'),fs.openSync(" + JSON.stringify(helperLog) + ",'a')]"));
  fs.writeFileSync(path.join(root, 'env.mjs'),
    'export const windowsTaskName=' + JSON.stringify(taskName) + ';\n');
  fs.writeFileSync(entry, [
    "import fs from 'node:fs';",
    "import {scheduleWindowsTaskRestart} from './windows-task-restart.mjs';",
    'const marker=' + JSON.stringify(marker) + ';',
    'const runs=fs.existsSync(marker)?JSON.parse(fs.readFileSync(marker)).runs+1:1;',
    'fs.writeFileSync(marker,JSON.stringify({runs,at:Date.now()}));',
    'if(runs===1){scheduleWindowsTaskRestart();setInterval(()=>{},1000);}',
  ].join('\n'));
  t.after(async () => {
    const before = await powershell(windowsTaskAbsenceCommand(taskName));
    if (before.stdout.trim() === 'PRESENT') {
      await powershell(`$ErrorActionPreference='Stop';$t=Get-ScheduledTask -TaskName '${quote(taskName)}';if($t.State -eq 'Running'){Stop-ScheduledTask -InputObject $t};Unregister-ScheduledTask -InputObject $t -Confirm:$false`);
    }
    const after = await powershell(windowsTaskAbsenceCommand(taskName));
    assert.equal(after.stdout.trim(), 'ABSENT', 'owned task must be removed before fixture files');
    if (last?.runs === 2) fs.rmSync(root, { recursive:true, force:true, maxRetries:2 });
    else t.diagnostic('Preserved owned failure evidence: ' + root);
  });
  const argumentsText = '"' + entry + '"';
  await powershell(`$ErrorActionPreference='Stop';$a=New-ScheduledTaskAction -Execute '${quote(process.execPath)}' -Argument '${quote(argumentsText)}';$p=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries;Register-ScheduledTask -TaskName '${quote(taskName)}' -Action $a -Principal $p -Settings $s | Out-Null;Start-ScheduledTask -TaskName '${quote(taskName)}'`);
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    try { last = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch {}
    if (last?.runs === 2) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (last?.runs !== 2) {
    t.diagnostic(await powershell(`$t=Get-ScheduledTask -TaskName '${quote(taskName)}';$i=$t|Get-ScheduledTaskInfo;[pscustomobject]@{State=[string]$t.State;LastTaskResult=$i.LastTaskResult;LastRunTime=$i.LastRunTime}|ConvertTo-Json -Compress`).then(r=>r.stdout));
    t.diagnostic(fs.existsSync(helperLog) ? fs.readFileSync(helperLog, 'utf8') : 'No helper output');
  }
  assert.equal(last?.runs, 2, 'the helper must restart only its disposable ancestor task');
});
