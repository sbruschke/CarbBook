#!/usr/bin/env bash
# Write /opt/carbbook/.env on the Pi. DEXCOM_API_TOKEN is copied Pi-side from /opt/pi-infra/.env,
# an existing CARBBOOK_TAG is kept. Prints variable names only, never values.
set -euo pipefail

ssh pi 'bash -s' <<'EOF'
set -euo pipefail
umask 077
TOKEN=$(grep -E '^DEXCOM_API_TOKEN=' /opt/pi-infra/.env | cut -d= -f2-)
[ -n "$TOKEN" ] || { echo "DEXCOM_API_TOKEN missing from /opt/pi-infra/.env" >&2; exit 1; }
TAG_LINE=$(grep -E '^CARBBOOK_TAG=' /opt/carbbook/.env 2>/dev/null || echo 'CARBBOOK_TAG=latest')
{
  echo 'TZ=America/Chicago'
  printf 'DEXCOM_API_TOKEN=%s\n' "$TOKEN"
  echo "OFF_USER_AGENT='CarbBook/0.1 (https://recipes.dxshdw.dev)'"
  echo "$TAG_LINE"
} > /opt/carbbook/.env.new
mv /opt/carbbook/.env.new /opt/carbbook/.env
stat -c '%a %U' /opt/carbbook/.env
cut -d= -f1 /opt/carbbook/.env | sort | tr '\n' ' '; echo
EOF
