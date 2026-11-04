import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteWindowsArgument } from '../src/extended/windows-argv.mjs';

test('Windows command-line quoting preserves empty, spaced and quoted arguments', () => {
  assert.equal(quoteWindowsArgument(''), '""');
  assert.equal(quoteWindowsArgument('two words'), '"two words"');
  assert.equal(quoteWindowsArgument('say "hello"'), '"say \\"hello\\""');
  assert.equal(quoteWindowsArgument('C:\\path with spaces\\'), '"C:\\path with spaces\\\\"');
  assert.equal(quoteWindowsArgument('slash\\"quote'), '"slash\\\\\\"quote"');
  assert.equal(quoteWindowsArgument('Ж ✓ 日本語'), '"Ж ✓ 日本語"');
});

test('Windows command-line quoting rejects a NUL before spawning an application', () => {
  assert.throws(() => quoteWindowsArgument('bad\0argument'), /must not contain NUL/);
});
