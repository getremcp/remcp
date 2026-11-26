# Device-to-client encryption

ReMCP supports authenticated [RFC 9180 HPKE](https://www.rfc-editor.org/rfc/rfc9180) between a paired device and an independently trusted local MCP client or browser. HPKE is opt-in through owner-approved enrollment of the paired device and client. The owner's screen page selects encrypted control first. The negotiated encrypted tool path sends opaque ciphertext through the hosted relay. In the standard path, ordinary MCP/workspace calls use HTTPS/WSS transport security and the backend can process their plaintext. An installed E2EE identity does not change that default.

The encrypted tool path uses authenticated P-256 DHKEM, HKDF-SHA256 and AES-256-GCM to protect tool requests, arguments, results and errors. Device identity, pairing binding, direction, session, call, boot epoch and chunk metadata are authenticated. Application-level replay ledgers, expiry, chunk limits and duplicate-call rejection are implemented; HPKE **alone** does not provide replay protection.

## Which traffic is protected?

| Path | Protection | Can the hosted relay/backend access tool payload plaintext? |
| --- | --- | --- |
| Hosted ChatGPT/MCP, workspace file transfer, terminal, browser inspection, diagnostics, telemetry, Docker and Kubernetes | HTTPS/WSS (TLS) | **Yes**; not device-to-client E2EE |
| Independently enrolled local `remcp mcp --device <UUID>` client | Authenticated HPKE for encrypted tool requests/results, inside TLS | **No**, for requests actually using the encrypted bridge; the authorized client and device can read them |
| Browser encrypted device tools | Browser/device HPKE after independent pinning and enrollment | **No**, for a successfully verified encrypted operation; delivered browser JavaScript and endpoint remain trusted |
| Vision+ screen media | WebRTC DTLS-SRTP; TURN forwards media ciphertext | Media transport encryption is **not** evidence of HPKE protection for other workspace tool calls |
| Encrypted desktop control/SDP | Authenticated HPKE on enrolled control RPC/SDP; WebRTC on media | Only the approved encrypted control path has HPKE protection |
| Account, device inventory, access rules and usage history | HTTPS/WSS and server access controls | **Yes**; this information is required by the service |
| Server-side encrypted notes or saved screenshots | Backend-managed encryption at rest | **Yes**, after authorized server-side decryption; not device-to-client E2EE |

The service can still observe device identity/membership, routing, traffic timing, packet length and transport state. E2EE does not protect data after an authorized client/device decrypts it, stop a compromised endpoint or make a browser immune to malicious same-origin JavaScript.

**Release boundary:** the stricter per-tool read grants below describe this source revision. Earlier installed releases (including `v0.2.263`) may permit an unscoped read peer to use tools marked `readOnlyHint:true`; upgrade to a verified release containing the hardening before relying on the new fail-closed behavior. Do not claim the change is deployed merely because it exists in a Draft PR.

## Enroll the device and client

On supported signed-in desktops, the paired agent attempts to create its OS-vault identity automatically. The first browser or AI-client enrollment still requires **explicit owner approval on that device**: compare the short code in the local native dialog with the independently computed browser/client code. No manual full-fingerprint copying is needed for this automatic path, and a successful encrypted tool proof is required before a device pin is saved. Existing approved clients reconnect without another trust prompt; revocation and unexpected key changes fail closed. The private identity is held by macOS Keychain, Windows CurrentUser DPAPI or Linux Secret Service. An established identity, or a first start with `requireE2ee:true`/`REMCP_REQUIRE_E2EE=1`, waits for the owner to unlock the OS vault instead of repeatedly restarting or silently downgrading. An unexpected pairing change or invalid policy fails closed even when E2EE is otherwise optional. Missing or changed identities cannot be replaced without deliberate rotation.

Linux GNOME uses Zenity for the local prompt; if Zenity is absent, KDE Plasma can use KDialog. A headless Linux host or an owner session without either dialog cannot automatically approve a new browser: use the owner-private local CLI, with a working Secret Service, instead. macOS and Windows likewise require an interactive owner session for first approval; unattended trust grants are never allowed. The published v0.2.265 agent supports automatic OS-backed device identity and native browser comparison where the owner session provides an available dialog and vault.

For advanced manual enrollment or recovery, the paired owner may run `remcp e2ee init` and independently compare the full fingerprint. Re-pairing changes the key binding and requires explicit `remcp e2ee rotate` and fresh peer trust.

On the computer hosting the AI MCP client:

```sh
remcp e2ee client-init
remcp e2ee client-pin --device <UUID> --public-key <DEVICE_PUBLIC_KEY> --fingerprint <DEVICE_FINGERPRINT>
```

Compare the client fingerprint independently, then approve that public key locally on the paired device:

```sh
remcp e2ee trust --public-key <CLIENT_PUBLIC_KEY> --fingerprint <CLIENT_FINGERPRINT> --mode read --tools get_system_info
```

The minimal enrollment above permits system information. A **read** grant must match three checks: ReMCP's fixed basic-status allowlist, the locally approved `--tools` scope, and the runtime's `readOnlyHint:true` annotation. On v0.2.265 the fixed read set covers `get_system_info` and `desktop_webrtc_status`. The browser checks an authenticated `get_system_info` response before showing verified encryption.

For device operations outside that fixed read set, such as file reading and terminal tools, a locally approved `--mode control` peer can be limited to the exact tool names the owner authorizes. [MCP tool annotations are behavior hints](https://modelcontextprotocol.io/specification/2026-07-28/server/tools). Authorization requires the owner's grant and the runtime's OS permissions. Older unscoped read grants fail closed and require local reapproval.

Authorize the local client with `remcp e2ee client-login --device <UUID>`, then configure the AI application to launch `remcp mcp --device <UUID>` as its stdio MCP server. OAuth uses the canonical issuer `https://remcp.site`, PKCE, a loopback callback and the resource `https://mcp.remcp.site/mcp`. Tokens stay in the client's OS vault. The local bridge decrypts tool results **before handing them to the AI host**; this is not confidentiality against that authorized host.

The local bridge negotiates `x-remcp-encrypted-client: remcp-hpke-auth-p256-v1` with the resource server. That authenticated capability selects an opaque transport-only catalog. The local bridge decrypts the device catalog and returns actual device tools and structured results to the AI application. The header grants no additional authorization and is unavailable to the review scope. A generic hosted MCP connection does not gain endpoint encryption merely by connecting to an HTTPS subdomain.

## Browser enrollment and desktop

Open the device's encryption settings in the authenticated workspace. The browser creates a nonexportable ECDH key in IndexedDB, isolated by account and device. Select the required permission and click **Connect securely**. Compare the short authorization code with the native dialog on the paired computer, then explicitly allow it there. The browser pins the device key only after authenticating an encrypted device response, not on an untrusted relay acknowledgment. The same trusted browser reconnects automatically; changing the device key requires a fresh local approval. Cancelling an in-progress request sends a separate owner-authenticated cancellation to the agent: it closes the pending local prompt, invalidates that request nonce, and aborts any unfinished browser pin transaction. On the device, cancellation also aborts a locally approved request **while it is still waiting for the OS-vault lock or key validation**; the grant write rechecks the cancellation/expiry immediately before committing. Once the OS-vault write has begun it cannot be rolled back safely, and cancellation returns `cancelled:false` all the way through the hosted HTTP/MCP relay instead of being disguised as a transport error. This remains true if the OS-vault API loses its write acknowledgement: the device cannot assume the peer was not saved. The response never grants remote revocation authority. If the device already saved a grant before cancellation, the agent also returns `cancelled:false` during the enrollment validity window; **Cancel does not revoke that grant**. Use the device-local E2EE peer revocation action. Browser private keys remain local. Revoking local browser storage removes that browser identity; revoke its grant on the device too.

The browser crypto endpoint depends on the integrity of the application JavaScript delivered to it. The local stdio client offers an independently installed endpoint. Encryption does not hide device membership, traffic timing, packet sizes or the outer transport operation from the service.

For native screen capture, install the optional source-only worker with `remcp desktop install --python <absolute path to trusted Python 3.11–3.14>`. Dependencies install into an owner-private virtual environment using the package's pinned wheel hashes. macOS Screen Recording, the Windows interactive desktop and Linux Wayland portal consent remain required. X11 uses the logged-in owner's local display and private Xauthority file; remote displays and XWayland overrides are refused. Installation does not start capture. `remcp desktop status` reports availability; `remcp desktop off` disables media.

Screen preview selects encrypted control for the owner. A standard connection requires its own explicit confirmation scoped to the current account and device. Opening the page or navigating to a standard deep link grants neither the standard transport nor capture. Starting any control session still requires separate owner consent. SDP and input commands travel through HPKE. Native WebRTC uses DTLS-SRTP; TURN relays media packets. ICE server allocation uses authenticated HTTPS. Control requires the same active native session and increasing sequence numbers. Stop closes the media worker, waits for its process exit and queued input completion, and rejects subsequent input. Clipboard reads preserve exact text and reject values exceeding the bounded transfer limit.

## Strict policy and revocation

`remcp e2ee require` persists `requireE2ee:true` in owner-private configuration and reloads the managed agent. `REMCP_REQUIRE_E2EE=1` also requires encryption. On strict first boot, the owner OS vault identity is initialized automatically once the vault is accessible; this is **not** permission to trust any client. Existing identities are never automatically replaced. Strict startup accepts only authenticated encrypted calls from locally pinned peers and rejects ordinary plaintext tool dispatch. `remcp e2ee off` clears the persisted requirement but cannot override the environment requirement.

Trust, revocation and identity rotation use an owner-private cross-process OS-vault write lock. Simultaneous local operations are serialized so a stale grant cannot restore a revoked key. If another owner process holds the lock beyond the bounded wait, the change fails closed; ReMCP never steals an unknown lock from a potentially active process. After an interrupted operation, inspect active ReMCP processes and the owner-private `.e2ee-vault-write.lock` directory before any manual recovery. No private keys are stored in this lock directory.

The agent rechecks pairing and policy before requests, outbound responses and heartbeat/reconnect. Invalid configuration or changed pairing closes admission. A permanent account/device revocation stops the runtime. A new plaintext request that strict policy refuses receives a constant, non-sensitive error on the same authenticated session and never reaches the runtime; it does not terminate the WebSocket, so valid encrypted calls are not interrupted. A policy that tightens while an already admitted plaintext call is in flight still suppresses that result and closes the TLS-only session. `remcp e2ee peers` lists grants and `remcp e2ee revoke --fingerprint <CLIENT_FINGERPRINT>` removes a peer and reloads the agent. Revocation cannot undo side effects already performed or retract plaintext already delivered to the authorized endpoint.

`remcp e2ee status` reports **local configuration**, not proof that the current tool call is encrypted. If it reports `identityConfigured:false` and `available:false`, the client/device identity was not activated; automatic setup needs a complete pairing and an accessible owner OS vault. On headless Linux without an unlocked Secret Service there is no secure unattended plaintext-file fallback. Avoid requiring E2EE on such an agent until it has an available identity, approved client and verified encrypted tool round trip. In the current CLI, `liveSessionVerified:false` is returned even when a usable key is present; `transport:remcp-hpke-auth-p256-v1` means the device identity is available, **not** that every open session uses HPKE. Similarly, `required:false` allows legacy TLS-only tool dispatch. Do not treat `available:true` as E2EE verification.

To verify a particular browser session, independently pin both fingerprints, grant the browser locally, and use **Verify encrypted connection** to complete a real authenticated encrypted request. For a local AI client, require a successful encrypted `remcp mcp --device <UUID>` tool round trip with the pinned device; an HTTPS success or fetched public key alone is insufficient. Verify behavior again after rotation, re-pairing or changes to the client/agent. Only enable `remcp e2ee require` after all necessary clients have passed this test: it can disconnect existing TLS-only clients.

Losing the OS-vault key requires explicit rotation and re-enrollment; do not copy private identities between accounts or re-pairings.

### Owner-local E2EE pressure diagnostics

On a running Linux or macOS agent with the private owner-local approval socket available, run `remcp e2ee pressure`. The JSON snapshot contains only numeric counters: pending uploads, cached results, executed-call entries, retained buffered bytes, the buffer limit, and a cumulative count of rejected packet-handler calls for the current agent process. Expired entries are swept before sampling. Buffered bytes describe retained upload, active request and result accounting, not total process heap or RSS. The rejection counter excludes ordinary encrypted tool-error results; it resets when the agent process restarts. No keys, peer/session IDs, payloads, or per-call timing are returned. For local monitoring, use remcp e2ee pressure --prometheus to emit the same fixed, label-free gauges and counter in Prometheus text format. Nothing is uploaded to the hosted relay or exposed via a network metrics endpoint. Windows retains the existing fail-closed local approval transport policy: this CLI diagnostic is unavailable there until a verified owner-only IPC transport is implemented. Unavailable or stopped local sockets fail rather than reporting a misleading zero.


## Cryptographic limitations and assurance claims

- **No recipient-compromise forward secrecy:** RFC 9180 Section 9.7.4 explicitly states that HPKE does not protect historical ciphertexts if the recipient's long-term private key is later compromised. The per-message ephemeral sender encapsulation, random packet nonce and replay checks do not change this. A future, separately reviewed session-ratchet/ephemeral recipient-key design would be necessary for that threat model.
- **Security-strength ceiling:** AES-256-GCM uses a 256-bit symmetric key, but P-256 key establishment provides roughly **128 bits of classical security** (NIST SP 800-186 and SP 800-57). Do not advertise the whole E2EE protocol as 256-bit strength solely because AES-256 is used.
- **No post-quantum security claim:** the deployed P-256 public-key exchange is classical. NIST [FIPS 203 (ML-KEM)](https://csrc.nist.gov/pubs/fips/203/final) is a separate post-quantum standard; adopting a versioned, reviewed hybrid protocol remains future work.
- **No FIPS 140-3 validation or external certification claim:** using AES-256-GCM or a published standard does not prove that a particular packaged cryptographic module is validated. This audit is not a cryptographic certification or penetration test.
- **Browser and relay trust differ:** HPKE prevents the relay from decrypting enrolled tool payloads; the authenticated browser origin can still run JavaScript on the client's behalf and handle decrypted results. Independent local stdio clients have a different application-delivery trust boundary.

## Verification

Focused tests cover HPKE authentication, wrong pins, replay, metadata tampering, chunks, once-only execution, read grants, pairing binding, native vault persistence, policy tightening, relay ownership, OAuth client negotiation and the stdio bridge. Native media and actual browser tests additionally exercise decoded frames, clipboard restoration, consent and Stop. Report per-device native and WAN evidence separately; an offline device or a local ICE-only test is not evidence of cross-platform WAN success.


### AI client native comparison (0.2.272 candidate)

New AI bridge enrollment requires a native comparison window on the local
client and scoped approval on the paired device. Compare the same code on
both screens. The relay response alone cannot authorize a pin. The client
requires an authenticated encrypted read-only `get_system_info` result and
explicit local confirmation within the bounded enrollment deadline.

The encrypted client vault first stores a non-trusted recovery candidate,
then a local-comparison receipt bound to that exact nonce, endpoint and key,
then the trusted pin. After interruption, recovery additionally requires
fresh encrypted proof for the same key. Older pending records without the
receipt cannot automatically become trusted. Revoke any committed grant on
the paired device, wait for pending expiry, deliberately forget and re-enroll.
A declined or unavailable dialog never grants a new client pin. Cancellation
is attempted, but an ambiguous cancellation cannot establish remote revocation;
retain the recovery record. Saved trusted pins continue to work unchanged.
No plaintext fallback is allowed. Native dialog tests using subprocess
fixtures are not evidence of real OS consent or WAN capture termination.
