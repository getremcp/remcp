/**
 * Bounded ReMCP release discovery. The deadline covers both the HTTP response
 * and its JSON body. AbortSignal alone does not reliably cancel stalled TCP
 * connects on every supported Node/undici + operating-system combination.
 *
 * No credentials or local computer data are transmitted here: the caller
 * supplies the trusted ReMCP relay's public version endpoint.
 */
export async function fetchUpdateManifest(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 5_000,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError('Update manifest timeout must be 1–60000 milliseconds');
  }
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error('ReMCP update manifest check exceeded its deadline');
      error.name = 'TimeoutError';
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, {
          redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok) return null;
        return response.json();
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    // Release a response connection if a late completion beats the deadline
    // after Promise.race has already chosen the timed-out branch.
    controller.abort();
  }
}