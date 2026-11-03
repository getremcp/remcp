import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWindowsClipboardPowerShell, buildWindowsClipboardReadPowerShell, decodeWindowsClipboardRead } from '../src/extended/desktop-windows.mjs';

test('Windows clipboard clear uses the native clear API, not Set-Clipboard with empty text', () => {
  const script = buildWindowsClipboardPowerShell('clear', '');
  assert.match(script, /System\.Windows\.Forms/);
  assert.match(script, /Clipboard\]::Clear\(\)/);
  assert.doesNotMatch(script, /Set-Clipboard/);
});

test('writing an empty string clears the Windows clipboard without Set-Clipboard', () => {
  const script = buildWindowsClipboardPowerShell('write', '');
  assert.match(script, /Clipboard\]::Clear\(\)/);
  assert.doesNotMatch(script, /Set-Clipboard/);
});

test('writing nonempty Unicode text retains the base64 PowerShell data path', () => {
  const sample = 'ReMCP Привет 🔑';
  const script = buildWindowsClipboardPowerShell('write', sample);
  assert.match(script, /Set-Clipboard/);
  assert.ok(script.includes(Buffer.from(sample, 'utf16le').toString('base64')));
});

test('reading the Windows clipboard returns UTF-8 base64 instead of OEM stdout', () => {
  const script = buildWindowsClipboardReadPowerShell();
  assert.match(script, /Get-Clipboard -Raw/);
  assert.match(script, /ToBase64String\(\[Text\.Encoding\]::UTF8\.GetBytes/);
});

test('decoding the clipboard read preserves payload newlines and ignores transport whitespace', () => {
  for (const suffix of ['', '\n', '\r\n', '\n\n', '\r\n\r\n']) {
    const sample = 'ReMCP Привет ✓ 日本語' + suffix;
    const encoded = Buffer.from(sample, 'utf8').toString('base64');
    assert.equal(decodeWindowsClipboardRead(encoded + '\r\n'), sample);
  }
  assert.equal(decodeWindowsClipboardRead(''), '');
});
