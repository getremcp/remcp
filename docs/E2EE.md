# Device-to-client encryption

ReMCP supports authenticated RFC 9180 HPKE between a paired device and an explicitly trusted local MCP client or browser. The relay forwards opaque packets. P-256 authenticated DHKEM, HKDF-SHA256 and AES-256-GCM protect tool requests, arguments, results, errors and native WebRTC SDP. Device identity, pairing binding, direction, session, call, boot epoch and chunk metadata are authenticated. Bounded replay ledgers, expiry and chunk limits fail closed.

## Enroll the device and client

On the paired computer run `remcp e2ee init`. Store and compare its full fingerprint over an independent trusted channel. The private identity is protected by macOS Keychain, Windows CurrentUser DPAPI or Linux Secret Service; a locked or unavailable vault does not fall back to plaintext storage. Re-pairing changes the binding and requires explicit `remcp e2ee rotate` and fresh peer trust.

On the computer hosting the AI MCP client:

```sh
remcp e2ee client-init
remcp e2ee client-pin --device <UUID> --public-key <DEVICE_PUBLIC_KEY> --fingerprint <DEVICE_FINGERPRINT>
```

Compare the client fingerprint independently, then approve that public key locally on the paired device:

```sh
remcp e2ee trust --public-key <CLIENT_PUBLIC_KEY> --fingerprint <CLIENT_FINGERPRINT> --mode read
```

Use `--mode control` only when the AI client should be allowed to operate the computer. Read grants enforce the device's read-only tool annotations. Authorize the local client with `remcp e2ee client-login --device <UUID>`, then configure the AI application to launch `remcp mcp --device <UUID>` as its stdio MCP server. OAuth uses the canonical issuer `https://remcp.site`, PKCE, a loopback callback, and the resource `https://mcp.remcp.site/mcp`. Tokens stay in the client's OS vault.

The local bridge negotiates `x-remcp-encrypted-client: remcp-hpke-auth-p256-v1` with the resource server. That authenticated capability selects an opaque transport-only catalog. The local bridge decrypts the device catalog and returns actual device tools and structured results to the AI application. The header grants no additional authorization and is unavailable to the review scope. A generic hosted MCP connection does not gain endpoint encryption merely by connecting to an HTTPS subdomain.

## Browser enrollment and desktop

Open the device's encryption settings in the authenticated workspace. The browser creates a nonexportable ECDH key in IndexedDB, isolated by account and device. Verify and pin the device fingerprint independently, then approve the displayed browser public key on the device. Browser private keys remain local. Revoking local browser storage removes that browser identity; revoke its grant on the device too.

The browser crypto endpoint depends on the integrity of the application JavaScript delivered to it. The local stdio client offers an independently installed endpoint. Encryption does not hide device membership, traffic timing, packet sizes or the outer transport operation from the service.

For native screen capture, install the optional source-only worker with `remcp desktop install --python <absolute path to trusted Python 3.11–3.14>`. Dependencies install into an owner-private virtual environment using the package's pinned wheel hashes. macOS Screen Recording, the Windows interactive desktop and Linux Wayland portal consent remain required. X11 uses the logged-in owner's local display and private Xauthority file; remote displays and XWayland overrides are refused. Installation does not start capture. `remcp desktop status` reports availability; `remcp desktop off` disables media.

Choose encrypted remote control in the device workspace and explicitly approve control. SDP and input commands travel through HPKE. Native WebRTC uses DTLS-SRTP; TURN relays media packets. ICE server allocation uses authenticated HTTPS. Control requires the same active native session and increasing sequence numbers. Stop closes the media worker, waits for its process exit and queued input completion, and rejects subsequent input. Clipboard reads preserve exact text and reject values exceeding the bounded transfer limit.

## Strict policy and revocation

`remcp e2ee require` persists `requireE2ee:true` in owner-private configuration and reloads the managed agent. `REMCP_REQUIRE_E2EE=1` also requires encryption. Strict startup needs an initialized vault identity and accepts only authenticated encrypted calls from locally pinned peers; it rejects ordinary plaintext tool dispatch. `remcp e2ee off` clears the persisted requirement but cannot override the environment requirement.

The agent rechecks pairing and policy before requests, outbound responses and heartbeat/reconnect. Invalid configuration or changed pairing closes admission. A permanent account/device revocation stops the runtime. `remcp e2ee peers` lists grants and `remcp e2ee revoke --fingerprint <CLIENT_FINGERPRINT>` removes a peer and reloads the agent. Revocation cannot undo side effects already performed or retract plaintext already delivered to the authorized endpoint.

`remcp e2ee status` distinguishes configured policy, local identity availability and live session evidence. Configuration alone never proves a successful encrypted call. Losing the OS-vault key requires explicit rotation and re-enrollment; do not copy private identities between accounts or re-pairings.

## Verification

Focused tests cover HPKE authentication, wrong pins, replay, metadata tampering, chunks, once-only execution, read grants, pairing binding, native vault persistence, policy tightening, relay ownership, OAuth client negotiation and the stdio bridge. Native media and actual browser tests additionally exercise decoded frames, clipboard restoration, consent and Stop. Report per-device native and WAN evidence separately; an offline device or a local ICE-only test is not evidence of cross-platform WAN success.
