#!/usr/bin/env bash
set -Eeuo pipefail

VERSION="8.30.1"
ARCHIVE="gitleaks_${VERSION}_linux_x64.tar.gz"
SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
URL="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${ARCHIVE}"

repo="$(git rev-parse --show-toplevel)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/remcp-gitleaks.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

curl --fail --silent --show-error --location   --retry 2 --retry-delay 2 --connect-timeout 10 --max-time 60   --output "$tmp/$ARCHIVE" "$URL"
printf '%s  %s\n' "$SHA256" "$tmp/$ARCHIVE" | sha256sum --check --status
tar -xzf "$tmp/$ARCHIVE" -C "$tmp" gitleaks

cd "$repo"
# Check the complete history reachable from the exact checked-out revision.
# A runner may fetch unrelated remote refs during checkout; scanning all refs
# can make an otherwise clean main build fail on another work-in-progress branch.
# PR checkouts still include the candidate commit and all reachable ancestors.
"$tmp/gitleaks" git \
  --redact --no-banner --log-opts=HEAD --exit-code 1 --timeout 120 .
