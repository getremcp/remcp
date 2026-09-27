# ReMCP distribution

ReMCP keeps one public source repository and publishes host-native discovery metadata for each supported ecosystem.

## User-facing distribution

| Host / catalog | Discovery / install path | Status |
| --- | --- | --- |
| ChatGPT & Codex | OpenAI plugin directory | submitted / platform-controlled rollout |
| Claude Code | Claude Plugins directory | submitted, pending review |
| Cursor | Cursor Marketplace | published |
| Gemini CLI | Gemini CLI Extension Gallery + direct GitHub install | gallery discovery enabled; native extension validated |
| GitHub Copilot CLI | Awesome Copilot default marketplace | external submission under review |
| VS Code Agent Plugins | Awesome Copilot / `@agentPlugins` | same external submission and Agent Plugins 1.0 package |
| Kiro Powers | Kiro Powers registry + direct GitHub import | submitted September 19, 2026; pending review |
| Cline | Cline MCP Marketplace ([PR #125](https://github.com/cline/marketplace/pull/125)) | submitted in current `cline/marketplace`; pending review |
| Smithery | smithery.ai/servers/antonbaider/remcp | published |
| Glama | glama.ai/mcp/connectors/site.remcp/re-mcp | verified / healthy |
| Awesome Remote MCP Servers | [punkpeye/awesome-remote-mcp-servers](https://github.com/punkpeye/awesome-remote-mcp-servers) ([PR #435](https://github.com/punkpeye/awesome-remote-mcp-servers/pull/435)) | listed; PR #435 merged |
| Official MCP Registry | registry.modelcontextprotocol.io | published remote Streamable HTTP server |

For ordinary users, the product flow is always:

**Find ReMCP in the host → Install → sign in to ReMCP → use paired computers.**

The production MCP URL and host-specific manifests are implementation details, not normal installation steps.

Every host reaches the same capability-aware ReMCP contract. Current hosted `remcp.site` discovery exposes 10 model-visible tools (8 device façade + 2 account/fleet) that route to 83 granular runtime operations; cached clients can still call 100 unique compatibility names including legacy granular aliases. If custom widgets are explicitly re-enabled, discovery expands to 15 definitions by adding 5 app-only helpers and the compatibility surface becomes 105 names. The selected computer is checked against its live runtime capabilities immediately before dispatch. Local runtimes remain dynamic and emit `tools/list_changed` when their own available set changes. See the [generated tool contract](TOOLS.md) for façade schemas, operation lists, and safety hints.

## Portable core

The root `plugin.json` is the canonical Agent Plugins 1.0 manifest and the root `mcp.json` contains the portable remote MCP definition. OpenAI/Codex workspace imports can discover this same root package through `.agents/plugins/marketplace.json`; the Claude-compatible `.claude-plugin/marketplace.json` remains alongside it for hosts that read that format. Cursor, GitHub Copilot, VS Code, and Kiro can consume the portable package directly.

Gemini CLI requires `gemini-extension.json`. The extension uses `httpUrl` for the remote Streamable HTTP MCP endpoint with OAuth dynamic discovery, so users do not paste tokens or endpoint URLs. For gallery discovery, the public GitHub repository must also carry the `gemini-cli-extension` topic.

The Official MCP Registry keeps the GitHub-authenticated identity `io.github.getremcp/remcp` because GitHub resolves the project release URL `https://github.com/antonbaider/remcp` to the transferred canonical repository owned by `getremcp`. Project-facing source and release links use `antonbaider/remcp`; the former Registry identity `io.github.antonbaider/remcp` remains inactive. Release preflight still checks that legacy Registry identity and fails closed if it ever reappears for the same production remote. Manual `workflow_dispatch` runs remain validation-only and never publish Registry metadata.

OpenAI/Codex local or workspace marketplace discovery uses `.agents/plugins/marketplace.json` with a structured local source pointing at the repository root. Claude-compatible hosts can use `.claude-plugin/marketplace.json`. GitHub Copilot CLI and VS Code can also register this repository through `.github/plugin/marketplace.json` while the Awesome Copilot listing is under review.

## Validation

Run the repository-owned cross-distribution check:

```bash
npm run distribution:check
```

Then run the host-native validators when preparing a distribution change:

```bash
npx --yes @google/gemini-cli@latest extensions validate .
mcp-publisher validate server.json
```

Cursor, Copilot, VS Code, and Kiro use the root Agent Plugins 1.0 package, which is covered by `npm run plugin:check` and the public marketplace review pipelines.

## Release rule

All distribution manifests carry the same ReMCP version and production MCP endpoint. `npm run release:prepare` synchronizes their version fields. A release must not update one host while leaving another manifest stale.
