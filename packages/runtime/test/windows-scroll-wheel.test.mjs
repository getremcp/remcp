import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildWindowsScrollPowerShell } from '../src/extended/desktop-windows.mjs';

test('Windows wheel deltas are sent as signed integers without a failing uint cast', () => {
  const script = buildWindowsScrollPowerShell(0, 600);
  assert.match(readFileSync(new URL('../src/native/windows/pointer.cs', import.meta.url),'utf8'), /mouse_event\(uint f,uint x,uint y,int d,UIntPtr i\)/);
  assert.match(script, /mouse_event\(0x0800,0,0,-600,\[UIntPtr\]::Zero\)/);
  assert.doesNotMatch(script, /\[uint32\]\(\[int\]-/);
});

test('Windows horizontal wheel deltas keep their sign', () => {
  const script = buildWindowsScrollPowerShell(-240, 0);
  assert.match(script, /mouse_event\(0x01000,0,0,-240,\[UIntPtr\]::Zero\)/);
});
