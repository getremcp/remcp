import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { windowsInteropLoad } from '../src/extended/windows-interop.mjs';
import { WINDOWS_INTEROP } from '../src/native/windows/manifest.mjs';
import { verifyWindowsInterop } from '../src/native/windows/verify.mjs';
test('runtime preflight checks the Windows binary inventory before startup',()=>verifyWindowsInterop({platform:'win32'}));

test('desktop and audio production modules contain no runtime C# compilation', () => {
 for (const file of ['desktop-windows.mjs','desktop-windows-msaa.mjs','diagnostics-audio.mjs']) {
  const source = fs.readFileSync(new URL('../src/extended/'+file, import.meta.url),'utf8');
  assert.doesNotMatch(source, /Add-Type(?: -TypeDefinition)? @'|WINDOWS_AUDIO_CORE_CSHARP|Add-Type -TypeDefinition/);
 }
});
test('every packaged interop DLL matches its published binary and source digests', () => {
 assert.equal(Object.keys(WINDOWS_INTEROP).length, 9);
 for (const [id, item] of Object.entries(WINDOWS_INTEROP)) {
  const base = new URL('../src/native/windows/', import.meta.url);
  const dll = fs.readFileSync(new URL(item.file,base));
  assert.equal(dll.subarray(0,2).toString(),'MZ');
  assert.equal(crypto.createHash('sha256').update(dll).digest('hex'),item.sha256,id);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL(id+'.cs',base))).digest('hex'),item.sourceSha256,id);
 }
});
test('loader uses a fixed packaged DLL and verifies SHA256 before loading', () => {
 const script=windowsInteropLoad('ui-mouse');
 assert.match(script,/Get-FileHash/);
 assert.match(script,/Assembly\]::LoadFrom/);
 assert.ok(script.indexOf('Get-FileHash')<script.indexOf('Assembly]::LoadFrom'));
 assert.doesNotMatch(script,/Add-Type|TypeDefinition|csc\.exe|FromBase64String/);
 assert.throws(()=>windowsInteropLoad('../outside'),/Unknown/);
});
