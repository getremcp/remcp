# ReMCP cryptography and limitations

This page is a **reviewed implementation overview**, not independent
cryptographic certification, a penetration test, proof of all deployment
settings, or a replacement for the [security policy](../SECURITY.md).
ReMCP's hosted backend is developed privately; public users cannot inspect
every backend implementation from this release-only repository.

## Documented security primitives

| Function | Algorithm / implementation | Important constraints |
| --- | --- | --- |
| Opt-in screenshot history | AES-256-GCM through Node.js `node:crypto` | The private backend validates a 32-byte key, uses a fresh 12-byte random nonce and authenticates user/device/capture metadata. Storage without a configured keyring fails closed |
| Encrypted device notes | AES-256-GCM through Node.js `node:crypto` | Separate 32-byte keyring, 12-byte random nonce, authenticated metadata |
| One-time pairing-code envelopes | AES-256-GCM through Node.js `node:crypto` | Domain-separated SHA-256 key derivation and random 12-byte nonce; a secret's **minimum string length does not prove its entropy** |
| Action approvals and web-terminal capabilities | HMAC-SHA-256 through Node.js `node:crypto` | Scoped, expiring signed requests; bounded parsing and constant-time MAC comparison |
| TURN REST temporary credentials | **HMAC-SHA-1**, with HMAC-SHA-256 used for account pseudonyms | The coturn TURN REST interoperability scheme uses HMAC-SHA-1. Never present the project as SHA-1-free |
| File checksum tool | SHA-256 default; optional SHA-1 / MD5 | Legacy hashes serve user-requested **file fingerprint compatibility**, not credential storage or session authentication |

ReMCP uses published primitives and standard cryptographic libraries rather
than implementing its own cipher. OS CSPRNG functions such as
`crypto.randomBytes` and `randomUUID` are used for cryptographic nonces,
key generation and security tokens in the reviewed backend paths.

## What this does not establish

- HTTPS/WSS protects transport, but **does not provide end-to-end
  encryption** between the browser and paired device. Forward secrecy and
  deployed TLS cipher configuration require live verification.
- This overview does not certify third-party dependencies, cloud identity
  services, host entropy, secret rotation or all possible use of SHA-1.
- Current public runtime `v0.2.251` uses PID/time/`Math.random()` for
  **Wayland portal correlation handles** (not cryptographic keys or login
  tokens). A security improvement using 128-bit CSPRNG identifiers is
  developed privately in
  [PR #2548](https://github.com/antonbaider/remcp-full/pull/2548)
  and **has not shipped**; no claim of a released fix is made.
- OpenSSF Best Practices self-assessment and OpenSSF Scorecard are separate
  from ISO/IEC 27001, SOC 2, independent cryptographic assurance or CE marking.
  An in-progress Best Practices badge **does not imply certification**.

Vulnerabilities: use
[confidential GitHub reporting](https://github.com/antonbaider/remcp/security/advisories/new).
Package release origin and signatures must be validated independently.

For technical reviewers, this is a public summary of a source-level evidence
inventory maintained in the private development repository. Claims apply to
the inspected source and may differ from older released agent versions.
