#!/usr/bin/env bash
# SwiftPM test resources must live inside the package, so the shared vectors in testdata/ are
# copied into the CarbBookCore test bundle. `--check` fails (for CI) if the copies drifted.
#
# Usage: ios/scripts/sync-testdata.sh [--check]
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
dest="$root/ios/CarbBookCore/Tests/CarbBookCoreTests/Resources"
mkdir -p "$dest"
for name in units-vectors.json dose-vectors.json; do
  if [[ "${1:-}" == "--check" ]]; then
    if ! cmp -s "$root/testdata/$name" "$dest/$name"; then
      echo "error: $dest/$name differs from testdata/$name; run ios/scripts/sync-testdata.sh" >&2
      exit 1
    fi
  else
    cp "$root/testdata/$name" "$dest/$name"
  fi
done
echo "testdata vectors in sync"
