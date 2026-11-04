import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { windowAction } from '../src/extended/desktop-windows.mjs';
import { runPowerShell } from '../src/extended/common.mjs';

async function waitFor(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Owned Windows focus fixture timed out');
}

for (const originallyTopmost of [false, true]) {
  test(`Windows focus preserves topmost=${originallyTopmost}`, {
    skip: process.platform !== 'win32', timeout: 90000,
  }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'remcp-window-focus-'));
    const ready = path.join(root, 'ready.json');
    const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;using System.Runtime.InteropServices;
public static class OwnedFocusFixture {
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int height,uint flags);
}
'@
$window=New-Object Windows.Forms.Form
$window.Text='ReMCP owned focus fixture';$window.Width=420;$window.Height=240
$window.Add_Shown({
 [void][OwnedFocusFixture]::SetWindowPos($window.Handle,[IntPtr]${originallyTopmost ? -1 : -2},0,0,0,0,19)
 [IO.File]::WriteAllText('${ready.replaceAll("'", "''")}',([pscustomobject]@{handle=$window.Handle.ToInt64()}|ConvertTo-Json -Compress))
})
[void]$window.ShowDialog()
$window.Dispose()
`;
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    let launchError;
    let id;
    child.on('error', error => { launchError = error; });
    try {
      const { handle } = await waitFor(async () => {
        if (launchError) throw launchError;
        if (child.exitCode !== null) throw new Error(`Owned focus fixture exited before ready: ${stderr}`);
        try { return JSON.parse(await readFile(ready, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
      });
      id = '0x' + handle.toString(16);
      const isTopmost = async () => {
        const { stdout } = await runPowerShell(`
Add-Type @'
using System;using System.Runtime.InteropServices;
public static class FocusStyleProbe {
 [DllImport("user32.dll",EntryPoint="GetWindowLongW")] public static extern int GetWindowLong(IntPtr h,int index);
}
'@
([FocusStyleProbe]::GetWindowLong([IntPtr]${handle},-20) -band 8) -ne 0
`, { label: 'owned window topmost read-back' });
        assert.match(stdout.trim(), /^(True|False)$/);
        return stdout.trim() === 'True';
      };
      assert.equal(await isTopmost(), originallyTopmost, 'fixture must start in its requested z-order band');
      await windowAction({ action: 'focus', id });
      assert.equal(await isTopmost(), originallyTopmost, 'focusing must preserve the window topmost flag');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try { await windowAction({ action: 'close', ...(id ? { id } : { pid: child.pid }) }); } catch {}
        try { await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5000); }
        catch { child.kill(); await waitFor(() => child.exitCode !== null || child.signalCode !== null, 3000); }
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      child.stderr.destroy();
    }
  });
}
