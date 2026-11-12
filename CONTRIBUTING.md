# Contributing to ReMCP

Thanks for helping improve ReMCP. This public repository contains the distributable device client, local runtime, MCP/plugin manifests, skills, and release documentation.

## Before you start

`antonbaider/remcp` (currently redirected to `getremcp/remcp`) is a generated, release-only projection. Development, review and CI preflight happen in the private `antonbaider/remcp-full` source repository. Pull requests and non-release development branches are disabled in this public repository. The maintainers project only reviewed release artifacts onto public `main` and publish immutable `v*` tags.

For bugs and feature requests, open a GitHub issue. For security vulnerabilities, use GitHub private vulnerability reporting instead of a public issue.

## Local checks

ReMCP requires Node.js 22.5 or newer.

```bash
npm ci
npm run check
npm test
npm audit --omit=dev
npm pack --dry-run --workspace @remcp/remcp
npm pack --dry-run --workspace @remcp/runtime
```

**Test policy:** Each substantial new feature, changed security boundary, and security fix must add or update automated tests covering the intended behavior and relevant failure/permission cases. Execute `npm run check` and `npm test` against the exact candidate in the private development repository; validate native Windows/macOS behavior on suitable devices when applicable. Review test evidence before promoting a public release, and describe user-visible behavior and security fixes in the corresponding GitHub Release notes. Changes to release-only metadata must have public export/CI contract tests.

The public repository does not contain the hosted ReMCP server or its Docker image, so server/Docker checks do not apply here.

## Change proposals

Public pull requests are disabled. Open a public issue for non-sensitive defects or feature proposals; maintainers will evaluate them in the private development repository. Never post security findings, confidential code or credentials in issues. Use private vulnerability reporting for security concerns.

Automated Dependabot proposals in this release-only repository are dependency-monitoring inputs, not a public development or merge path. Apply verified updates to `antonbaider/remcp-full`, test on ASUS, and publish only through the existing reviewed release projection. Never directly merge automated dependency PRs into public `main`.

Do not publish credentials, `.env` files, OAuth tokens, device tokens, private host details, or captured user data. Preserve path confinement, tenant isolation, least-privilege tool annotations, and the distinction between read-only and mutating operations.
