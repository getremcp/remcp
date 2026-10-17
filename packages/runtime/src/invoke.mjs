import { toolHandlers } from './catalog.mjs';
import { extendedToolHandlers } from './extended/catalog.mjs';
import { describeFilesystemFailure } from './permissions.mjs';
import { recordEvent } from './telemetry.mjs';
import { classifyRuntimeToolError } from './error-classes.mjs';
import { ToolError, text } from './util.mjs';

export function hasTool(name) {
  return toolHandlers.has(name) || extendedToolHandlers.has(name);
}

export async function invokeTool(name, args = {}, extra = {}) {
  const started = performance.now();
  const definition = toolHandlers.get(name) || extendedToolHandlers.get(name);
  if (!definition) {
    recordEvent('tool_call', { tool: 'unknown_tool', success: false, errorKind: 'unknown_tool', durationMs: 0 });
    return text(`Unknown tool: ${name}`, true);
  }
  if (extra?.signal?.aborted) {
    return text(`Tool ${name} was cancelled by the client before it started.`, true);
  }
  try {
    const result = await definition.handler(args || {}, extra || {});
    recordEvent('tool_call', { tool: definition.name, durationMs: performance.now() - started, success: result?.isError !== true, ...(result?.isError === true ? { errorKind:'tool_error' } : {}) });
    return result;
  } catch (error) {
    recordEvent('tool_call', { tool: definition.name, durationMs: performance.now() - started, success: false, errorKind: classifyRuntimeToolError(error, definition.name) });
    if (error instanceof ToolError) return text(error.message, true);
    return text(`Tool ${name} failed: ${describeFilesystemFailure(error, { path: error?.path })}`, true);
  }
}
