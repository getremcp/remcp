# ReMCP Changelog

Only reviewed release notes are included here. For the complete dated history,
see [GitHub Releases](https://github.com/antonbaider/remcp/releases).

## [v0.2.251](https://github.com/antonbaider/remcp/releases/tag/v0.2.251) — 2026-11-12

**Complete the Windows recovery release with verified native test dependencies.**

- Include the packaged helper loader and native assets in isolated supervisor and installer QA fixtures.
- Keep client/runtime helper inventory metadata aligned with the exact release pair.
- Retain the 0.2.250 Windows quarantine recovery, fixed precompiled interop, pairing preservation and blocked-target holds.
- DLL publisher signing and Kaspersky Premium certification remain unverified; no protection settings are changed.

## [v0.2.250](https://github.com/antonbaider/remcp/releases/tag/v0.2.250) — 2026-11-12

**Recover damaged Windows installations and use packaged, verifiable Windows interop.**

- Replace ten runtime C# compilation definitions with precompiled .NET helpers; no per-operation compiler or generated PowerShell assemblies.
- Verify helper SHA-256 before startup and loading; keep loaded libraries in an immutable per-release store so active Windows Job Objects do not block package replacement.
- Recover a missing Windows updater through a fresh exact newer first-party CLI; preserve pairing, package trust and process ownership.
- Check executable payloads independently of version manifests; verify staged replacements and retain backups on failures.
- Add explicit repair without restart, proven-dead update-lock recovery and persistent holds for blocked replacement payloads.
- Verify runtime entries and native helpers during Windows bootstrap; preserve the independent installer path when the installed executables are unavailable.
- Respect PowerShell policy and remove encoded helper execution. Permissions and authentication remain unchanged.
- Native DLLs are distributed with package/source hashes and currently have no Authenticode publisher signature. Kaspersky Premium compatibility and false-positive classification remain subject to vendor review.

## [v0.2.249](https://github.com/antonbaider/remcp/releases/tag/v0.2.249) — 2026-11-11

**Keep ReMCP devices connected across one missed relay heartbeat.**

- Retry one unanswered WebSocket ping before closing the session, reducing unnecessary disconnects during brief network packet loss.
- Close genuinely silent half-open links after the second missed heartbeat check and reconnect with the existing bounded backoff.
- Preserve device revocation, duplicate-agent protection, authentication and other tool permissions; no server or runtime tool surface changes.
- Align the public dependency lockfile with the patched fast-xml-parser 5.12.0 already locked by the runtime; keep npm audit strict.

## [v0.2.248](https://github.com/antonbaider/remcp/releases/tag/v0.2.248) — 2026-11-10

**Recover interrupted Windows installations without removing foreign launchers or rollback data.**

- Resume Windows installer recovery through uniquely verified staging directories; preserve existing rollback snapshots and the device's original pairing across failures.
- Restrict Windows runtime stopping to proven ReMCP-owned processes; never stop unrelated Node workloads or remove user-customized PowerShell launchers.
- Accept canonical npm 7 PowerShell launcher formatting while rejecting inserted commands and unrecognized comments.
- Keep Linux/macOS already-paired repair flows intact; preserve managed CLI/PATH on ordinary uninstall and require explicit purge for removal.
- Keep runtime tool definitions, authorization, security permissions and release verification unchanged.

## [v0.2.247](https://github.com/antonbaider/remcp/releases/tag/v0.2.247) — 2026-11-10

**Prevent automatic downgrade when repairing a runtime ahead of server rollout.**

- Keep a verified newer local client/runtime release installed when the production version manifest still advertises an older pair.
- Block runtime-repair from installing an older client or runtime during transient unknown/offline runtime states; also reject invalid client package specs.
- Retain recovery of a broken runtime when the server advertises the matching current release.
- Preserve Windows staged-update locks, service supervision, trusted package validation and all existing tool permissions.

## [v0.2.246](https://github.com/antonbaider/remcp/releases/tag/v0.2.246) — 2026-11-10

**Make Windows updates recoverable and status truthful.**

- Stage Windows npm updates in a private .remcp-update-stage- directory while the live client and shims stay intact; validate exact package/version identities, command shim ownership and shared dependency parity before promotion.
- Promote vetted packages in a short locked transaction and roll back on error; retain the original backup when rollback cannot restore everything.
- Report the real Windows Startup supervisor state instead of null, and resolve installed npm versions from the Windows layout so update diagnostics no longer print ?.
- Keep macOS/Linux update paths, credentials and service models unchanged.

## [v0.2.245](https://github.com/antonbaider/remcp/releases/tag/v0.2.245) — 2026-11-10

**Repair installs with the exact client/runtime pair, even from an older release.**

- Converge a local remcp install to the runtime paired with the running client when the saved first-party pin is stale; custom runtime packages remain untouched.
- Keep the Windows bootstrap compatible with npm-generated PowerShell shims across npm formatting changes, refusing only foreign or downloading launchers.
- Keep exact client/runtime pairing, service supervision and update locks unchanged.

## [v0.2.244](https://github.com/antonbaider/remcp/releases/tag/v0.2.244) — 2026-11-10

**Repair the local CLI and service after an uninstall instead of leaving a paired computer stranded.**

- Keep the managed CLI, runtime packages and device pairing on an ordinary remcp uninstall; only --purge removes the managed command.
- Let the official installer repair an already-paired macOS/Linux computer with the existing credentials even when the old remcp command is missing, without consuming a new pairing code.
- Run connect --install as a local repair on an already-paired machine and keep --re-pair as the explicit credential-replacement path.
- Repair installs whose saved configuration predates runtime metadata instead of failing on a missing package spec.
- Repair an outdated current-release Linux systemd unit during remcp update without restarting the live agent.
- Keep exact client/runtime pairing and Windows/macOS update locks unchanged.

## [v0.2.243](https://github.com/antonbaider/remcp/releases/tag/v0.2.243) — 2026-11-09

**Find verified device updates within minutes instead of polling every half hour.**

- Check the signed ReMCP version manifest every five minutes, with a stable device-specific phase to avoid synchronized update spikes.
- Recheck a server-gated rollout within five minutes when a device is not yet eligible; never skip rollout admission or integrity verification.
- Make auto-update status reflect the five-minute check interval and the server-managed fleet rollout rather than hardcoding a 24-hour fleet delay.
- Keep exact client/runtime version pairing, service supervision, Windows/macOS update locks and fail-closed verification unchanged.
- Verify deterministic large-fleet phasing and update eligibility with regression tests.

## [v0.2.242](https://github.com/antonbaider/remcp/releases/tag/v0.2.242) — 2026-11-09

**Repair unattended updates when one Node.js executable serves different npm installations.**

- Identify the running ReMCP supervisor's canonical npm prefix from its owned CLI entry instead of equating identical Node executable paths with identical package installations.
- Install the exact official client and runtime pair into the supervised prefix and re-verify both versions before any service restart. A failed, partial or ambiguous install remains blocked rather than disconnecting the device.
- Preserve existing legacy unpinned/manual update behavior and Windows/macOS update locks; do not touch unrelated Node manager installations.
- Reproduced the 0.2.239-to-0.2.241 split-prefix failure and verified the fixed updater on ASUS: managed service upgraded to 0.2.241/0.2.241, restarted and reconnected.
- Add regression tests for shared-Node/different-prefix, unsafe service paths and idempotent service convergence.

## [v0.2.241](https://github.com/antonbaider/remcp/releases/tag/v0.2.241) — 2026-11-09

**Keep browser diagnostics responsive and avoid leaking process arguments in errors.**

- For an explicit browser-readiness-only computer snapshot, skip unrelated native desktop/session, screen, clipboard, cursor and window probes; full UI snapshots remain unchanged.
- When a failed child process has no diagnostic stderr, report a bounded exit status instead of revealing its command line or script arguments.
- Help agents check CDP readiness first and use native Accessibility when no authorized debuggable tab is available; never auto-launch a browser from read-only inspection.
- Preserve the published 0.2.240 dual-supervisor Linux uninstall safeguards, service status semantics, and regression tests.
- Keep loopback, permissions, command policy, authorization, publishing gates, and platform capabilities unchanged.

## [v0.2.240](https://github.com/antonbaider/remcp/releases/tag/v0.2.240) — 2026-11-08

**Fix Linux ReMCP uninstall after migration from systemd-user to PID-1 systemd.**

- Stop and remove both ReMCP-owned system and legacy user units, rather than leaving a stale user unit behind.
- Preflight both units for ownership, refuse foreign or symlinked unit files, and surface failed service stops or reloads.
- Make status show no supervisor after uninstall and distinguish retained CLI and pairing from a running agent.
- Ordinary uninstall keeps paired credentials and CLI; --purge additionally removes global npm packages.
- Test dual-supervisor cleanup, foreign-unit protection, failed stops, symlinks and isolated CLI uninstall.

## [v0.2.239](https://github.com/antonbaider/remcp/releases/tag/v0.2.239) — 2026-11-08

**Make headless Linux service lifecycle checks portable to unregistered CI user IDs.**

- Preserve the 0.2.238 PID-1 system service, automatic restart, logout independence, and canonical CLI path.
- Ensure test-only synthetic Linux service fixtures do not consult the host passwd database or change logind.
- Keep ordinary service installation fail-closed when system user identity or lingering cannot be verified.
- Retain the checksum-pinned CDN fallback and authenticated exact-byte GitHub Release parity checks.
- Keep macOS LaunchAgent and Windows Startup behavior unchanged; unattended system-level services require separate audited native implementations.

## [v0.2.238](https://github.com/antonbaider/remcp/releases/tag/v0.2.238) — 2026-11-08

**Keep headless Linux ReMCP agents online across logout, SSH disconnect and reboot.**

- Install privileged new Linux headless agents under system systemd with automatic startup and restarts, without tying the agent to a user's login session.
- Ensure existing per-user Linux systemd services have verified logind lingering; fail explicitly when persistent supervision cannot be established.
- Detect managed system units during status, repair, updates, deferred restarts and uninstall, preserving device pairing and preventing duplicate user agents.
- Provide a stable managed Linux remcp command with the same vetted Node.js binary and npm installation prefix as the agent.
- Add focused lifecycle, ownership and CLI regressions without increasing tool permissions or changing runtime capabilities.
- macOS LaunchAgent and Windows Startup remain login-bound; privileged headless implementations require separate native lifecycle and security validation before being advertised.

## [v0.2.237](https://github.com/antonbaider/remcp/releases/tag/v0.2.237) — 2026-11-06

**Keep Windows Session 0 safe and require verified Linux WebRTC worker exit before acknowledging Stop.**

- Distinguish interactive Windows sessions from Session 0 using a bounded process-local readiness probe; unknown readiness fails closed for native UI actions.
- Avoid screenshot, pointer, UIA and recording side effects without an interactive desktop; keep filesystem, terminal, document and independently available browser tools discoverable.
- Cache advertised capability discovery for 2.5 seconds with in-flight coalescing, but recheck readiness on every native desktop mutation or capture.
- Deliver atomic modern MCP tools/list_changed notifications when live capability groups appear or disappear.
- Require the actual Linux WebRTC media worker exit before acknowledging Stop; on an uncertain Stop, deny another capture session and escalate only the owned child after a bounded grace period. The opt-in experimental worker remains disabled by default and has no public media activation.
- Preserve the fleet-safe 0.2.235 updater and 0.2.236 browser readiness/macOS CLI improvements; locked-user secure desktop and background-service transitions remain follow-up validation targets.
- Release only after exact-source public npm/tag parity, native Windows x64/ARM64 verification, protected CI and controlled fleet rollout.
