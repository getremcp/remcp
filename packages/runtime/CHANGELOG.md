# Changelog

## 0.2.138 — 2026-10-02

- `browser_tabs`, `browser_snapshot`, `browser_find`, and `browser_wait` now set `openWorldHint=true` while retaining `readOnlyHint=true` and `idempotentHint=true`.
- This matches MCP 2026-07-28 ToolAnnotations semantics: browser inspection can observe an open world of external web entities even when it does not mutate them.
- The hosted compact browser lane was already open-world because it also contains navigation/action/evaluation operations. The 83 runtime tool names and schemas are unchanged; the annotation digest changes intentionally.

## 0.2.137 — 2026-10-02

- `environment.outputSchema` now matches the real stable runtime payload: `platform`, `arch`, `node`, `cwd`, `home`, `temp`, nullable `shell`, `path_entries[]`, and opt-in sanitized `environment`.
- Removed stale schema fields `hostname`, `release`, `path`, and `env`, which were never emitted by `environmentTool`.
- Regression coverage checks both payload and schema parity. The 83-tool count is unchanged; the tool-surface digest changes intentionally because the schema is corrected.

## 0.2.136 — 2026-10-02

- `installed_apps` now normalizes Windows registry, macOS `system_profiler`, `dpkg-query`, and `rpm` inventories into one structured `data[]` contract with stable app name/version/publisher/path fields.
- Stable top-level `backend`, `count`, `returned`, and `truncated` metadata make result limits explicit and remove platform-specific text parsing from callers.
- Name filtering and de-duplication are shared across platforms. Windows no longer interpolates the filter into PowerShell.
- Public release CI exercises the live native inventory on Linux, macOS, and Windows. Tool names remain unchanged at 83; the output-schema digest changes intentionally.

## 0.2.135 — 2026-10-02

- Linux `audio` status is normalized across `wpctl`, `pactl`, and `amixer` into structured `volume`, `muted`, `action`, and `backend` fields; mutating audio actions re-read and return the verified state.
- Windows Core Audio and macOS audio responses expose the same `action`/`backend` fields.
- The additive `backend` output-schema field changes the tool-surface digest without changing tool names or the 83-tool count.

## 0.2.134 — 2026-10-02

- `power_action delay_seconds` is bounded to 0–90 seconds in schema and runtime validation so a delayed destructive call cannot intentionally outlive the hosted ~110-second device-call lifetime.
- Delayed power actions use the propagated MCP AbortSignal; cancellation clears the timer and stops before any OS lock/sleep/restart/shutdown command is sent.
- A second cancellation check runs immediately before platform dispatch. Regression tests cover pre-cancelled, mid-delay-cancelled, and schema-bound behavior.
- Runtime tool names remain unchanged; this is a safety/correctness tightening of the existing power tool.

## 0.2.133 — 2026-10-02

- Explicit `computer_action type target=window` now keeps top-level window selectors separate from semantic element selectors; `window_id` is never rewritten into the UI-element `id` before `type_text`.
- Auto window fallback uses the same sanitized window-only selector shape, preventing stale UI/browser selectors from hijacking window-scoped text entry.
- Live GNOME/AT-SPI Zenity validation returned the exact Unicode payload after the accessibility edit path. Runtime tool names and schemas are unchanged from 0.2.132.

## 0.2.132 — 2026-10-02

- `computer_action` now exposes `type`, `scroll`, `drag`, and `target=window` in its MCP schema while keeping specialist tools available when the backend is already known.
- Auto `type` uses accessibility-only semantic editing before CDP and never falls through to unverified physical text input merely because a native selector failed.
- Browser DOM typing separates `browser_text` locator semantics from the `text` payload; legacy locator-in-`text` calls remain compatible when `value`/`text_value` carries the payload.
- `browser_action scroll` performs bounded page or nearest-scrollable-ancestor scrolling with the same delta/direction vocabulary as native `scroll`; `computer_action scroll` can route to it automatically.
- Action-specific schemas validate type targets/text, scroll deltas/directions, drag endpoints, and explicit backend/target compatibility before handler execution. Window targets require a window selector; UI/coordinate scroll and drag require target-appropriate fields; browser/OCR drag is rejected before dispatch.
- macOS `service action=list` now uses explicit launchd domains so `scope=user` reads `gui/<uid>` and `scope=system` reads `system`; the old legacy `launchctl list` path could not honor system scope.
- Public macOS release CI exercises the system launchd domain in addition to document/network backends. Runtime tool names remain unchanged at 83.

## 0.2.131 — 2026-10-02

- `network action=summary` is now bounded for Docker-heavy hosts: non-container interfaces are prioritized, at most eight interfaces and four addresses per interface are returned, and count/truncation metadata shows what was omitted.
- `network action=interfaces` remains the complete adapter/address inventory. The MCP schema and tool names remain compatible; stable count/truncation fields are now declared for chaining.

## 0.2.130 — 2026-10-02

- `computer_snapshot` now skips desktop-only probes on headless Linux and returns stable empty/unavailable desktop fields without false error noise. The shared `desktopSessionAvailable()` helper keeps this behavior aligned with live capability discovery.
- Linux `screenshot_region` advertising now uses the same backend resolver as execution: `grim` is Wayland-only, portal capture requires a Wayland portal candidate plus `ffmpeg`, GNOME capture requires `gnome-screenshot` + `ffmpeg`, and X11 uses ImageMagick `import`.
- Wayland + `ffmpeg` alone no longer exposes a screenshot tool that can only fail at runtime. Tool names and MCP schemas remain unchanged.

## 0.2.129 — 2026-10-02

- Linux Desktop capability discovery now requires an active `DISPLAY` or `WAYLAND_DISPLAY`, preventing headless hosts from advertising desktop actions just because helper binaries are installed.
- `launch_app` requires `desktop_session`; `open_path` and `reveal_path` require `desktop_open`, which additionally checks `xdg-open` on Linux.
- AT-SPI/Wayland portal probes are skipped entirely on headless Linux. Browser/CDP and non-desktop capability groups remain independent.
- Tool names and MCP schemas remain unchanged.

## 0.2.128 — 2026-10-02

- Linux `power_action` is advertised only when both `loginctl` and `systemctl` exist, matching the full lock/sleep/restart/shutdown schema instead of exposing a partially unusable tool.
- Linux `network listeners` keeps `ss -lntup` as the preferred backend and changes the `netstat` fallback from `-an` to `-lntu`, excluding established/non-listening connections.
- Tool names and schemas remain unchanged; dynamic capability updates continue to use `tools/list_changed`.

## 0.2.127 — 2026-10-01

- macOS `network listeners` now returns only TCP `LISTEN` rows from the native network table instead of all active connections.
- Established/closing and Unix-domain rows are filtered out, aligning macOS with the documented listener-only contract.
- The macOS release CI runs the routing + listener diagnostics test on `macos-latest`. Tool names and schemas remain unchanged.

## 0.2.126 — 2026-10-01

- macOS `network` route inventory now uses `/usr/sbin/netstat -rn`; the previous generic Unix fallback invoked `route -n`, which on BSD/macOS expects a command and can return usage instead of the table.
- Linux and Windows network backends are unchanged.
- The public macOS release gate executes the real route handler on `macos-latest`. The 83 tool names/schemas remain unchanged.

## 0.2.125 — 2026-10-01

- Windows `audio` now controls the default render endpoint through the native Core Audio `IAudioEndpointVolume` interface hosted by inbox PowerShell `Add-Type`.
- `status` returns the actual 0–100 master level and mute state; `set_volume` is absolute; `mute`/`unmute` use idempotent `SetMute(true/false)` instead of a shared toggle key.
- Windows release CI compiles the interop definition with PowerShell 5.1 on `windows-latest`. No third-party runtime dependency is added and the 83 tool schemas are unchanged.

## 0.2.124 — 2026-10-01

- P3 document capability discovery is cross-platform: Windows uses the native .NET OOXML archive backend, while macOS/Linux require both `zip` and `unzip` before advertising the XLSX/DOCX editor tools.
- `read_document` and `pdf_action` remain discoverable on supported desktop platforms even without an OOXML archive backend; DOCX/XLSX read attempts still fail closed at execution time when extraction is unavailable. `edit_spreadsheet` and `edit_document` explicitly require `ooxml`.
- Windows and macOS release CI run real candidate XLSX/DOCX create/read round trips before publication. The 83-tool names and schemas are unchanged.

## 0.2.123 — 2026-10-01

- The compact local MCP facade now tracks live capability changes after startup. It advertises `tools.listChanged`, refreshes grouped input/output schemas, and adds or removes domains such as `control_browser` when loopback CDP becomes available or unavailable.
- Compact and granular capability polling now serializes discovery passes so a slow probe cannot overlap the next interval and apply a stale capability result out of order.
- The underlying 83 granular runtime tool names, input/output schemas, annotations, and handlers remain unchanged from 0.2.122.

## 0.2.122 — 2026-09-30

- No runtime tool names, schemas, or device-side implementations change in this release. The runtime package version remains in lockstep with the Windows bootstrap release, which pins the private Windows Node execution engine for reproducible installs.

## 0.2.121 — 2026-09-29

- record_screen gains a GNOME Shell Screencast backend for GNOME Wayland, so a native GNOME desktop no longer needs wf-recorder merely to advertise and perform bounded screen recording. The backend keeps start/stop on one D-Bus connection and produces WebM.
- Capability discovery probes ScreencastSupported fail-closed, caches the result for 15 seconds, and coalesces concurrent probes before tools/list_changed can expose the capability. Existing wf-recorder, X11 ffmpeg, AVFoundation and gdigrab paths remain available.
- Explicit recording destinations must use an extension matching the actual container (.webm for native GNOME Wayland, .mp4 for the other current backends).

## 0.2.116 — 2026-09-29

- Linux Wayland `list_windows` stops its AT-SPI inventory traversal at top-level windows instead of walking descendant controls. On the verified ASUS desktop this kept the same 13 stable window records while cutting the call from roughly 7.2 seconds to roughly 2.1 seconds; `computer_snapshot` first-look latency fell from 7.50 seconds to 2.45 seconds in the same state.
- XWayland refresh/merge behavior, bounds, stable IDs and window actions are unchanged. Runtime tool names, schemas and annotations are unchanged from 0.2.115.

## 0.2.115 — 2026-09-28

- Reconnect timer scheduling now exposes the existing finite upper bound as an explicit control-flow guard at the `setTimeout` sink, satisfying CodeQL without changing reconnect delay semantics.
- Runtime package repository metadata now uses the project release URL `https://github.com/antonbaider/remcp`. Tool names, schemas, annotations, and runtime behavior are otherwise unchanged from 0.2.114.

## 0.2.114 — 2026-09-27

- `extract_archive` writes each regular-file overlay into an exclusive no-follow temporary inode beside the destination and commits it with atomic `rename()`, removing the check-then-truncate filesystem race while preserving existing-file overlay semantics and unrelated destination contents.
- Runtime tool names, input schemas, and output schemas are unchanged from 0.2.113.

## 0.2.113 — 2026-09-26

- No runtime tool names, schemas, or device-side tool implementations change in this release. The runtime package version remains in lockstep with the hosted/client release while relay heartbeat, reconnect admission, telemetry cadence, gateway capacity, and production load-safety are hardened.

## 0.2.112 — 2026-09-25

- Linux EIS absolute pointer motion converts desktop-wide coordinates into the selected libei region before dispatch and keeps the current pointer device when it remains valid, eliminating accepted-but-undelivered absolute moves.
- Wayland portal drag-and-drop uses one region-safe target transition while pressed, then reasserts the final target before release so `pointerdown → pointermove → pointerup` remains intact.
- The live computer-use smoke is serialized per user to prevent concurrent desktop-input races; the final ASUS GNOME Wayland run passed 82/82 checks. Runtime tool names and schemas are unchanged.

## 0.2.111 — 2026-09-25

- `read_document` reads `.xlsx` files again while `allowedRoots` confinement is enabled: the reader no longer re-enters its own temp staging path through the allowlist.
- Linux window inventory refreshes X11 rows after the AT-SPI walk, window selectors resolve X11/XWayland targets without a full semantic rebuild, and `window_action focus` verifies direct XWayland activation before falling back to portal cycling. Runtime tool names and schemas are unchanged.

## 0.2.110 — 2026-09-25

- Bulk handlers (`read_multiple_files`, `read_files`, `replace_in_files`, `write_files`, `copy_paths`, `move_paths`, `delete_paths`, `create_archive`) and the directory walk now honour client cancellation between items, so an aborted call stops at the next item boundary instead of finishing on the device; single-file and external-tool (`tar`/`unzip`) operations remain atomic and are not interrupted mid-step.
- A file with more than one hard link now produces one warning per path: path-based confinement cannot see a shared inode, and refusing would break backup and dotfile layouts.
- Runtime tool names, input schemas and output schemas are unchanged.

## 0.2.109 — 2026-09-25

- Linux file reads and recursive permission changes retain descriptor-bound parent traversal for the full operation; proc-fd anchored captures remain readable without reopening the path lexically.
- Linux directory walks, listings, and search sessions pin allowed roots and parent descriptors, including bulk reads and edits, so ancestor swaps cannot redirect traversal.
- `record_screen` publishes from private staging and anchors Linux destination parents; XDG portal screenshots use no-follow copying, reject symlink source/destination paths, and no longer delete an untrusted portal-returned URI.
- Production CDP sessions reject dead sockets, recursively guard child targets and evict failed guarded new-tab sessions. Runtime tool names and schemas are unchanged.

## 0.2.108 — 2026-09-25

- Standalone production runtimes keep browser control disabled unless explicitly enabled; the authenticated paired agent enables its owned local runtime. IP-literal production allowlisting and persistent CDP guards cover page and worker sessions, delayed navigation, redirects, and subresources.
- Archive and document operations use descriptor-bound Linux traversal where available; macOS/Windows preserve bounded source snapshots, canonical confinement, link/special-file rejection, and atomic staging through portable filesystem APIs instead of losing document/archive tools.
- Linux semantic scroll/drag targets refresh accessibility geometry, and empty AT-SPI snapshots retry once before using the conservative depth fallback. Runtime tool names and schemas are unchanged.

## 0.2.106 — 2026-09-22

- Wayland EIS records the emulated device used for each button press and sends the matching release through that same device, preventing cross-region/device drags from losing `pointerup`.
- Portal drag-and-drop adds source settle time plus bounded intermediate absolute motion events; live ASUS DOM read-back verified the complete `down → move → … → up` gesture.
- Semantic-target scroll validation moves to a known visible target before wheel injection, and Wayland `screenshot_region` prefers `grim` or GNOME Screenshot before the interactive portal when available.
- Current-tree validation passed 215/215 runtime tests and the full 80/80 live ASUS computer-use smoke.
- macOS runtime code and runtime tool names/schemas are unchanged from 0.2.105.

## 0.2.105 — 2026-09-22

- macOS top-level window IDs include a snapshot generation and retain cached app/title/bounds identity, so a changed process-local window index cannot silently retarget an action.
- Older cached handles recover the same unambiguous window after reorder; stale, fabricated, expired, or ambiguous handles fail closed and require `list_windows` refresh.
- Unit/regression coverage verifies generation-scoped IDs, PID consistency, legacy/fabricated handle rejection, and fail-closed stale-handle behavior.
- Runtime tool names and schemas are unchanged from 0.2.104.

## 0.2.104 — 2026-09-22

- Fresh installations default the narrow catastrophic-command guardrail to `block`; ordinary development, file, Git, package-manager, Docker, database, browser, and document workflows remain available.
- Explicit `warn`, `allow`, and unrestricted/godmode remain operator-controlled local opt-ins.
- Added an isolated 73-scenario Desktop Commander compatibility smoke matrix; all 73 scenarios pass with zero guardrail false positives, while genuinely catastrophic host power/destructive commands remain blocked before execution.
- Wayland portal pointer clicks now keep a 60 ms button-down interval before release so a transport-level success is not collapsed into a zero-duration gesture; the fix passed three consecutive full 80/80 live ASUS smoke runs.
- Runtime tool names and schemas are unchanged from 0.2.103.

## 0.2.103 — 2026-09-22

- Native Wayland `window_action` targets exact PID/title Accessibility windows for `close` and verifies that the requested window disappeared.
- Shortcut-backed Wayland window actions require verified focus on the exact requested window before minimize, maximize, move, resize, or close proceeds; ambiguous targeting fails closed.
- Live smoke coverage isolates XDG open/reveal handlers and stabilizes browser input focus without changing the runtime tool surface.
- Verified on GNOME Wayland with 80 passing computer-use checks and a two-window isolation proof: target A closed while sibling B stayed open.

## 0.2.102 — 2026-09-22

- `runWithInput` installs a stdin error handler before writing input, so an early child pipe close is returned as a `ToolError` instead of an uncaught `EPIPE` that can terminate the runtime.
- A failed input pipe now terminates the child before rejecting, preventing a rejected call from leaving an orphan process behind.
- Empty input closes stdin without a zero-byte write, reducing races with short-lived subprocesses.
- Added a deterministic closed-stdin regression and stress coverage; runtime tool names and schemas are unchanged.

## 0.2.101 — 2026-09-22

- macOS `record_screen` resolves FFmpeg from standard Homebrew locations when launchd's minimal `PATH` cannot see it.
- AVFoundation screen capture now enumerates devices and selects the actual `Capture screen` index instead of assuming input 1.
- Capability discovery stays conservative: no recorder backend means no `record_screen`; Linux Wayland still requires `wf-recorder`.
- Added regression coverage for Homebrew discovery and real-world AVFoundation ordering where input 1 is OBS Virtual Camera and the screen is input 3.

## 0.2.100 — 2026-09-22

- Wayland portal-backed region screenshots clip compositor window bounds to the visible virtual desktop before FFmpeg cropping.
- Portal crop geometry translates negative virtual-desktop origins and scales logical coordinates to the captured PNG dimensions.
- Partially visible windows return the visible pixels with an explicit clipping summary; fully invisible regions fail closed.
- Added regressions for oversized/off-screen windows and multi-monitor scaling, plus a real GNOME Wayland 931×910 → 931×900 capture proof.

## 0.2.99 — 2026-09-22

- Lockstep runtime republish for the release-pipeline catalog synchronization fix.
- Runtime handlers and schemas are unchanged from 0.2.98: `pdf_action info` fallback exposes numeric `annotation_count`, and the live desktop smoke treats `record_screen` as capability-conditional.
- 0.2.98 was published publicly but not deployed by the private production pipeline because its stale hosted catalog was caught fail-closed before rollout.

## 0.2.98 — 2026-09-22

- `pdf_action info` fallback exposes numeric `annotation_count` instead of violating the declared `annotations` array output contract.
- Added outputSchema validation coverage for the no-`pdfinfo` fallback path.
- Live desktop smoke treats `record_screen` as capability-conditional and verifies every tool actually advertised by the runtime.
- Tool names remain unchanged.

## 0.2.97 — 2026-09-22

- Native GNOME Wayland `move`, `resize`, and `move_resize` no longer trust a portal drag as proof of success.
- Window geometry is re-read after each gesture and must match the requested coordinates/size within a bounded tolerance; otherwise the action fails closed.
- `move_resize` confirms the move before computing the resize gesture. Tool names and schemas remain unchanged.

## 0.2.96 — 2026-09-22

- Keeps readable search matches when an unreadable descendant is encountered while surfacing a warning.
- Makes the regression backend-neutral so both ripgrep and the built-in scanner are validated consistently.
- Supersedes the failed unpublished 0.2.95 tag; runtime behavior is otherwise unchanged from that candidate.

## 0.2.95 — 2026-09-22

- Search sessions preserve readable matches when ripgrep encounters unreadable descendant paths, reporting the partial traversal problem as a warning instead of a fatal session error.
- The dependency-free fallback scanner now skips unreadable descendant directories/files with the same warning semantics.
- Requested-root failures and non-traversal ripgrep errors still fail closed.
- Added ripgrep and fallback regressions; runtime tool names and schemas remain unchanged.

## 0.2.94 — 2026-09-22

- Replaced DOCX/PDF regex-heavy extraction with bounded scanners and added adversarial parser regressions.
- Browser actions pass user-controlled values through structured CDP arguments instead of interpolating them into executable JavaScript.
- File/search/screenshot/hash operations validate and consume the same open descriptor, using `O_NOFOLLOW` where supported to prevent symlink-swap/check-then-use races.
- Temporary desktop captures and telemetry marker creation are now descriptor-bound or atomic.
- Tool schemas and the 83 granular runtime operations remain unchanged.

## 0.2.93 — 2026-09-21

- Lockstep release for the device client's fresher npm metadata revalidation during exact release updates.
- Runtime handlers, schemas, the 83 granular operations, and compact/granular stdio behavior are unchanged.
- The client still installs the runtime as the trusted exact release pair; this patch only changes how npm metadata is refreshed before installation.

## 0.2.92 — 2026-09-21

- Lockstep documentation release for the hosted 10-tool native-only production contract.
- Generated/public tool references now omit dormant widget helpers from current production tables while documenting the optional 15-tool widget-enabled mode separately.
- Runtime handlers, schemas, the 83 granular operations, and compact/granular stdio behavior are unchanged.

## 0.2.91 — 2026-09-21

- Lockstep release for the hosted server's temporary custom-widget disablement.
- Runtime handlers, schemas, and the 83 granular operations are unchanged.
- Local compact/granular stdio behavior is unchanged; the production change is limited to hosted discovery and presentation policy.

## 0.2.90 — 2026-09-21

- Updated README tool-count documentation to the current 15 hosted / 10 model-visible / 5 app-only / 83 granular runtime architecture.
- Clarified the separate compact local stdio surface of up to 8 tools.
- Added regression coverage that rejects obsolete 94/91 hosted counts.
- Runtime behavior and tool schemas are unchanged; lockstep documentation patch at `0.2.90`.

## 0.2.89 — 2026-09-21

- EIS direct typing preflights every character before dispatch, so unsupported Unicode fails before any partial keyboard mutation.
- Added regression coverage proving `abc✓` sends zero EIS events before the ASCII-only error.
- Compact and granular runtime catalogs remain unchanged; lockstep patch release at `0.2.89`.

## 0.2.88 — 2026-09-21

- Added a real compact stdio façade over the same runtime handlers: `read_file` plus up to seven capability-filtered `verb_noun` domain tools.
- Grouped operations keep their original closed schemas and dispatch through `invokeTool`, so the compact surface changes discovery, not execution or permissions.
- The normal paired-agent runtime remains the granular 83-operation capability-aware server.
- Added compact-catalog parity and end-to-end stdio tests.

## 0.2.87 — 2026-09-21

- macOS `event_log` now streams only the requested head lines from `log show` and terminates the child once the limit is reached.
- Added a bounded child-process line reader with UTF-8-safe decoding, timeout and byte caps, plus regression coverage for noisy output.
- Runtime tool schemas and the 83-tool release catalog are unchanged.

## 0.2.86 — 2026-09-21

- Runtime capability remains the same 83 granular operations; this patch changes hosted tool metadata only.
- No runtime schema, permission, handler, or operation name changed.
- Lockstep patch release with the ReMCP client/server at `0.2.86`.

## 0.2.85 — 2026-09-21

- Runtime capability remains 83 granular tools; no device-side operation is removed or renamed in this patch.
- The hosted server now groups those operations into a compact typed discovery façade while dispatch still validates and executes the original per-operation runtime schemas.
- Lockstep patch release with the ReMCP client/server at `0.2.85`.

## 0.2.84 — 2026-09-21

- `edit_document` can create a new DOCX with `create=true`, refusing to overwrite an existing destination.
- `edit_spreadsheet` can create a new XLSX workbook with an optional first-sheet name and existing cell/range/formula edits.
- Added OOXML creation, overwrite-safety, invalid-sheet-name, schema/output, and read-back regression coverage; the runtime catalog remains 83 tools.

## 0.2.83 — 2026-09-21

- Linux X11 `record_screen` capability now requires both `ffmpeg` and a real `DISPLAY`; headless hosts no longer advertise a recorder that will fail.
- The runtime no longer invents `:0.0` for headless X11 calls and fails closed with a clear display requirement before ffmpeg runs.
- `wf-recorder` is selected only for actual Wayland sessions.
- Regression coverage locks the headless capability and handler behavior; lockstep patch release at `0.2.83`.

## 0.2.82 — 2026-09-21

- Clarified `set_config_value` routing so local runtime preferences stay separate from hosted account-level `device_action` administration.
- Runtime functionality remains at 83 release tools; this release keeps client/runtime versions in lockstep with the hosted MCP catalog consolidation.

## Unreleased

## 0.2.81 — 2026-09-21

- `record_screen` is advertised only when the current OS/session has a recorder backend the runtime can actually invoke.
- macOS/Windows require `ffmpeg`; Linux Wayland requires `wf-recorder + timeout`; Linux X11 requires `ffmpeg`.
- Availability errors are platform-specific, and regression coverage locks the capability matrix.
- Lockstep patch release with the ReMCP client/server at `0.2.81`.

## 0.2.80 — 2026-09-21

- Wayland `type_text` can replace text in an inactive explicitly targeted native window without compositor focus when exactly one editable accessibility control is present.
- Ambiguous or missing editables are never guessed; key/clipboard/Enter fallbacks retain verified window-focus requirements.
- Tool descriptions now explain the semantic window-target path so agents do not request unnecessary focus before accessibility replacement.
- Lockstep patch release with the ReMCP client/server at `0.2.80`.

## 0.2.79 — 2026-09-21

- Explicit Wayland keyboard and key-by-key text input now focuses and verifies the requested target window before dispatch, with bounded direct window cycling and verified fallbacks.
- Native Wayland cursor telemetry fails closed instead of trusting stale XWayland `xdotool` coordinates; `computer_snapshot` keeps that capture non-fatal and structured.
- Regression coverage is headless-safe while still enforcing the snapshot normalization/error contract.
- Lockstep patch release with the ReMCP client/server at `0.2.79`.

## 0.2.77 — 2026-09-21

- Fixed `browser_action` typing so the documented `text` argument reaches CDP `Input.insertText` with Unicode intact; `value` and `text_value` remain compatible aliases.
- Clarified the browser action schema so agents use `text` for typing and reusable selectors from `browser_find`.
- Lockstep patch release with the ReMCP client/server at `0.2.77`.

## 0.2.76 — 2026-09-21

- `browser_find(text=...)` ranks exact semantic targets ahead of broad ancestor text containers, prefers actionable/semantic nodes, and de-duplicates nested matches before applying the result limit.
- Native `h1`–`h6` elements derive the `heading` role, improving browser text targeting and follow-up actions.
- Lockstep patch release with the ReMCP client/server at `0.2.76`.

## 0.2.63 — 2026-09-20

- Lockstep MCP Apps production-surface release with the ReMCP client/server at `0.2.63`; device runtime tool behavior is unchanged from `0.2.62`.

## 0.2.62 — 2026-09-20

- Lockstep skill-routing metadata release with the ReMCP client at `0.2.62`; runtime tool behavior is unchanged from `0.2.61`.

## 0.2.61 — 2026-09-20

- Lockstep plugin/web branding release with the ReMCP client at `0.2.61`; runtime tool behavior is unchanged from `0.2.60`.

## 0.2.60 — 2026-09-20

- Lockstep canonical-branding release with the ReMCP client at `0.2.60`; runtime tool behavior is unchanged from `0.2.59`.

## 0.2.59 — 2026-09-20

- Tool descriptions now make routing boundaries explicit across overlapping filesystem, search, process, system, desktop, diagnostics, and document operations so AI hosts prefer the narrowest semantic tool instead of broad shell or fallback tools.
- Wayland absolute pointer delivery uses the EIS helper path and avoids stale cached-position assumptions when falling back, improving deterministic desktop input on GNOME/Wayland.
- Lockstep patch release with the ReMCP client at `0.2.59`.

## 0.2.58 — 2026-09-20

- `computer_snapshot` normalizes partial platform-capture failures into schema-stable collections/objects and bounded `{ source, message }` errors instead of leaking error strings into structured output.
- Output-budget pruning preserves the structured snapshot error contract, and browser snapshot fallbacks reject invalid/error-shaped payloads.
- Dynamic browser/CDP capability groups now toggle registrations in one batch and emit one `tools/list_changed` notification per transition, preventing concurrent stdio notification writes from exceeding Node's listener limit.
- Lockstep patch release with the ReMCP client at `0.2.58`.

## 0.2.57 — 2026-09-20

- ZIP extraction recognizes Info-ZIP `unzip` on Debian/Ubuntu by probing it with `-v`, fixing the false “unzip is not installed” error reproduced during physical 76-tool package verification.
- Lockstep patch release with the ReMCP client at `0.2.57`.

## 0.2.56 — 2026-09-20

- Lockstep patch release with the ReMCP client at `0.2.56`; the runtime tool implementation is unchanged from `0.2.55`.

## 0.2.55 — 2026-09-20

- Lockstep patch release with the ReMCP client at `0.2.55`; the runtime tool implementation is unchanged from `0.2.54`.

## 0.2.54 — 2026-09-20

- Lockstep patch release with the ReMCP client at `0.2.54`; the runtime tool implementation is unchanged from `0.2.53`.

## 0.2.53 — 2026-09-20

- Lockstep patch release with the ReMCP client at `0.2.53`; the runtime tool implementation is unchanged from `0.2.52`.

## 0.2.52 — 2026-09-20

- `computer_snapshot.active_window` is nullable when native accessibility state cannot be matched to the platform's top-level window enumeration, preventing valid macOS snapshots from failing structured output validation.
- Lockstep patch release with the ReMCP client at `0.2.52`.

## 0.2.51 — 2026-09-20

- Linux AT-SPI text/focus operations reject explicit false results, `type_text method=accessibility` remains accessibility-only, and semantic browser text failures direct callers to `browser_action` rather than reporting an unverified paste as success.
- GNOME Wayland drag requires the consent-backed Remote Desktop portal instead of unreliable XTEST/xdotool delivery.
- PDF `read_document` falls back from the built-in parser to local `pdftotext` when embedded fonts prevent direct decoding, while preserving the existing no-text error when neither path extracts content.
- Lockstep patch release with the ReMCP client at `0.2.51`.

## 0.2.50 — 2026-09-20

- Lockstep release with the ReMCP client after the hosted MCP/plugin contract was hardened for current OpenAI/MCP Apps requirements.
- Computer-use tools retain the 83-tool runtime surface with AI-oriented descriptions, conditional JSON Schema validation, structured outputs, dynamic capability advertising, and semantic Accessibility/DOM-first routing.
- `browser_navigate` adds `action=new_tab` so CDP automation can create the first page target without a shell/browser-address-bar workaround.
- Live Linux verification covers Tesseract OCR targeting, XDG RemoteDesktop keyboard/pointer input, Unicode `type_text`, and the complete 39-tool computer-use smoke.

## 0.2.49 — 2026-09-20

- Terminal process tools now return schema-validated structured session state, output ranges, match results and termination facts alongside their human-readable text.
- The runtime catalog and hosted tool contract align on bounded structured outputs and accurate read-only/destructive/idempotent/open-world annotations for the expanded computer-use surface.
- Preview references remain optional presentation metadata rather than replacing the source result used for model reasoning.
- Lockstep patch release with the ReMCP client at `0.2.49`.

## 0.2.48 — 2026-09-20

- Migrate the local stdio runtime to the official `@modelcontextprotocol/server` v2 serving entry while preserving legacy 2025-era client compatibility.
- Add negotiated MCP `2026-07-28` support, including `server/discover`, cache hints, full structured output validation, and subscription-based `notifications/tools/list_changed` delivery.
- Keep the legacy `@modelcontextprotocol/sdk` and modern `@modelcontextprotocol/client` packages dev-only so CI continuously proves both protocol eras against the same runtime.
- Add optional Tesseract-backed OCR inside `computer_snapshot`/`computer_action`, including bounded word/line boxes and HiDPI/multi-monitor coordinate mapping, without adding another MCP tool or production dependency.
- Added 39 computer-use tools: native desktop/window automation, accessibility UI inspection/actions, browser CDP, diagnostics, and lightweight DOCX/XLSX/PDF operations.
- Live `tools/list` now advertises only capabilities available on the current operating system and sends `notifications/tools/list_changed` when the capability set changes; `--print-tools` remains the stable full 83-tool release contract.
- Added high-level `computer_snapshot` and `computer_action` primitives so agents can prefer semantic Accessibility/DOM targets and fall back to coordinates/screenshots only when necessary.
- Chrome DevTools Protocol endpoints are restricted to loopback addresses. New filesystem/document operations continue through the existing resolved-path allowlist, and launch/service/power operations reuse the runtime command policy.
- Fixed metadata output truncation once the JSON tool contract exceeded the operating-system pipe buffer by waiting for stdout writes to flush before exit.
- Terminal session tools now expose schema-validated structured `pid`, status, exit information, output ranges/matches, and session lists alongside their human-readable text, so hosted agents can chain process calls without parsing prose.
- Tool descriptions now state the intended routing boundary for exact-path vs glob reads, singular vs batch filesystem operations, full-screen vs targeted/semantic screenshots, and local runtime settings vs hosted device labels.
- Desktop action schemas and common guards now reject targetless `ui_action`/`window_action`, coordinate-less pointer moves, zero-motion scrolls, incomplete cross-backend `computer_action` targets, and connectivity tests without host/port before platform adapters can act. Empty `ui_find`/`browser_find` calls are redirected to their snapshot tools, and `wait_for_ui` requires an explicit state/condition instead of silently acting as a no-op.
- `take_screenshot` is correctly advertised as non-read-only/non-idempotent because kept or oversized captures can persist timestamped files; selector-scoped `browser_snapshot` screenshots restore the original page scroll position before returning so the inspection path remains read-only.
- No browser/document rendering stack was added; the runtime remains dependency-light and uses native OS facilities plus existing qpdf/poppler/zip helpers when available.

## 0.2.47 — 2026-09-19

- Lockstep release with the ReMCP client. Runtime behavior is unchanged from 0.2.46; the client now recovers from transient HTTP handshake failures and migrates Linux systemd services to a stable launcher independent of nvm/Hermes prefixes.

## 0.2.46 — 2026-09-19

- Lockstep release with the ReMCP client. Runtime behavior is unchanged from 0.2.45; the client makes all macOS service restarts use a detached launchd handoff so commands initiated from inside the agent cannot terminate their own updater or settings operation.

## 0.2.45 — 2026-09-19

- Lockstep hotfix with the ReMCP client. Runtime behavior is unchanged from 0.2.44; the paired release fixes macOS self-update handoff so a client update launched from inside ReMCP cannot kill its own repair process.

## 0.2.44 — 2026-09-19

- Lockstep compatibility release with the ReMCP client. Runtime behavior is unchanged from 0.2.43; the pair stays on one immutable version while the client adds versioned config migrations and cross-platform background-service recovery for legacy installations.

## 0.2.43 — 2026-09-19

- Lockstep patch release with the ReMCP client. Runtime behavior is unchanged from 0.2.42; the release keeps client and runtime on the same immutable version while the client fixes automatic reconnect after a temporary device pause.

## 0.2.36 — 2026-09-18

- Documentation and runtime introspection now describe the current 44-tool local surface instead of
  older 35/43-tool snapshots.
- `get_runtime_info` explicitly distinguishes its read-only report from the four preferences that
  `set_config_value` may change. Access roots, blocked commands, the command guardrail, shell,
  write limit, runtime name and unrestricted mode remain local to the computer.
- Package/review documentation now matches the published runtime dependencies and the current
  trusted-publishing release flow.

## 0.2.34 — 2026-09-18

- Lockstep security release with the ReMCP client. Runtime behavior is unchanged from 0.2.33.

## 0.2.33

- Linux Wayland screenshots now use the standard XDG Desktop Portal before compositor-specific
  command-line fallbacks. The runtime subscribes to the portal response before requesting the
  capture, handles fast and legacy request handles without losing the signal, respects an explicit
  cancellation, and cleans the portal-created intermediate PNG after copying it.

## 0.2.30

- **Unrestricted mode.** `REMCP_RUNTIME_UNRESTRICTED=1` (or `"unrestricted": true` in `runtime.json`,
  or `remcp godmode on`) lifts the access roots, the configured command blocklist and the
  catastrophic-command guardrail for this computer. It is not settable through MCP: `set_config_value`
  still accepts only the four preferences it lists, so a model cannot widen its own reach.
  `get_runtime_info` reports `policy.unrestricted` and says how to turn it off. Size limits
  (`maxWriteBytes`, `maxOutputBytes`, line limits) are unchanged, and commands still run as the user
  the agent runs as.

## 0.2.29

- Screenshot failures on GNOME Wayland name the tool that works (`gnome-screenshot`); previously the
  message suggested `grim`, which cannot read a GNOME session at all.

## 0.2.26

- Screenshot failures explain the platform's own gate: Screen Recording on macOS, an interactive
  session on Windows, `grim`/`gnome-screenshot` on Wayland, and "no graphical session" on a server.
- A PNG above the inline limit is saved on the computer and the result says how to fetch it in
  chunks, instead of failing the call.

## 0.2.25

- `EACCES`/`EPERM`/`EROFS`/`ENOSPC`/`EBUSY` from the file system are explained instead of printed
  raw: macOS privacy folders (Full Disk Access for the exact `node` binary), Windows Controlled
  folder access, Linux ownership, read-only mounts and full disks. Every filesystem failure in the
  runtime goes through it.

## 0.2.20

- `set_config_value`: a model may change this runtime’s own preferences (telemetry opt-out, read
  and buffer line limits, result size) while it is running; the change applies immediately and is
  saved to runtime.json. Access roots, blocked commands, the command guardrail, the shell and the
  write limit stay with the person at this computer and are refused by the tool.

## 0.2.16

- Mark cursor-consuming `read_process_output` as non-idempotent so clients do not assume retries
  replay the same output.

## 0.2.11

- Version lockstep with the client.


## 0.2.10

Tool-call reliability fixes found by the second audit round.

- `apply_patch` accepts `diff -u` headers that carry a tab and timestamp (the timestamp is not part
  of the file path), treats a blank line inside a hunk as an empty context line instead of dropping
  it, and drops trailing empty context lines the diff's own line counts say are not part of the hunk.
- The output budget now bounds the serialised frame, not the raw bytes: a control character becomes
  six bytes once JSON-escaped, so an ANSI-heavy result used to pass the check and still exceed the
  transport limit, closing the connection mid-call.
- `read_file`, `read_binary`, `read_image` and `hash_file` refuse anything that is not a regular
  file, so a FIFO cannot hang a call and a device node cannot flood it.
- Tree walks report the directories they could not read instead of silently returning a partial
  result, `read_files` reports the real number of matches, `set_permissions` reports per-path
  failures instead of stopping at the first one, and a glob character class with an invalid range
  falls back to a literal match instead of throwing out of the tool.

## 0.2.7

Security and correctness fixes for the device runtime.

- **Symlink confinement fixed.** `read_files`, `replace_in_files` and `set_permissions` walked a
  tree with `stat`, which follows symbolic links, and never re-checked the children they collected.
  A directory symlink inside an allowed root could therefore be read *and rewritten* outside it.
  Traversal now uses `lstat`, never follows a link, and re-resolves every collected path through
  the same confinement check a single-file call uses.
- **Large results no longer kill the runtime.** The inline image limit is 4 MiB instead of 8 MiB:
  base64 costs a third more bytes and the MCP stdio client drops the connection above 10 MB, which
  used to restart the runtime in the middle of a call. The text budget is shared between `content`
  and `structuredContent`, which carry the same string.
- **`apply_patch` inserts zero-context hunks at the right line**: `@@ -N,0 +M,K @@` inserts *after*
  line N, and the previous calculation applied every such hunk one line early while reporting
  success.
- **Glob patterns honour `[abc]`, `{a,b}` and `?`**: character classes and brace alternatives were
  escaped into literal text and matched nothing, and `?` could match a directory separator.

## 0.2.3

Full surface and review-aligned annotations. (0.2.0 was published from an earlier snapshot that
carried 23 tools; 0.2.1 is the release that matches this repository.)

- 37 tools: bulk reads and writes (`read_files` by glob, `write_files` for many files at once), binary transfer in both directions (`read_binary`, `write_binary`, base64 chunks),
  archives (`create_archive`, `extract_archive` for tar, tar.gz, tar.bz2, tar.xz, zip), screenshots
  (`take_screenshot`), `read_image`, `hash_file`, `diff_files`, `replace_lines`, `replace_in_files`,
  `move_to_trash`, `get_system_info`, `wait_for_process_output`, runtime introspection, and a glob
  filter on `list_directory`;
- no approval step anywhere: writes replace by default, moves and copies replace the destination,
  `replace_in_files` applies immediately, and `dry_run` is opt-in for callers who want a preview;
- `dangerousCommands` defaults to `warn`: a catastrophic command runs and the result carries a note,
  with `allow` for silence and `block` to refuse;
- annotations say what the tools do: 19 read-only, 14 destructive (including the tools that replace a
  destination by default), 2 open-world;
- crash-resistance: a bad shell, a closed stdin, a stream with no newlines, a dead parent, or an
  unparseable `runtime.json` cannot leave a device silently offline;
- `read_process_output` offsets are documented and implemented as zero-based line numbers, ranged
  reads no longer consume the new-output cursor, and reads never sleep over buffered data;
- the contract commands work with no dependencies installed, so CI can diff the advertised tool
  surface against the published tarball.

## 0.2.0

First feature-complete first-party release. ReMCP no longer needs to install an upstream MCP server
on a user's computer.

Tools (23, up from 19):

- add `copy_file` with an explicit `overwrite` flag;
- add `wait_for_process_output` so a model can wait for a pattern instead of polling
  `read_process_output`;
- add read-only `get_runtime_info` and `get_runtime_stats`;
- `edit_block` falls back to whitespace-tolerant matching when the exact block is not found, reports
  when it did, and still refuses ambiguous matches; `allow_fuzzy: false` keeps it strict.

Security:

- `allowedRoots` is now enforced against the resolved real path of the deepest existing ancestor.
  Before this release a symlink inside an allowed root (`<allowed>/link -> /etc`) passed the lexical
  prefix check and allowed reads, writes, searches, and listings outside the allowed directories.
- add a built-in catastrophic-command guardrail (`dangerousCommands: block|warn|allow`) covering
  filesystem formatting, raw block-device writes, repartitioning, host power control, fork bombs,
  root-path recursive deletion, root chmod/chown, history wiping, and Windows disk destruction;
- add `maxWriteBytes` so a single write cannot fill the disk through the relay;
- `kill_process` refuses the ReMCP agent process in addition to pid 1 and the runtime itself;
- blocked-command matching is case-insensitive and whitespace-normalized.

Usage metrics:

- opt-out metrics for tool names, durations, outcomes, and session counts, with a whitelisted event
  schema that cannot carry paths, commands, arguments, or output;
- delivered as an MCP notification to the paired agent only - no telemetry endpoint, no install ping,
  no postinstall script, no third-party processor, no remote feature flags;
- one-time notice on first run, `--describe` reports the state, `remcp telemetry off` disables it.

## 0.1.0

Initial runtime: 19 tools for files, search, terminal sessions, and processes, with one dependency
(`@modelcontextprotocol/sdk`), no postinstall script, and no network calls.
