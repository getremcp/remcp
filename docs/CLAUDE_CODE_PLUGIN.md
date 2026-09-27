# Claude Code plugin — Anthropic

## User install path

ReMCP is currently **Submitted and pending review** in Anthropic's plugin directory.

After approval, the preferred user flow is:

1. Open <https://claude.com/plugins> or, in Claude Desktop, use **+ → Plugins → Add plugin**.
2. Filter for **Claude Code** if needed.
3. Search for **ReMCP**.
4. Choose **Install**.
5. Complete ReMCP authorization if Claude asks you to connect.
6. Ask Claude Code to use ReMCP on a computer already paired to your account.

That is the complete normal-user setup. The plugin already carries the server connection and skills.
Users do not need a repository clone, a local path, or manual MCP configuration.

While the public listing is still under review, ordinary users should wait for the directory entry
rather than copy developer setup commands from this document.

The rest of this document is for **developers and reviewers**.

ReMCP ships a native Claude Code plugin alongside the separate OpenAI Plugins package. The two
integrations share the same public skills, production MCP endpoint, OAuth service, and paired-device
model, but use different manifests and validation paths so a change for one ecosystem cannot silently
break the other.

> **Directory status — September 18, 2026:** submitted through Claude Platform and accepted by the
> submission API. Anthropic Console currently shows **Submitted and pending review**. This document
> does not claim community-marketplace availability until Anthropic marks the listing approved.

See [`PLUGINS.md`](PLUGINS.md) for the side-by-side OpenAI / Anthropic overview.
See [`TOOLS.md`](TOOLS.md) for the current 10-tool hosted production contract, the optional 15-tool widget-enabled surface, and the complete 83-operation device runtime surface behind the grouped façade tools.

## OpenAI migration path for this Claude-compatible package

OpenAI does not import the Claude marketplace listing or its MCP configuration as the remote-server submission. For OpenAI, ReMCP is submitted as a **remote MCP plugin** using the stable public Streamable HTTP endpoint `https://remcp.site/mcp`; the same five skills are included/imported in that OpenAI draft. The Claude manifests remain useful for Claude Code and as a compatible source package, but Claude marketplace approval does not transfer to OpenAI.

## Files

- `.claude-plugin/plugin.json` — Claude Code plugin metadata.
- `.mcp.json` — Claude Code remote HTTP MCP configuration.
- `skills/*/SKILL.md` — shared ReMCP skills loaded by Claude Code from the plugin root.
- `plugin.json`, `mcp.json`, `chatgpt-app-submission.json` — existing OpenAI/Agent Plugins artifacts; these remain separate and unchanged by the Claude manifest.

The Claude MCP entry uses the recommended remote HTTP transport:

```json
{
  "mcpServers": {
    "remcp": {
      "type": "http",
      "url": "https://remcp.site/mcp"
    }
  }
}
```

Authentication is discovered from the ReMCP MCP endpoint. ReMCP exposes OAuth protected-resource / authorization-server metadata and uses authorization code + PKCE. Do not put access tokens, client secrets, Firebase credentials, or test credentials in the plugin repository.

## Validate

Run the repository-owned compatibility check first:

```bash
npm run claude:check
```

Then validate with the current Claude Code CLI before every Anthropic submission:

```bash
claude plugin validate . --strict
```

For a one-off check without changing the globally installed Claude Code version:

```bash
npx --yes @anthropic-ai/claude-code@latest plugin validate . --strict
```

A successful review candidate must print `Validation passed` (with no warnings when `--strict` is used).

## Local smoke test

From the public ReMCP repository:

```bash
claude --plugin-dir .
```

Then verify that the five ReMCP skills appear under the `remcp:` namespace and that the `remcp` MCP server is listed. Complete the OAuth browser flow when prompted and run a read-only check first, for example listing paired computers.

## Submission status

The public repository was submitted through Claude Platform on **September 18, 2026**:

```text
https://github.com/antonbaider/remcp
```

Anthropic accepted the submission and currently reports **Submitted and pending review**. The plugin
root is the repository root. The candidate passed both the repository-owned contract check and
`claude plugin validate . --strict` before submission.

Until Anthropic marks the directory entry approved, the public install guide should continue to show
the listing as pending. The local `--plugin-dir` flow is for development and smoke testing only.

When the directory listing is live, update the public install guide to link to the published ReMCP
card and keep all developer-only commands in this technical document.

## Release safety

The private `remcp-full` repository remains the source of truth. `scripts/build-public-repo.mjs` exports the Claude files to the public repository in addition to the existing OpenAI artifacts. The exporter does not rename or replace the OpenAI manifests.

Before publishing:

```bash
npm run claude:check
npm run release:check
npm run public:check -- --target /path/to/public/remcp
npm test
```

Do not merge a Claude packaging change when any existing OpenAI release check regresses.
