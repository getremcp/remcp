# Contributing to ReMCP

Thanks for helping improve ReMCP. This public repository contains the distributable device client, local runtime, MCP/plugin manifests, skills, and release documentation.

## Before you start

`antonbaider/remcp` is a generated release projection. Changes are reviewed in the project source of truth and then exported here for releases. Public pull requests are still useful as concrete proposals, but maintainers may port an accepted change into the source repository and regenerate this repository rather than merging the public branch verbatim.

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

The public repository does not contain the hosted ReMCP server or its Docker image, so server/Docker checks do not apply here.

## Pull requests

Keep changes small and explain which public package, tool contract, plugin manifest, skill, or document is affected. Include the checks you ran and call out compatibility or security implications.

Do not commit credentials, `.env` files, OAuth tokens, device tokens, private host details, or captured user data. Preserve path confinement, tenant isolation, least-privilege tool annotations, and the distinction between read-only and mutating operations.
