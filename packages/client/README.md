# Device client

`@remcp/remcp` is the ReMCP device client. It pairs a computer with ReMCP, installs the first-party
local runtime, and runs the outbound-only agent that serves your MCP client's tool calls.

```bash
npm install --global @remcp/remcp@latest
remcp --version
remcp status
```

Pairing commands are generated in the workspace at <https://remcp.site/app/connect>. On Windows,
the browser shows a PowerShell bootstrap that needs no preinstalled system Node.js/npm/npx/winget;
it keeps the ReMCP runtime under `%LOCALAPPDATA%\ReMCP`. Generated one-time commands ultimately run
`remcp connect --server … --code … --install`, which stores a per-device credential, installs the
runtime, and registers a user service (systemd on Linux, LaunchAgent on macOS, Scheduled Task on
Windows).

## Commands

```text
remcp start                  Run the device agent when no managed background service is already running
remcp status                 Show device/agent versions, update consistency and server reachability as JSON
remcp doctor                 Same report plus a real tool handshake with the local runtime, and which
                             macOS privacy folders (Desktop, Documents, Downloads, iCloud Drive) this
                             computer currently lets ReMCP use
remcp update                 Update the client and runtime, then restart the user service
remcp install                Install or repair the user service
remcp uninstall              Remove the user service
remcp uninstall --purge      Remove the service and the global packages
remcp telemetry [status|on|off]
remcp godmode [status|on|off]
remcp --version
```

`remcp status` reports the configured/installed runtime, the managed-agent state, whether multiple local ReMCP installations are consistent, whether an update is required, server reachability, and the current usage-metrics state. It deliberately does not expose backend database/provider, relay topology, fleet size, or other operational internals. `remcp doctor` adds local runtime/filesystem diagnostics, so a support request can still be answered with one paste.

## Unrestricted mode

`remcp godmode on` removes the runtime's own safety rails on **this** computer: file access is no
longer confined to the allowed roots, the configured command blocklist is ignored, and the
catastrophic-command guardrail is set to allow. `remcp godmode off` puts them back; `remcp godmode
status` says which state you are in and where it comes from.

Two things it deliberately does not do:

- **It is not reachable from a model.** `set_config_value` lists the settings a model may change and
  this is not one of them; only a person at the computer (this command, `REMCP_RUNTIME_UNRESTRICTED=1`,
  or `unrestricted: true` in `~/.config/remcp/runtime.json`) can turn it on. That is what keeps a
  prompt injection from becoming root.
- **It does not make the agent root.** Commands run as the user the agent runs as. `sudo` is no longer
  blocked, but the operating system still asks for a password unless your sudoers rules say otherwise;
  a non-interactive command cannot type one. Nothing in this mode grants root by itself.

While it is on, `get_runtime_info` reports `policy.unrestricted: true`, so the model can see it and
say so instead of assuming the guardrails are still there.

## macOS folder permissions

macOS protects Desktop, Documents, Downloads and iCloud Drive. Until it is granted access, ReMCP
answers those writes with the errno the kernel returns:
`EACCES: permission denied, mkdir '/Users/you/Desktop/…'` — on a Mac this is not a ReMCP setting and
not an access-root problem. The tools cannot prompt for it either, because the agent runs as a
background service: open **System Settings → Privacy & Security → Full Disk Access**, add the `node`
binary that `remcp doctor` prints, and run `remcp start`. Folders outside those four need no new
permission, and `remcp doctor` reports the state of each one.

## Updates

The agent asks the server which versions it should run on every successful connection and every six hours, installs the exact trusted client/runtime release pair in the background, and restarts the managed service so it takes effect. The updater resolves itself and the sibling runtime from the package that is actually running instead of depending on an interactive shell PATH. When the same computer has been used from more than one Node manager (for example NVM plus Hermes/FNM/Homebrew), ReMCP keeps the canonical service installation stable and converges the known local installations on the same release pair. `remcp status` reports mixed installations instead of hiding the skew. A failed install is retried no more often than every thirty minutes and update-check failures are logged, so a broken release cannot become a silent install loop. `remcp update` does the same immediately; `remcp auto-update off` disables automatic checks.

## Computer-use routing

When an AI host controls a visible application, ReMCP is designed for semantic targeting rather than screenshot-coordinate loops:

`Accessibility/UI Automation → browser DOM/CDP → OCR → coordinates`

Use `computer_snapshot` for an unfamiliar state, native `ui_*` tools for desktop applications, and `browser_*` tools for debuggable Chromium page content. `browser_navigate action=new_tab` can create the first page target when the debug browser has none. `type_text` with its default `method=auto` is for exact Unicode text in native/focused controls; use `browser_action` for Chromium page DOM text and `keyboard` for shortcuts/navigation/control keys. `type_text method=keys` emits physical keys and therefore follows the computer's active keyboard layout. Prefer `wait_for_ui` or `browser_wait` to fixed sleeps and use `screenshot_region` only when pixel/layout verification adds information. For PDF/DOCX/XLSX content, use the structured document tools before automating Office applications.

## Screenshots

`take_screenshot` returns the screen of this computer as an image, and each desktop keeps its own
gate — ReMCP names the one that refused instead of printing a generic error:

- **macOS** wants Screen Recording for the binary that runs the tools (`remcp doctor` prints its
  path), then `remcp start`.
- **Windows** needs an unlocked interactive session; a locked or signed-out machine cannot be
  captured.
- **Linux on Wayland** needs a capture backend: `grim` on wlroots desktops (sway, hyprland), and
  `gnome-screenshot` on GNOME — GNOME refuses the shell's own screenshot API to background processes
  and `grim` cannot read a GNOME session. On X11, `scrot`, ImageMagick `import` or `gnome-screenshot`
  all work.
- A machine with no graphical session (a server, a container) says so: there is nothing to capture.

A screenshot larger than the inline limit is saved on the computer, and the result says where it is
and how to fetch it in chunks.

## What runs on your computer

- the agent (`remcp start`), which holds the device credential and dials
  `wss://remcp.site/agent`;
- [`@remcp/runtime`](https://www.npmjs.com/package/@remcp/runtime), spawned by the agent as an MCP
  stdio server. The runtime executes the tools, opens no network connection, and is supervised: if it
  exits, the agent restarts it with backoff and reports the restart instead of failing silently.

Configuration lives in `~/.config/remcp/config.json` (client) and `~/.config/remcp/runtime.json`
(runtime: allowed roots, blocked commands, output and write limits, and the usage-metrics switch).
Run `npx @remcp/runtime --describe` to print the runtime's effective configuration.

## Usage metrics

Opt-out, self-hosted, and limited to tool names, timings, outcomes, error classes, and device health
samples. No paths, no commands, no arguments, no output, no third-party endpoint, no install ping.
Disable with `remcp telemetry off` or `REMCP_RUNTIME_DISABLE_TELEMETRY=1`; the switch applies to both
the client and the runtime, and restarts the service so it takes effect immediately.

## Security

- Outbound-only connection; the machine never listens.
- One revocable credential per paired device, stored with restrictive permissions.
- Runtime metadata from a custom server is only accepted with an explicit `--trust-runtime`.
- Revoking a device in the workspace closes the connection; the agent then stops retrying and says so
  instead of reconnecting forever.

## Development

```bash
npm install
npm run check
npm test
```

## License

MIT.
