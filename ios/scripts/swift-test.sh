#!/usr/bin/env bash
# Runs `swift test` for one package under ios/: natively when a Swift toolchain is on PATH,
# otherwise inside Docker (image built from ios/docker/Dockerfile on first use).
#
# Usage: ios/scripts/swift-test.sh <CarbBookCore|CarbBookKit> [swift test args...]
set -euo pipefail
ios="$(cd "$(dirname "$0")/.." && pwd)"
pkg="${1:?usage: swift-test.sh <package> [args...]}"
shift
if command -v swift >/dev/null 2>&1; then
  cd "$ios/$pkg"
  exec swift test "$@"
fi
image="${CARBBOOK_SWIFT_IMAGE:-carbbook-swift:6.3.3}"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker build -q -t "$image" "$ios/docker" >/dev/null
fi
# Run as the calling user so .build-linux stays writable; HOME=/tmp gives SwiftPM a cache dir.
exec docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$ios:/ios" -w "/ios/$pkg" "$image" \
  swift test --scratch-path "/ios/$pkg/.build-linux" "$@"
