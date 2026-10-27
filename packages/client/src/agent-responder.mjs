import os from 'node:os';
import { VERSION } from './version.mjs';
import { runAgentNetworkProbe } from './agent-network-probe-client.mjs';
import { sendRelayMessage } from './agent-utilities.mjs';

export function createAgentResponder({ inFlight, onPendingChange, getRuntimeState, serverUrl, deviceToken }) {
  async function respond(ws, message) {
    onPendingChange(1);
    // The relay forwards a cancel when the MCP client goes away. Without it a cancelled tool call
    // kept running on the machine (a delete still deleted), because nothing told the runtime.
    const controller = new AbortController();
    inFlight.set(message.id, controller);
    const { mcp, runtimeDown, runtimeVersion, runtimeRestarts, callTimeoutMs } = getRuntimeState();
    try {
      let result;
      if (message.method === 'ping') {
        result = { ok: true, hostname: os.hostname(), platform: process.platform, arch: process.arch, uptimeSeconds: Math.floor(os.uptime()), agentVersion: VERSION, runtimeVersion, runtimeRestarts };
      } else if (message.method === 'network_probe') {
        result = await runAgentNetworkProbe({serverUrl,deviceToken,signal:controller.signal});
      } else if (!runtimeDown && mcp) {
        const options = { timeout: callTimeoutMs, signal: controller.signal };
        if (message.method === 'tools/list') result = await mcp.listTools(undefined, options);
        else if (message.method === 'tools/call') result = await mcp.callTool(message.params, undefined, options);
        else throw new Error(`Unsupported relay method: ${message.method}`);
      } else {
        throw new Error('The ReMCP local runtime is restarting. Retry in a few seconds.');
      }
      sendRelayMessage(ws, { type: 'response', id: message.id, result });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      sendRelayMessage(ws, { type: 'response', id: message.id, error: { message: cancelled ? 'Cancelled: the client stopped waiting for this call.' : error instanceof Error ? error.message : String(error) } });
    } finally {
      inFlight.delete(message.id);
      onPendingChange(-1);
    }
  }
  return respond;
}
