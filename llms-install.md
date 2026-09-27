# ReMCP installation for MCP hosts

ReMCP is a hosted remote MCP server. Do not clone or launch a local MCP server process.

## MCP endpoint

Use a Streamable HTTP transport:

```json
{
  "mcpServers": {
    "remcp": {
      "type": "streamableHttp",
      "url": "https://remcp.site/mcp"
    }
  }
}
```

For hosts that spell the transport as `streamable-http`, use that host's documented spelling with the same URL.

## Authentication

ReMCP uses MCP OAuth discovery. When the host reports that authorization is required, complete the browser authorization flow and return to the host. Do not create or paste a static ReMCP API token into the MCP configuration.

## Pair a computer

After signing in, open the ReMCP workspace and use **Connect computer**. Run the generated pairing command on the computer you want the agent to access. The device makes an outbound connection to ReMCP; no inbound port is required.

## Verify

After authorization and pairing:

1. Call `list_devices`.
2. Select the returned device id.
3. Call `device_action` with that exact id and `action: ping`.
4. Use file or terminal tools only on the computer the user explicitly selected.

If no computer is paired yet, `list_devices` returns the current connection instructions.


## Host-specific install paths

Use a catalog entry when the host already lists ReMCP. When a host supports direct remote-MCP
configuration, these are the supported shortcuts.

### Gemini CLI

ReMCP ships a native Gemini CLI extension manifest:

```bash
gemini extensions install https://github.com/antonbaider/remcp
```

Restart the Gemini CLI session after installation, complete OAuth when prompted, then verify with
`list_devices`.

### Kiro Powers

ReMCP uses the Agent Plugins 1.0 format supported by Kiro. Until the curated registry review is
complete, install directly from the public repository:

1. Open **Powers → Add Custom Power**.
2. Choose **Import power from GitHub**.
3. Enter `https://github.com/antonbaider/remcp`.
4. Install, complete ReMCP authorization, then verify with `list_devices`.

The curated Kiro Powers submission was received on September 19, 2026.

### Cline

ReMCP's hosted endpoint can be registered directly with Cline:

```bash
cline mcp install remcp --transport http https://remcp.site/mcp --yes
```

Complete the browser authorization flow when Cline requests it. ReMCP's current Cline Marketplace
submission is tracked in the marketplace source of truth at <https://github.com/cline/marketplace/pull/125>.

### Discovery directories

The same production remote is published or indexed at:

- Smithery: <https://smithery.ai/servers/antonbaider/remcp>
- Glama: <https://glama.ai/mcp/connectors/site.remcp/re-mcp>
- Official MCP Registry: `io.github.getremcp/remcp` (active Registry identity; GitHub resolves the project release URL `antonbaider/remcp` to the transferred `getremcp` repository).

These directories do not create a second ReMCP account or a separate device fleet.
