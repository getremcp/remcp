# Verify ReMCP release asset signatures

The canonical public download URL is https://github.com/antonbaider/remcp/releases
(currently redirects on GitHub to `getremcp/remcp`).

For releases that include `SHA256SUMS` and `SHA256SUMS.sigstore.json`,
the checksums bind the four downloaded release payloads to a keyless
Sigstore signature made using GitHub's short-lived OIDC identity.

**Important limitation:** Signing a pre-existing release authenticates the
published bytes *at the time of signing*. It does not retroactively prove
where or how those bytes were built. npm packages have separately verified
npm registry attestations; do not confuse these with a signature of GitHub
Release ZIP downloads or with ISO/IEC 27001 certification.

## Verify on Linux or macOS

Install current official [GitHub CLI](https://cli.github.com/) and
[Sigstore Cosign](https://docs.sigstore.dev/cosign/system_config/installation/)
using your platform's trusted package manager. Then use a fresh directory:

```bash
mkdir -p remcp-verify && cd remcp-verify
gh release download v0.2.251 -R antonbaider/remcp
sha256sum -c SHA256SUMS
cosign verify-blob SHA256SUMS \
  --bundle SHA256SUMS.sigstore.json \
  --certificate-identity 'https://github.com/getremcp/remcp/.github/workflows/release-signatures.yml@refs/heads/main' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
```

For other release tags, substitute the exact tag. All four payloads must
be present and their hashes must match. The Sigstore certificate identity
is the canonical GitHub owner after the public repository redirect.
Do not trust a signature if its verified identity or issuer differs.

Signed payloads are:
- `chatgpt-app-submission.json`
- `remcp-openai-existing-plugin.zip`
- `remcp-plugin.zip`
- `remcp-skills-only.zip`

`SHA256SUMS` and its signature are published by the dedicated release
signer on successful OIDC verification. Releases without both files have
not been signed through this mechanism and must not be presented as such.

To report vulnerabilities confidentially, use the
[private ReMCP security advisory form](https://github.com/antonbaider/remcp/security/advisories/new).
