import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchUpdateManifest } from '../src/fetch-update-manifest.mjs';

const url = 'https://remcp.site/api/agent/version';

test('returns a valid update manifest without losing its fields', async () => {
  const advertised = { client: '0.2.195', runtime: '@remcp/runtime@0.2.195' };
  let request;
  const result = await fetchUpdateManifest(url, {
    timeoutMs: 250,
    fetchImpl: async (input, init) => {
      request = { input, redirect: init.redirect };
      return { ok: true, json: async () => advertised };
    },
  });
  assert.deepEqual(result, advertised);
  assert.deepEqual(request, { input: url, redirect: 'error' });
});

test('preserves no-update semantics for non-2xx responses', async () => {
  const result = await fetchUpdateManifest(url, {
    timeoutMs: 250,
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(result, null);
});

test('hard deadline rejects a fetch that ignores AbortSignal entirely', async () => {
  let signal;
  const started = performance.now();
  await assert.rejects(fetchUpdateManifest(url, {
    timeoutMs: 35,
    fetchImpl: (_, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  }), { name: 'TimeoutError' });
  assert.equal(signal.aborted, true);
  assert.ok(performance.now() - started < 500, 'stalled network call exceeded its hard deadline');
});

test('hard deadline also covers a stalled JSON response body', async () => {
  const started = performance.now();
  await assert.rejects(fetchUpdateManifest(url, {
    timeoutMs: 35,
    fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }),
  }), { name: 'TimeoutError' });
  assert.ok(performance.now() - started < 500);
});

test('handles a fetch rejection without waiting for deadline', async () => {
  await assert.rejects(fetchUpdateManifest(url, {
    timeoutMs: 250,
    fetchImpl: async () => { throw new TypeError('network unavailable'); },
  }), { message: 'network unavailable' });
});

test('late failure after deadline does not produce unhandled rejection', async () => {
  const unhandled = [];
  const listener = reason => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await assert.rejects(fetchUpdateManifest(url, {
      timeoutMs: 12,
      fetchImpl: () => new Promise((_, reject) =>
        setTimeout(() => reject(new Error('too late')), 35)),
    }), { name: 'TimeoutError' });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', listener);
  }
});

test('rejects unbounded or invalid timeout configurations', async () => {
  for (const timeoutMs of [0, -1, 1.2, Number.POSITIVE_INFINITY, 60_001]) {
    await assert.rejects(fetchUpdateManifest(url, { timeoutMs }), RangeError);
  }
});