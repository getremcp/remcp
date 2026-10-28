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


### Encrypted screenshot retention

The default view-only screenshot action never persists PNG bytes in PostgreSQL.
When a user explicitly enables seven-day history, ReMCP encrypts the PNG with
AES-256-GCM before inserting the device_screenshots.image_png BYTEA. The
authenticated ciphertext binds the user ID, device ID and capture timestamp.
No encryption keys are stored in PostgreSQL, Redis or Git.

Retention requires REMCP_SCREENSHOT_KEYRING_FILE pointing to a mounted JSON
secret. An invalid configured keyring fails startup. An absent optional
keyring disables persistence without disabling one-shot screenshots.
All backend replicas must share the same keyring. Keep older keys in
that keyring until all captures encrypted with them have expired.

Provision once on a trusted host; do not print keys to logs or commit them:

    umask 077
    node scripts/create-screenshot-keyring.mjs /opt/remcp-backend/secrets/screenshot_keyring.json v1
    chgrp remcp-secrets /opt/remcp-backend/secrets/screenshot_keyring.json
    chmod 0440 /opt/remcp-backend/secrets/screenshot_keyring.json

Match the protected group-readable secret permissions used by the existing
backend Docker deployment. Never make this file world-readable.

Configure deployment before promotion:

    REMCP_SCREENSHOT_KEYRING_HOST_FILE=/opt/remcp-backend/secrets/screenshot_keyring.json
    REMCP_SCREENSHOT_KEYRING_CONTAINER_FILE=/run/secrets/screenshot_keyring

The Compose service mounts the keyring read-only. Maintain a separately
protected recovery copy, never alongside database snapshots.

Old PNG captures remain readable until migrated or seven-day expiry. Do not
re-encrypt plaintext rows during rolling deployment. Once all replicas are
stable on the encryption-capable code, count legacy rows:

    node scripts/encrypt-legacy-screenshots.mjs --dry-run

After an approved rollback window, migrate bounded batches:

    node scripts/encrypt-legacy-screenshots.mjs --execute --limit=100

Rollback to an older backend cannot display encrypted screenshots. Plan for
that short-lived screenshot-history compatibility and do not rush the data
migration. Old PostgreSQL/WAL backups may still contain plaintext images
until those backups expire under the separately managed backup policy.


For key rotation, first distribute a ring containing both old and new keys to
all replicas while keeping the old key active; only then switch the active ID
in a second rolling deployment. Remove the old key only after every capture
written with it has expired or been re-encrypted. Never reuse key IDs.


On the production backend inspected on 2026-10-28, the PostgreSQL backup
service defaulted to 14 days of local dumps; the Storage Box rotation policy
retains daily and up to eight weeks of weekly archives. These are separate
from the screenshot table's seven-day active-data TTL. Historical backups
made before encryption may therefore contain earlier plaintext captures
until the relevant backup archives and provider snapshots expire. A
restored pre-encryption database must not be exposed publicly without
reapplying the screenshot-encryption migration or removing old captures.
