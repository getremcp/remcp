#!/usr/bin/env bash
set -Eeuo pipefail

VERSION="8.30.1"
ARCHIVE="gitleaks_${VERSION}_linux_x64.tar.gz"
SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
URL="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${ARCHIVE}"

repo="$(git rev-parse --show-toplevel)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/remcp-gitleaks.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

# GitHub's release-download CDN intermittently returns 504 on hosted runners.
# The immutable release asset is also available from GitHub's REST API. Both
# paths must produce the same independently pinned SHA-256; fail closed otherwise.
if ! curl --fail --silent --show-error --location --retry 2 --retry-delay 2 \
  --connect-timeout 10 --max-time 60 --output "$tmp/$ARCHIVE" "$URL"; then
  printf 'Gitleaks CDN unavailable; retrying the same pinned asset via GitHub API.\n' >&2
  curl --fail --silent --show-error --location --retry 3 --retry-all-errors \
    --connect-timeout 10 --max-time 90 \
    -H 'Accept: application/octet-stream' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    --output "$tmp/$ARCHIVE" \
    https://api.github.com/repos/gitleaks/gitleaks/releases/assets/378332058
fi
printf '%s  %s\n' "$SHA256" "$tmp/$ARCHIVE" | sha256sum --check --status
tar -xzf "$tmp/$ARCHIVE" -C "$tmp" gitleaks

cd "$repo"
# Check the complete history reachable from the exact checked-out revision.
# A runner may fetch unrelated remote refs during checkout; scanning all refs
# can make an otherwise clean main build fail on another work-in-progress branch.
# PR checkouts still include the candidate commit and all reachable ancestors.
"$tmp/gitleaks" git \
  --redact --no-banner --log-opts=HEAD --exit-code 1 --timeout 120 .
