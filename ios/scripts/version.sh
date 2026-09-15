#!/usr/bin/env bash
# Print the iOS app's marketing version from ios/project.yml, the single source of truth.
#
# Usage: ios/scripts/version.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
sed -n 's/^ *MARKETING_VERSION: *"\([0-9.]*\)".*/\1/p' ios/project.yml | head -1
