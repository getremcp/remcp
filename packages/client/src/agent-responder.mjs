import os from 'node:os';
import {callAgentRuntimeTool} from './agent-media-ice.mjs';
import { VERSION } from './version.mjs';
import { runAgentNetworkProbe } from './agent-network-probe-client.mjs';
import { sendRelayMessage } from './agent-utilities.mjs';

export function createAgentResponder({ inFlight, onPendingChange, getRuntimeState, serverUrl, deviceToken,
  assertResponseAllowed = () => {}, assertRequestAllowed = () => {}, e2eeEndpoint = null,
}) {
  async function respond(ws, message) {
    onPendingChange(1);
    // The relay forwards a cancel when the MCP client goes away. Without it a cancelled tool call
    // kept running on the machine (a delete still deleted), because nothing told the runtime.
    const controller = new AbortController();
    inFlight.set(message.id, controller);
    const reply = payload => {
      try { assertResponseAllowed(message); }
      catch {
        // Policy can tighten while a tool awaits I/O. Do not transmit even
        // an error over the old TLS-only session after local revocation.
        controller.abort();
        ws.terminate();
        return;
      }
      sendRelayMessage(ws, { type: 'response', id: message.id, ...payload });
    };
    const { mcp, runtimeDown, runtimeVersion, runtimeRestarts, callTimeoutMs } = getRuntimeState();
    try {
      assertRequestAllowed(message);
      let result;
      if (message.method === 'e2ee/identity' && e2eeEndpoint) {
        result = e2eeEndpoint.identity();
      } else if (message.method === 'e2ee/packet' && e2eeEndpoint) {
        try { result = await e2eeEndpoint.handle(message.params?.packet, { signal:controller.signal }); }
        catch { throw new Error('e2ee_request_rejected'); }
      } else if (message.method === 'ping') {
        result = { ok: true, hostname: os.hostname(), platform: process.platform, arch: process.arch, uptimeSeconds: Math.floor(os.uptime()), agentVersion: VERSION, runtimeVersion, runtimeRestarts };
      } else if (message.method === 'network_probe') {
        result = await runAgentNetworkProbe({serverUrl,deviceToken,signal:controller.signal});
      } else if (!runtimeDown && mcp) {
        const options = { timeout: callTimeoutMs, signal: controller.signal };
        if (message.method === 'tools/list') result = await mcp.listTools(undefined, options);
        else if (message.method === 'tools/call') result = await callAgentRuntimeTool({mcp,params:message.params,options,serverUrl,deviceToken});
        else throw new Error(`Unsupported relay method: ${message.method}`);
      } else {
        throw new Error('The ReMCP local runtime is restarting. Retry in a few seconds.');
      }
      reply({ result });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      reply({ error: { message: cancelled ? 'Cancelled: the client stopped waiting for this call.' : error instanceof Error ? error.message : String(error) } });
    } finally {
      inFlight.delete(message.id);
      onPendingChange(-1);
    }
  }
  return respond;
}
