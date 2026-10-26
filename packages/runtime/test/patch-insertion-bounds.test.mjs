import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHunks, parseUnifiedDiff } from '../src/patch.mjs';

const apply = (content, position, text = 'INSERTED') => {
  const diff = ['--- a/test.txt', '+++ b/test.txt', `@@ -${position},0 +${position + 1},1 @@`, `+${text}`, ''].join('\n');
  const [file] = parseUnifiedDiff(diff);
  return applyHunks(content, file.hunks);
};

test('a zero-context patch must not silently clamp an invalid insertion position', () => {
  const original = 'first\nsecond\n';
  const result = apply(original, 1000);
  assert.equal(result.failed.length, 1);
  assert.equal(result.applied.length, 0);
  assert.equal(result.updated, original);
});

test('valid zero-context insertions at the start and EOF retain precise placement', () => {
  const original = 'first\nsecond\n';
  const start = apply(original, 0);
  assert.equal(start.failed.length, 0);
  assert.equal(start.updated, 'INSERTED\nfirst\nsecond\n');
  const eof = apply(original, 2);
  assert.equal(eof.failed.length, 0);
  assert.equal(eof.updated, 'first\nsecond\nINSERTED\n');
});

test('empty file permits a zero-based first insertion but no later position', () => {
  assert.equal(apply('', 0).updated, 'INSERTED');
  const outside = apply('', 1);
  assert.equal(outside.failed.length, 1);
  assert.equal(outside.updated, '');
});

test('overflowed line positions do not become valid insertion offsets', () => {
  const original = 'keep\n';
  for (const position of [Number.MAX_SAFE_INTEGER + 1, 10 ** 17]) {
    const result = apply(original, position);
    assert.equal(result.failed.length, 1);
    assert.equal(result.updated, original);
  }
});

test('valid insertion preserves CRLF line endings', () => {
  const result = apply('first\r\nsecond\r\n', 1);
  assert.equal(result.failed.length, 0);
  assert.equal(result.updated, 'first\r\nINSERTED\r\nsecond\r\n');
});
