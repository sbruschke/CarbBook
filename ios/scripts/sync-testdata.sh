#!/usr/bin/env bash
# SwiftPM test resources must live inside the package, so the shared vectors in testdata/ are
# copied into the CarbBookCore test bundle. `--check` fails (for CI) if the copies drifted.
#
# Usage: ios/scripts/sync-testdata.sh [--check]
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
core_dest="$root/ios/CarbBookCore/Tests/CarbBookCoreTests/Resources"
kit_dest="$root/ios/CarbBookKit/Tests/CarbBookKitTests/Resources"
mkdir -p "$core_dest" "$kit_dest"

sync_one() {
  local name="$1" dest="$2"
  if [[ "${3:-}" == "--check" ]]; then
    if ! cmp -s "$root/testdata/$name" "$dest/$name"; then
      echo "error: $dest/$name differs from testdata/$name; run ios/scripts/sync-testdata.sh" >&2
      exit 1
    fi
  else
    cp "$root/testdata/$name" "$dest/$name"
  fi
}

for name in units-vectors.json dose-vectors.json goal-vectors.json image-stack-vectors.json accountability-vectors.json; do
  sync_one "$name" "$core_dest" "${1:-}"
done
for name in number-parse-vectors.json; do
  sync_one "$name" "$kit_dest" "${1:-}"
done
echo "testdata vectors in sync"
