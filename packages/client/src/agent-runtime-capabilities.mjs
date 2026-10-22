// Maintains the local MCP runtime tool cache and bounded retry lifecycle.
// The paired-agent connection owns the transport; this module owns only capabilities.
export function normalizeRuntimeToolNames(listed) {
  const tools = Array.isArray(listed?.tools) ? listed.tools : [];
  return [...new Set(tools.map(tool => String(tool?.name || '').trim().slice(0, 128)).filter(Boolean))].slice(0, 256);
}

export function createRuntimeCapabilities({
  getTools, setTools, isActive, announce, jitter, onError = console.error,
  retryBaseMs = 1_000, retryMaxMs = 30_000,
}) {
  let retryDelay = retryBaseMs;
  let retryTimer = null;

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    retryDelay = retryBaseMs;
  }

  function apply(next, { announce: shouldAnnounce = true } = {}) {
    const current = getTools();
    if (next.length === current.length && next.every((name, index) => name === current[index])) return current;
    setTools(next);
    if (shouldAnnounce) announce(next);
    return next;
  }

  function scheduleRetry(client) {
    if (!isActive(client) || retryTimer) return;
    const delay = jitter(retryDelay);
    retryDelay = Math.min(retryMaxMs, retryDelay * 2);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void refresh(client);
    }, delay);
    retryTimer.unref?.();
  }

  async function refresh(client, { announce: shouldAnnounce = true } = {}) {
    if (!client || !isActive(client)) return getTools();
    try {
      const listed = await client.listTools(undefined, { timeout: 3000 });
      // A list request can settle after reconnect/restart. Never publish stale capabilities.
      if (!isActive(client)) return getTools();
      clearRetry();
      apply(normalizeRuntimeToolNames(listed), { announce: shouldAnnounce });
    } catch (error) {
      onError(`ReMCP could not refresh runtime capabilities: ${error instanceof Error ? error.message : String(error)}`);
      scheduleRetry(client);
    }
    return getTools();
  }

  return { apply, clearRetry, refresh, scheduleRetry };
}
