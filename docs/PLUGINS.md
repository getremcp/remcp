# ReMCP plugins

ReMCP is designed to be installed from the plugin catalog of the AI host you already use.

For normal users, the flow is:

1. Find **ReMCP** in the host's plugin browser.
2. Install it.
3. Sign in to ReMCP when the host asks you to connect.
4. Use the computers already paired to your ReMCP account.

You do **not** need to paste an MCP server URL, edit a manifest, clone the repository, or configure a local path just to use the catalog plugin.

Shareable install guides:

- All integrations and current status: <https://remcp.site/plugins>
- [Complete tool reference](TOOLS.md): current production exposes 10 model-visible hosted definitions (8 device-facing façade tools + 2 account/fleet) covering all 83 granular runtime operations; explicitly re-enabling widgets adds 5 app-only UI helpers for 15 total definitions.
- ChatGPT & Codex: <https://remcp.site/install/chatgpt>
- Claude Code: <https://remcp.site/install/claude>
- Cursor Marketplace: <https://cursor.com/marketplace>

The ReMCP-owned URLs are stable user-facing guides. They can later point to a more specific catalog card without changing the link you already shared.

## ChatGPT & Codex

ChatGPT and Codex share OpenAI's unified public plugin directory.

### ChatGPT

Open <https://chatgpt.com/plugins>, search for **ReMCP**, and open the ReMCP plugin card when it is available for your account.

Then:

1. Choose **Install plugin**.
2. Choose **Connect** if ReMCP authorization is requested.
3. Complete ReMCP OAuth.
4. Start a new chat and use **@ReMCP** or **+ → More** when those controls are available.

If ReMCP is not visible yet, the listing or rollout is not available to that account. Do not paste an
MCP endpoint or create a manual connection as a substitute for the catalog plugin.

### Codex

In a supported Codex task view:

1. Open **Sources**.
2. Choose **Use plugins**.
3. Search for and select the installed **ReMCP** plugin.

ChatGPT and Codex use the same public plugin directory, so there is no separate ReMCP package or MCP
endpoint for users to configure.

## Claude Code

ReMCP was submitted to Anthropic on **September 18, 2026** and currently shows **Submitted and
pending review**.

After approval, the preferred user flow is:

1. Open <https://claude.com/plugins>.
2. Filter for **Claude Code** if needed.
3. Search for **ReMCP**.
4. Choose **Install**.
5. Complete ReMCP authentication when Claude Code asks you to connect.

Users do not clone the ReMCP repository or edit MCP configuration files.

In Claude Desktop, the same catalog can also be reached from **+ → Plugins → Add plugin**.

While the ReMCP listing is still under review, ordinary users do not need to add a marketplace,
clone the repository, or paste an MCP endpoint. Developer and reviewer installation methods are kept
in the technical Claude Code guide instead of the normal user flow.

## Cursor

ReMCP is published in the Cursor Marketplace. The normal install flow is:

1. Open <https://cursor.com/marketplace> or Cursor's **Customize** view.
2. Search for **ReMCP**.
3. Install the plugin.
4. Authorize your ReMCP account when prompted.
5. Ask Cursor Agent to use one of your paired computers.

The Cursor package uses the portable Agent Plugins 1.0 format, so the MCP server and ReMCP skills are carried by the plugin. Users do not copy an MCP URL or edit `mcp.json` for the marketplace install.

## Gemini CLI

ReMCP ships a native `gemini-extension.json` in the public repository and the repository carries the
`gemini-cli-extension` topic used by Gemini CLI gallery discovery.

Users can install directly from GitHub today:

```bash
gemini extensions install https://github.com/antonbaider/remcp
```

Gemini CLI copies the extension locally. ReMCP's remote MCP entry uses OAuth discovery, so there is
no static ReMCP token to paste into the extension.

## GitHub Copilot CLI and VS Code

ReMCP uses the same portable Agent Plugins 1.0 package for GitHub Copilot CLI and VS Code. The public
external-plugin submission is tracked at:

<https://github.com/github/awesome-copilot/issues/3326>

After the Awesome Copilot review is accepted:

- **Copilot CLI:** browse the `awesome-copilot` marketplace and install **ReMCP** from the plugin catalog.
- **VS Code:** open Extensions and search `@agentPlugins`, or run **Chat: Plugins** from the Command Palette, then install **ReMCP**.

Until the external listing is accepted, the submission page is the source of truth for review status.

## Kiro Powers

ReMCP was submitted to the curated Kiro Powers registry on **September 19, 2026** and is pending
review. Kiro uses the same Agent Plugins 1.0 package that ReMCP already publishes, so there is no
separate Kiro-only MCP wrapper to maintain.

Users can install ReMCP from GitHub before registry approval:

1. Open the **Powers** panel in Kiro.
2. Choose **Add Custom Power**.
3. Choose **Import power from GitHub**.
4. Enter `https://github.com/antonbaider/remcp`.
5. Install the power, complete ReMCP OAuth when prompted, and use a paired computer.

After registry approval, users can discover ReMCP directly in <https://kiro.dev/powers/>.

## Cline

ReMCP has been submitted to Cline's current MCP Marketplace source of truth:

<https://github.com/cline/marketplace/pull/125>

The open marketplace PR includes the hosted Streamable HTTP server, OAuth install metadata, and marketplace
artwork. The direct CLI path was also smoke-tested during submission:

```bash
cline mcp install remcp --transport http https://remcp.site/mcp --yes --json
```

After marketplace approval, users can find **ReMCP** in Cline's MCP Marketplace instead of entering
the endpoint manually.

## Smithery, Glama, Awesome Remote MCP Servers, and the Official MCP Registry

ReMCP is also published or indexed in the main MCP discovery layers:

- **Smithery:** <https://smithery.ai/servers/antonbaider/remcp>
- **Glama:** <https://glama.ai/mcp/connectors/site.remcp/re-mcp>
- **Awesome Remote MCP Servers:** ReMCP is listed under Developer Tools after [PR #435](https://github.com/punkpeye/awesome-remote-mcp-servers/pull/435) was merged; the directory points to `https://remcp.site/mcp`.
- **Official MCP Registry:** published as `io.github.getremcp/remcp`; GitHub resolves the project release URL `antonbaider/remcp` to the transferred repository owned by `getremcp`, so the Registry namespace remains valid while project-facing links use `antonbaider/remcp`. The former `io.github.antonbaider/remcp` Registry identity is legacy only.

These are discovery/catalog surfaces rather than separate ReMCP accounts. They point users back to
the same production service, OAuth boundary, and paired computers.

See [DISTRIBUTION.md](DISTRIBUTION.md) for marketplace manifests, validation, and submission status.

## What the plugin carries for you

Both host packages already contain the information needed to connect to ReMCP. The end-user install
experience should therefore be described as:

**Install from catalog → sign in to ReMCP → use paired computers.**

The following details are implementation internals, not user setup steps:

- MCP server endpoint;
- host-specific manifest files;
- OAuth metadata URLs;
- review/submission JSON;
- local development commands such as `--plugin-dir`.

## Developer and reviewer documentation

Technical details are intentionally separated from the user install flow:

- [OPENAI_PLUGIN.md](OPENAI_PLUGIN.md) — OpenAI packaging, MCP configuration, reviewer workflow, and submission artifacts.
- [CLAUDE_CODE_PLUGIN.md](CLAUDE_CODE_PLUGIN.md) — Claude Code manifest, validation, local development, and Anthropic submission details.

The two integrations still share the same ReMCP backend, OAuth account boundary, five operational
skills, and paired-device trust model, while keeping host-specific packaging separate.
