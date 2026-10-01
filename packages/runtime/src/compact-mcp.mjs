import process from 'node:process';
import { compactRuntimeToolDefinitions, resolveCompactRuntimeCall } from './compact-catalog.mjs';
import { invokeTool } from './invoke.mjs';

const DEFAULT_CAPABILITY_POLL_MS = 3000;

function pollIntervalMs() {
  const requested = Number(process.env.REMCP_CAPABILITY_POLL_MS);
  return Math.min(60_000, Math.max(250, Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_CAPABILITY_POLL_MS));
}

function toolConfig(definition, fromJsonSchema) {
  return {
    title:definition.title,
    description:definition.description,
    inputSchema:fromJsonSchema(definition.inputSchema || { type:'object' }),
    ...(definition.outputSchema ? { outputSchema:fromJsonSchema(definition.outputSchema) } : {}),
    annotations:definition.annotations,
  };
}

function toolUpdate(definition, fromJsonSchema) {
  return {
    title:definition.title,
    description:definition.description,
    paramsSchema:fromJsonSchema(definition.inputSchema || { type:'object' }),
    ...(definition.outputSchema ? { outputSchema:fromJsonSchema(definition.outputSchema) } : {}),
    annotations:definition.annotations,
    enabled:true,
  };
}

function definitionSignature(definition) {
  if (!definition) return '';
  return JSON.stringify({
    title:definition.title,
    description:definition.description,
    inputSchema:definition.inputSchema,
    outputSchema:definition.outputSchema,
    annotations:definition.annotations,
  });
}

export async function startCompactRuntimeMcpServer({ version, instructions, onError = () => {} } = {}) {
  const [{ McpServer, fromJsonSchema }, { serveStdio }] = await Promise.all([
    import('@modelcontextprotocol/server'),
    import('@modelcontextprotocol/server/stdio'),
  ]);
  let definitions = await compactRuntimeToolDefinitions();
  const currentDefinitions = new Map(definitions.map(definition => [definition.name, definition]));
  let activeServer = null;
  let capabilityTimer = null;
  let capabilityPollRunning = false;
  let closed = false;

  const serverHandle = serveStdio(() => {
    const server = new McpServer(
      { name:'remcp-runtime-compact', version },
      {
        capabilities:{ tools:{ listChanged:true } },
        instructions,
        cacheHints:{
          'tools/list':{ ttlMs:3000, cacheScope:'private' },
          'server/discover':{ ttlMs:3000, cacheScope:'private' },
        },
      },
    );
    activeServer = server;
    const registrations = new Map();

    const registerDefinition = definition => {
      const registered = server.registerTool(
        definition.name,
        toolConfig(definition, fromJsonSchema),
        async (args, context) => {
          try {
            const activeDefinitions = [...currentDefinitions.values()];
            const resolved = resolveCompactRuntimeCall(definition.name, args || {}, activeDefinitions);
            return await invokeTool(resolved.runtimeName, resolved.runtimeArguments, { signal:context?.mcpReq?.signal });
          } catch (error) {
            return { content:[{ type:'text', text:error instanceof Error ? error.message : String(error) }], isError:true };
          }
        },
      );
      registrations.set(definition.name, registered);
      return registered;
    };

    for (const definition of definitions) registerDefinition(definition);

    capabilityTimer = setInterval(async () => {
      if (closed || capabilityPollRunning) return;
      capabilityPollRunning = true;
      try {
        const nextDefinitions = await compactRuntimeToolDefinitions();
        const nextByName = new Map(nextDefinitions.map(definition => [definition.name, definition]));
        const names = new Set([...registrations.keys(), ...nextByName.keys()]);

        for (const name of names) {
          const before = currentDefinitions.get(name);
          const after = nextByName.get(name);
          const registered = registrations.get(name);

          if (!after) {
            currentDefinitions.delete(name);
            if (registered?.enabled) registered.disable();
            continue;
          }

          if (!registered) {
            currentDefinitions.set(name, after);
            registerDefinition(after);
            continue;
          }

          if (definitionSignature(before) === definitionSignature(after) && registered.enabled !== false) {
            currentDefinitions.set(name, after);
            continue;
          }

          const previous = before;
          currentDefinitions.set(name, after);
          try {
            registered.update(toolUpdate(after, fromJsonSchema));
          } catch (error) {
            if (previous) currentDefinitions.set(name, previous);
            else currentDefinitions.delete(name);
            throw error;
          }
        }

        definitions = nextDefinitions;
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      } finally {
        capabilityPollRunning = false;
      }
    }, pollIntervalMs());
    capabilityTimer.unref?.();

    return server;
  }, {
    legacy:'serve',
    onerror(error) { onError(error instanceof Error ? error : new Error(String(error))); },
  });

  return {
    get definitions() { return definitions; },
    async notification(notification) {
      if (!activeServer) return;
      await activeServer.server.notification(notification);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (capabilityTimer) clearInterval(capabilityTimer);
      capabilityTimer = null;
      await serverHandle.close();
      activeServer = null;
    },
  };
}
