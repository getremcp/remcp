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
const sourceOnly=Object.values(WINDOWS_INTEROP).every(item=>item.file.endsWith('.cs'));
test('every packaged interop asset matches its pinned source or binary digest', () => {
 assert.equal(Object.keys(WINDOWS_INTEROP).length, 9);
 const base = new URL('../src/native/windows/', import.meta.url);
 for (const [id, item] of Object.entries(WINDOWS_INTEROP)) {
  const asset=fs.readFileSync(new URL(item.file,base));
  assert.equal(crypto.createHash('sha256').update(asset).digest('hex'),item.sha256,id);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL(id+'.cs',base))).digest('hex'),item.sourceSha256,id);
  if(sourceOnly){
   assert.equal(item.file,id+'.cs');
   assert.equal(item.sha256,item.sourceSha256);
   assert.equal(item.signatureStatus,'NotApplicable');
  }else{
   assert.equal(asset.subarray(0,2).toString(),'MZ');
   assert.ok(item.file.endsWith('.dll'));
  }
 }
 if(sourceOnly)assert.deepEqual(fs.readdirSync(base).filter(file=>/\.dll$/i.test(file)),[],
  'public source-only package must not contain a compiled helper');
});
test('loader enforces source SHA256 or verified immutable DLL without fallback', () => {
 const script=windowsInteropLoad('ui-mouse');
 if(sourceOnly){
  assert.match(script,/ComputeHash\(\$remcpBytes\)/);
  assert.match(script,/REMCP_WINDOWS_SOURCE_BLOCKED/);
  assert.match(script,/Add-Type -TypeDefinition/);
  assert.doesNotMatch(script,/Assembly\]::LoadFrom|\.dll/);
 }else{
  assert.match(script,/Get-FileHash/);
  assert.match(script,/Assembly\]::LoadFrom/);
  assert.ok(script.indexOf('Get-FileHash')<script.indexOf('Assembly]::LoadFrom'));
  assert.doesNotMatch(script,/Add-Type|TypeDefinition|csc\.exe|FromBase64String/);
 }
 assert.throws(()=>windowsInteropLoad('../outside'),/Unknown/);
});
