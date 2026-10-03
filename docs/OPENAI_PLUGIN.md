# ChatGPT & Codex plugin — OpenAI

## User install path

Normal users should **not** configure the MCP endpoint or edit plugin files.

1. Open <https://chatgpt.com/plugins>.
2. Search for **ReMCP**.
3. Open the ReMCP card and choose the add/install action.
4. Complete ReMCP OAuth when prompted.
5. Start a new chat and ask ChatGPT or Codex to use ReMCP on a paired computer.

In Codex CLI, run `/plugins`, search **ReMCP**, and install it from the same shared directory.

OpenAI direct plugin detail URLs contain a platform-generated opaque connector identifier, so the
final ReMCP direct URL must be copied from the published directory card rather than guessed from the
plugin name.

The rest of this document is for **developers and reviewers**.

ReMCP ships a production OpenAI Plugins package for ChatGPT and Codex. It combines the hosted remote
MCP server with five shared operational skills, review metadata, and three self-contained MCP Apps: a file editor/diff with syntax highlighting and in-chat save, a fullscreen image viewer layered on native MCP image/screenshot content, and a compact terminal-output viewer. Source tools remain data-first and own the corresponding app resource directly, so the same tool result hydrates UI; app-only render helpers exist only for late-mount recovery.

This is the **OpenAI-specific** package. Claude Code packaging lives beside it and does not replace,
rename, or regenerate the files described here.

## At a glance

| | Value |
| --- | --- |
| Production MCP | `https://remcp.site/mcp` |
| Manifest | `plugin.json` |
| MCP configuration | `mcp.json` |
| Repository skills | 5 total; 4 published to OpenAI |
| Hosted tool surface | 15 advertised definitions with custom widgets enabled, of which 10 are model-visible; native-only mode exposes those same 10 model-facing definitions; 83 granular runtime operations remain available through grouped façade tools |
| Optional rich UI | Three dormant self-contained MCP Apps implement file editor/diff, image viewing, and terminal output. Production currently runs native-only with custom widgets disabled; if a future reviewed release enables them, file/image/terminal source tools carry their MCP Apps resource directly and app-only recovery helpers consume bounded preview references without rerunning source actions |
| Authentication | OAuth authorization code + PKCE, OIDC/UserInfo metadata |
| Public overview | [`docs/PLUGINS.md`](PLUGINS.md) |
| Full tool reference | [`docs/TOOLS.md`](TOOLS.md) — current 10-tool production surface, optional 15-tool widget-enabled surface, and the operation lists that cover all 83 runtime capabilities |

## Package layout

- `plugin.json` — portable Agent Plugins manifest.
- `mcp.json` — production Streamable HTTP MCP endpoint.
- `skills/` — the repository keeps five cross-client skills, but the OpenAI MCP skills extension publishes four reviewed skills (`skills/list`, `skills/get`, `resources/read` with SHA-256 digests): the operator guide, code change and verification, safe destructive operations, and transfers between machines. `run-and-watch-processes` remains available to non-OpenAI distributions only because the OpenAI skill scanner classifies arbitrary process-execution guidance as security-sensitive.
- `assets/remcp-icon.png` — canonical square icon used directly for both the ChatGPT plugin logo and composer icon and for the browser/PWA icon pack; the public GitHub README uses the dedicated reviewed `assets/remcp-readme-logo.png` mark.
- `chatgpt-app-submission.json` — generated tool annotations and 5 positive / 3 negative review cases.
- `submission/plugin-form.md` — copy-ready portal values.

## Production endpoints

- Website: `https://remcp.site`
- MCP: `https://remcp.site/mcp`
- OAuth metadata: `https://remcp.site/.well-known/oauth-authorization-server`
- Protected resource metadata: `https://remcp.site/.well-known/oauth-protected-resource/mcp`
- UserInfo: `https://remcp.site/oauth/userinfo`
- Privacy: `https://remcp.site/privacy`
- Terms: `https://remcp.site/terms`
- Support: `https://remcp.site/support`

## Before opening the portal

1. Confirm the publishing OpenAI organization has **Apps Management: Write** and that the project uses **global data residency**; projects with EU data residency cannot submit MCP plugins for review.
2. Complete individual or business verification for the identity shown in the listing.
3. Create a dedicated Firebase Email/Password reviewer identity and mark its email verified. The reviewer signs in at `https://demo.remcp.site/`, or directly in the Email/Password form on the canonical `https://remcp.site/authorize` OAuth screen; no MFA, OTP, magic link, email code, social-provider challenge, or private-network access is required. Do not commit its credentials; enter them only in the OpenAI submission portal.
4. Sign in once with that reviewer identity so the isolated `review-sandbox` fixture is available.
5. Verify OAuth metadata advertises `openid`, `email`, `remcp:control`, `offline_access`, and a `userinfo_endpoint`.
6. Confirm the reviewer account has a verified email so UserInfo can return `email_verified: true`.
7. Put the portal token at `https://remcp.site/.well-known/openai-apps-challenge` and verify it byte-for-byte.
8. In the portal choose **With MCP → Universal**, enter `https://remcp.site/mcp`, configure OAuth, then **Scan Tools**.
9. Let **Scan Tools** import the four OpenAI-published skills from the MCP skills extension. Confirm `run-and-watch-processes` is absent. If the portal explicitly asks for a bundle instead, upload `submission/remcp-plugin.zip`, which carries the same four-skill allowlist.
10. Enter the three starter prompts and the 5 positive / 3 negative test cases from `chatgpt-app-submission.json`.
11. Screenshots are currently omitted because this submission is native-only and does not advertise custom MCP Apps. Keep them omitted for 0.2.143. If a future reviewed release explicitly enables the three custom widgets, capture fresh ChatGPT screenshots from that deployed widget-enabled version using only synthetic `review-sandbox` data.
12. Select only regions where the hosted service, support, privacy policy, and terms are ready.
13. Review the final policy attestations manually and submit for review.

ReMCP keeps three self-contained MCP Apps implementations for file preview/editor, image viewing, and terminal output, but production currently pins `REMCP_CUSTOM_WIDGETS_ENABLED=false`. The hosted endpoint therefore exposes native MCP text/structured/image results only: no app-only helpers, no `ui://` preview resources, and no `structuredContent.preview` references. The dormant apps use no external assets or network fetches and can be reviewed separately before a future explicit re-enable.

## Review-sensitive behavior

ReMCP exposes powerful local computer operations. Tool metadata must remain literal and accurate. Hosted `run_terminal` is conservatively `openWorldHint: true` because operations such as `start_process` and `interact_with_process` can reach the public internet; `read_file` remains local and read-only. Grouped mutating/terminating façades must retain conservative destructive hints.

The bundled skill tells the model not to request or process passwords, MFA codes, private keys, payment-card data, protected health information, or government identifiers. Reviewers should use only the seeded review sandbox and non-sensitive fixture data.
