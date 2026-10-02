# ReMCP local runtime

`@remcp/runtime` is the local device runtime for [ReMCP](https://remcp.site). It is an MCP
server that runs on a computer you paired with ReMCP and executes file, image, search, terminal,
process, desktop UI, browser, diagnostics, and document tools exposed through the hosted ReMCP MCP endpoint.

The ReMCP device agent starts this runtime as a child process and talks to it over stdio. The runtime
has no independent cloud service or telemetry endpoint: browser automation connects only to a loopback
Chrome DevTools endpoint, while the explicit `network` diagnostic and commands you run can reach the
network when requested. The device credential remains in the paired agent and can be revoked at any time.

## Install

The runtime is installed automatically by the ReMCP device client:

```bash
npm install -g @remcp/remcp
remcp install
```

To run it directly:

```bash
npx @remcp/runtime --describe   # version, limits, configuration, telemetry state
npx @remcp/runtime --print-tools
npx @remcp/runtime              # granular capability-aware MCP server over stdio
node ./src/compact.mjs --print-tools  # compact local façade for scanners/local MCP hosts
```

`src/compact.mjs` is a second stdio entrypoint over the **same real handlers**. It advertises `read_file` plus up to seven `verb_noun` domain tools (`manage_files`, `run_terminal`, `control_computer`, `view_image`, `control_browser`, `manage_system`, `manage_documents`) and narrows each operation enum to capabilities available on the current host. It also tracks capability changes while running: grouped schemas are refreshed and `notifications/tools/list_changed` is emitted when a domain appears, disappears, or changes membership. It exists for directory scanners and local MCP hosts that benefit from a small selection surface; the paired ReMCP agent continues to use the granular capability-aware entrypoint.

## Tools

83 tools are implemented in this repository: the original 44 filesystem/search/terminal/process tools
plus 39 computer-use, browser, diagnostics, and document tools. The release contract contains all 83;
the live local MCP `tools/list` omits optional platform-specific tools that the current computer cannot
support and emits `notifications/tools/list_changed` when that capability set changes. The stdio server is dual-era: existing 2025-era clients continue to work unchanged, while clients that negotiate MCP `2026-07-28` use `server/discover`, cache hints, unrestricted structured output validation, and `subscriptions/listen` for list-change delivery.

| Area | Tools |
| --- | --- |
| Read | `read_file`, `read_files`, `read_multiple_files`, `read_image`, `read_binary`, `list_directory`, `get_file_info`, `hash_file`, `diff_files` |
| Write / edit | `write_file`, `write_files`, `write_binary`, `apply_patch`, `set_permissions`, `edit_block`, `replace_lines`, `replace_in_files` |
| Organise | `create_directory`, `move_file`, `copy_file`, `copy_paths`, `move_paths`, `move_to_trash`, `create_archive`, `extract_archive` (Linux/macOS; tar/zip backends are validated before use) |
| Delete | `delete_path`, `delete_paths` |
| Transfer | `read_binary` / `write_binary` stream any file as base64 chunks in both directions; `create_archive` / `extract_archive` move whole trees |
| Screen | `take_screenshot` returns the desktop as an image on Linux, macOS, and Windows |
| Search | `start_search`, `get_more_search_results`, `stop_search`, `list_searches` |
| Processes | `start_process`, `read_process_output`, `wait_for_process_output`, `interact_with_process`, `force_terminate`, `list_sessions`, `list_processes`, `kill_process` |
| Runtime | `get_system_info`, `get_runtime_info`, `get_runtime_stats`, `set_config_value` |
| Computer use | `computer_snapshot`, `computer_action`, `list_windows`, `window_action`, `launch_app`, `ui_snapshot`, `ui_find`, `ui_action`, `type_text`, `keyboard`, `pointer`, `drag_drop`, `scroll`, `wait_for_ui`, `clipboard`, `display_inventory`, `screenshot_region`, `open_path`, `reveal_path`, `notification` |
| Browser | `browser_tabs`, `browser_navigate`, `browser_snapshot`, `browser_find`, `browser_action`, `browser_wait`, `browser_evaluate` |
| Diagnostics | `service`, `event_log`, `network`, `installed_apps`, `environment`, `audio`, `power_action`, `record_screen` — `audio` returns stable structured `volume`, `muted`, `action`, and `backend` fields across supported OS backends |
| Documents | `read_document`, `edit_spreadsheet`, `edit_document`, `pdf_action` |

The hosted ReMCP endpoint does not append those 83 granular operation names to its discovery list.
Current production runs with `REMCP_CUSTOM_WIDGETS_ENABLED=false` and exposes **10 hosted tool definitions**,
all model-visible: 8 device-facing façade tools plus 2 account/fleet tools. Those compact definitions route
to the same **83 granular runtime operations** after the selected computer's live capabilities are checked.
If custom widgets are explicitly re-enabled, hosted discovery expands to **15 definitions** by adding
**5 app-only** UI helpers. Cached legacy clients can still call supported granular aliases without inflating
discovery for new clients.

`computer_snapshot` and `computer_action` keep OCR inside the compact high-level surface: when a local `tesseract` binary is available, snapshot can return bounded OCR text/boxes and click targeting can fall back through Accessibility → browser DOM/CDP → OCR → coordinates. `computer_action` also exposes backend-uncertain `type`, `scroll`, and `drag` plus explicit window targeting; it prefers semantic Accessibility, can route browser selectors through CDP, and keeps native coordinate/UI gestures as the fallback. When the backend is already known, the specialist UI/browser/type/scroll/drag/window tools keep their full controls. OCR is optional and never adds another MCP tool or bundled OCR dependency.

For browser typing, `browser_text` is the visible DOM locator while `text` is the Unicode payload. `browser_action(action="scroll")` accepts page/element deltas or direction/wheel steps and scrolls the page or nearest scrollable ancestor; `scroll_into_view` remains the separate semantic reveal operation.

For frontend QA, use semantic data to operate the page and rendered pixels to verify it: `browser_action(action="set_viewport")` sets an exact responsive-test viewport, `browser_wait` waits for the real application state, and `browser_snapshot(include_screenshot=true, selector=...)` recenters the component, returns its bounds, and attaches the real CDP-rendered viewport PNG. This intentionally treats screenshots as the visual oracle without making screenshot-driven coordinate guessing the primary control path.

`set_config_value` remains deliberately narrow: it can change only `telemetryEnabled`,
`maxReadLines`, `maxBufferedLines`, and `maxOutputBytes`. Access roots, blocked commands,
the command guardrail, shell, write limit, runtime name, and unrestricted mode stay with the person
at the computer. DOCX/XLSX edits operate directly on OOXML: Windows uses the built-in .NET ZIP backend,
while macOS/Linux advertise the OOXML editor tools only when both `zip` and `unzip` are available. `read_document` stays discoverable for PDF/plain-text formats when that backend is absent and fails closed only for DOCX/XLSX reads. Structural PDF writes use existing
system tools such as qpdf/poppler when present. PDF text reading uses the built-in parser first and can fall back to local `pdftotext` for embedded-font PDFs; ReMCP still does not bundle Chromium, Puppeteer,
`sharp`, or `exceljs`.

`--print-tools` prints the exact JSON contract (schemas and annotations) the runtime advertises, and
`src/catalog.mjs` plus `src/extended/catalog.mjs` are the source of truth for the 83-tool release surface.
A running device can advertise a smaller capability-aware subset; the runtime declares
`tools.listChanged`, emits `notifications/tools/list_changed` when dynamic capabilities change, and the
agent forwards the refreshed tool names to the hosted relay. Browser/CDP tools are the primary dynamic
example: they are enabled only while the runtime can use a supported loopback browser endpoint. On Linux,
Desktop capabilities additionally require an active graphical session (`DISPLAY` or `WAYLAND_DISPLAY`):
headless hosts do not advertise window/UI/input/clipboard/display/screenshot/launch/open/reveal/notification
operations merely because desktop helper binaries happen to be installed. The universal `computer_snapshot`
remains available on those hosts but skips unavailable desktop probes instead of reporting synthetic backend
errors. On Linux, `screenshot_region` is advertised only when the current session has a real matching capture
backend (Wayland grim/GNOME/portal path or X11 ImageMagick), not merely because `ffmpeg` is installed.

The generated hosted reference covers the current **10 hosted production definitions**, all model-visible
and routing to the 83 granular runtime operations described above; the optional widget-enabled surface is 15.
The separate compact local stdio entrypoint advertises `read_file` plus up to seven domain tools
(up to 8 tools total) and keeps those groups capability-aware at runtime with `tools/list_changed`; the paired agent keeps using the capability-aware granular runtime.
See https://remcp.site/docs#tools and public `docs/TOOLS.md`.

## No approval staircase

ReMCP is a remote control for computers you own, with the same trust model as SSH: the tool call runs,
and the user's request is the authorization. ReMCP adds no per-tool approval prompt, no "are you sure",
and no dry-run detour unless you ask for one.

Operating-system security boundaries still apply. macOS can require Accessibility/Screen Recording grants,
and GNOME Wayland requires a one-time XDG RemoteDesktop consent before low-level keyboard/pointer/drag input. XTEST/xdotool drag is deliberately not treated as reliable on GNOME Wayland.
ReMCP does not bypass those controls: after GNOME grants access, the portal restore token is stored locally
under the runtime config directory with mode `0600` and reused when the portal permits it. Semantic AT-SPI
UI actions and the XDG Screenshot portal remain separate from that low-level input permission.

- file writes replace by default (`mode: "append"` to add), moves and copies replace the destination
  (`overwrite: false` refuses instead), `replace_in_files` applies immediately (`dry_run: true`
  previews), and `move_to_trash` is there when you want an undo;
- the destructive-command guardrail defaults to `block`: a catastrophic command is refused before it
  runs when it matches the list (`mkfs`, raw device writes, repartitioning, host power control, fork
  bombs, recursive root deletion). `warn` downgrades that to a note on the result, `allow` removes
  even the note, and `blockedCommands` adds your own deny list;
- `allowedRoots` is empty, so the device reaches everything the agent's account can reach. Set it to
  confine a device to specific directories, enforced against the resolved real path.

The guarantees that remain are about correctness rather than permission: a bad shell, a closed stdin,
or a 40 MB line cannot take the runtime down; a crashed runtime is restarted by the agent; terminal
sessions run in their own process group so `force_terminate` stops the whole pipeline; and a
misconfigured `runtime.json` stops the device loudly instead of silently dropping your settings.

## Usage metrics

Usage metrics are **opt-out**, matching the ReMCP client. They cover tool names, durations, outcomes,
coarse error classes, and session counts. They never include file paths, file contents, command
strings, tool arguments, or tool output - the event schema is a whitelist, so a tool cannot leak
those fields even by accident.

Transport is the point that matters: the runtime has **no telemetry endpoint**. Events are emitted as
an MCP notification (`notifications/remcp/telemetry`) to the agent that started the runtime, and the
agent forwards them over the WebSocket connection it already holds to your own ReMCP account. There
is no install ping, no postinstall script, no third-party processor, no remote feature flags, and no
A/B assignment.

Turn it off in any of these ways:

```bash
remcp telemetry off                       # the ReMCP client writes both config files
export REMCP_RUNTIME_DISABLE_TELEMETRY=1  # environment
```

```json
{ "telemetryEnabled": false }
```

in `~/.config/remcp/runtime.json`. `--describe` always reports the current state.

## Runtime properties

- **No independent cloud control plane.** Telemetry and device RPC still leave only through the paired
  agent. Browser control accepts only loopback CDP endpoints. The explicit `network` diagnostic can
  open a bounded TCP connection to a host/port, and shell/browser actions can reach the network when
  the requested operation itself requires it.
- **Remote browser safety.** A standalone production runtime keeps browser control disabled unless
  `REMCP_BROWSER_REMOTE_ENABLED=1`; the authenticated ReMCP device agent explicitly enables it for the local
  runtime it owns. Production navigation requires an explicit `REMCP_BROWSER_ALLOWED_HOSTS` allowlist of IP
  literals. Hostname navigation is refused unless `REMCP_BROWSER_ALLOW_DNS_REBIND=1` is set behind an external
  DNS/egress boundary. Local navigation requires a separate `REMCP_BROWSER_ALLOW_LOCAL_NAVIGATION=1` opt-in,
  and CDP request guards reject private, file, and WebSocket destinations.
- **Optional confinement.** `allowedRoots` is empty by default. When you set it, it is enforced
  against the resolved real path of the deepest existing ancestor rather than the lexical string, so
  `<allowed>/link -> /etc` cannot be used to read or write outside the allowed directories.
  `allowedRoots: ["/"]` means the whole filesystem and works as written.
- **Command guardrail.** `dangerousCommands` defaults to `block`: a catastrophic command is refused
  before execution. Operators can explicitly choose `warn` to run it with an advisory note or `allow`
  to disable the built-in guardrail. Rules match the *command word* of each shell segment, so
  `grep -n format README.md` is never affected. User `blockedCommands` entries are always enforced.
- **A bad configuration is loud.** If `runtime.json` cannot be parsed, the device refuses to start and
  says why, instead of quietly dropping your `allowedRoots` and re-enabling usage metrics.
- **Secret masking.** `list_processes` masks command arguments that look like tokens, passwords, or
  API keys before returning them.
- **Bounded everything.** Tool results are capped (`maxOutputBytes`, also clamped below the MCP
  transport limit), writes are capped (`maxWriteBytes`), buffered session output is capped by both
  line count and total characters - a stream with no newlines cannot grow without limit - and reads
  are paged or chunked.
- **Filesystem structural safety.** Archive and document snapshot/publication operations use
  descriptor-bound directory traversal on Linux. macOS and Windows preserve the same bounded snapshot,
  link/special-file rejection, canonical root confinement and atomic staging semantics, while using their
  portable path APIs where Node does not expose directory-fd-relative open/rename/unlink primitives.
  Two consequences are worth knowing: on macOS and Windows `set_permissions` re-resolves each path
  and then chmods it, so a component swap between those two steps is not descriptor-bound, and a file
  with more than one hard link (`st_nlink > 1`) is reachable from outside the allowed roots no matter
  which path was used. The runtime warns once per hard-linked path instead of refusing it, because
  backups and dotfile managers create those layouts legitimately.
- **Crash-resistant sessions.** A bogus shell, a closed stdin, or a dead parent cannot take the
  runtime down; sessions run in their own process group so `force_terminate` stops a whole pipeline;
  the agent restarts the runtime if it ever exits, so a device recovers instead of going silently
  offline.
- **Protected processes.** `kill_process` refuses pid 1, the runtime itself, and the ReMCP agent that
  hosts it - the three ways a model could otherwise cut its own connection.

These are guardrails, not an operating-system sandbox. A user who can run a shell can reach anything
their account can reach; use a container, a VM, or a dedicated user account when that matters.

ReMCP device credentials are scoped to the paired computer and can be revoked from the ReMCP
workspace; revoking a device disconnects the agent that spawns this runtime.

## Configuration

Optional settings live in `~/.config/remcp/runtime.json` (override the directory with
`REMCP_RUNTIME_CONFIG_DIR`):

```json
{
  "name": "workstation",
  "allowedRoots": ["~/projects", "/srv/data"],
  "blockedCommands": ["rm -rf /", "shutdown"],
  "dangerousCommands": "block",
  "telemetryEnabled": true,
  "maxOutputBytes": 1048576,
  "maxReadLines": 2000,
  "maxBufferedLines": 50000,
  "maxWriteBytes": 8388608,
  "defaultShell": "/bin/bash"
}
```

Every value can also be set with an environment variable: `REMCP_RUNTIME_ALLOWED_ROOTS`,
`REMCP_RUNTIME_BLOCKED_COMMANDS`, `REMCP_RUNTIME_DANGEROUS_COMMANDS`, `REMCP_RUNTIME_TELEMETRY`,
`REMCP_RUNTIME_DISABLE_TELEMETRY`, `REMCP_RUNTIME_MAX_OUTPUT_BYTES`, `REMCP_RUNTIME_MAX_READ_LINES`,
  `REMCP_RUNTIME_MAX_BUFFERED_LINES`, `REMCP_RUNTIME_MAX_WRITE_BYTES`, `REMCP_RUNTIME_SHELL`,
  `REMCP_RUNTIME_NAME`, `REMCP_BROWSER_REMOTE_ENABLED`, `REMCP_BROWSER_ALLOWED_HOSTS`,
  `REMCP_BROWSER_ALLOW_LOCAL_NAVIGATION`, `REMCP_BROWSER_ALLOW_DNS_REBIND`.


`allowedRoots` is empty by default, which means the paired device can reach anything the operating
system user running the agent can reach. Set it when you want the device to be scoped to specific
directories.

## Session behavior

Terminal sessions and searches live in memory for the lifetime of the runtime process. They end when
the agent restarts, and exited sessions are dropped 30 minutes after they finish. The agent watches
this process and restarts it with backoff if it ever exits, so a device recovers instead of staying
silently offline.

## Development

```bash
npm install
npm run check
npm test
```

The contract commands (`--help`, `--version`, `--print-tools`, `--describe`) work without
dependencies installed, so CI can diff the advertised tool surface against the published tarball.

## How it compares with Desktop Commander

This runtime is an independent implementation written for ReMCP. It is not a fork of, and shares no
code with, [DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) or any other
MCP server.

| | Desktop Commander 0.2.50 | ReMCP runtime |
| --- | --- | --- |
| Tools | 26, including config mutators and document tooling | 83, including filesystem/terminal plus native desktop UI, browser CDP, diagnostics, and lightweight document operations |
| Runtime dependencies | 34 (Supabase, Puppeteer/md-to-pdf, `sharp`, `exceljs`, Tiptap, ripgrep download) | 2 production-direct (`@modelcontextprotocol/server` v2, `@jellybrick/dbus-next`); legacy/modern clients are dev-only compatibility tests |
| Install scripts | `postinstall` posts an install payload that ignores the telemetry setting | none |
| Telemetry | opt-out, 51 event names, remote feature flags, A/B assignment, third-party processor | opt-out, whitelisted event schema, no endpoint, no flags |
| Package footprint | 3.78 MB unpacked, 249 files | small first-party runtime package; no bundled browser or document-rendering stack |
| `read_file` | also fetches arbitrary URLs (SSRF surface) | local files only; `read_binary` transfers any file as base64 |
| Command guardrails | always on, 32 substring-blocked commands, advisory; also refuses read-only mentions | `warn` by default (never blocks), `allow`/`block` opt-in, command-word matching |
| Confinement | always on, checked against the lexical path | opt-in, checked against the resolved real path |
| Local history | writes tool arguments to disk unredacted | none |
| Images | file preview UI in a specific client | `read_image` returns the image to any MCP client |
| Termination | session kill only | whole process group, plus runtime supervision and restart |

What ReMCP deliberately does not bundle: browser/document rendering stacks such as Puppeteer,
`sharp`, and `exceljs`. Spreadsheet and DOCX edits use OOXML directly, and PDF structural operations
use existing system utilities when installed. Unrestricted configuration mutation is intentionally
absent — `set_config_value` is limited to four non-security preferences, while access roots and
command security remain local; local usage history would write arguments to disk; URL reads in
`read_file` remain absent to avoid an implicit SSRF surface.

## License

MIT.
