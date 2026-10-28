# Security Policy

ReMCP provides remote access to paired computers through MCP. Treat every ReMCP deployment as privileged infrastructure.

## Reporting a vulnerability

Please do not open a public issue for vulnerabilities that could expose credentials, authentication bypasses, cross-tenant access, remote command execution outside the intended tool boundary, or sensitive device data.

Report security issues privately to the project maintainer through GitHub's private vulnerability reporting for this repository when available.

Include the affected version, a concise reproduction, expected versus observed behavior, and any relevant logs with credentials removed.

## Supported versions

Security fixes are applied to the latest released version. Users should update both the central server and device agent when a security release is published.

## Operational guidance

Use HTTPS/WSS, keep device credentials private, revoke devices that are lost or retired, and review mutating MCP actions before approval. Never commit `.env` files, OAuth tokens, Firebase Admin private keys, or device credentials.
## User file and screenshot privacy

The workspace file manager reads or streams files from the device on demand. ReMCP does
not create a server-side document library or store file contents in PostgreSQL.
The authenticated backend and device relay do process file bytes in transit. This is
not end-to-end encryption between a browser and its paired device.

Downloads use user- and device-bound, expiring tickets. Absolute device paths are
sent in authenticated POST request bodies, not download URLs or normal access logs.
Temporary MCP App file, image, and terminal previews can be held in the shared
Redis cache for up to two minutes; applications and infrastructure operators must
protect that cache, logs, and any memory dumps.

A manual diagnostic screenshot is returned to the requesting browser without
database persistence by default. Users may explicitly opt in to storing one
capture in their device history (up to 24 per device, for at most seven days),
and may delete their saved screenshots from active PostgreSQL storage.
Database backups may follow a separate retention schedule; deleting an active
row does not retroactively erase backups. Diagnostic numeric samples are separate.

God Mode is a deliberate, locally authorized power-user feature. It must not
be silently disabled by remote services, and it never grants privileges beyond
the OS identity running the device agent. Owners should run privileged agents
only on trusted machines and carefully review AI-triggered operations: prompt
injection and account compromise are still relevant threats.
