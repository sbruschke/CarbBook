#!/usr/bin/env bash
# CarbBook deploy smoke test over the public hostname (spec §10). Prompts for the password; never stores it.
#   deploy/smoke.sh <username>                        health, web, login, me, bg, usda, sync push+pull of a sentinel food
#   deploy/smoke.sh <username> --login-only           health, web, login, me, bg
#   deploy/smoke.sh <username> --tombstone <food-id>  soft-delete the sentinel pushed earlier (push deleted=1, pull)
#   deploy/smoke.sh --rate-limit                      6 bad logins for a throwaway username: 401 x5 then 429 (+ forged CF-Connecting-IP)
set -euo pipefail

BASE=${BASE:-https://recipes.dxshdw.dev}
say() { printf '%-9s %s\n' "$1" "$2"; }
json_login() { python3 -c 'import json, os; print(json.dumps({"username": os.environ["SMOKE_USER"], "password": os.environ["SMOKE_PW"]}))'; }

if [ "${1:-}" = --rate-limit ]; then
  export SMOKE_USER="ratelimit-smoke-$(date +%s)" SMOKE_PW="definitely-wrong-password"
  codes=""
  for i in 1 2 3 4 5 6; do
    codes="$codes $(json_login | curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' --data-binary @- "$BASE/api/auth/login")"
  done
  forged=$(json_login | curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "CF-Connecting-IP: 203.0.113.$((RANDOM % 250 + 1))" --data-binary @- "$BASE/api/auth/login")
  say ratelimit "codes:$codes forged-header:$forged"
  [ "$codes" = " 401 401 401 401 401 429" ] && [ "$forged" = 429 ] && echo RATE_LIMIT_OK || { echo RATE_LIMIT_FAIL; exit 1; }
  exit 0
fi

export SMOKE_USER=${1:?usage: smoke.sh <username> [--login-only | --tombstone <food-id>] | --rate-limit}
MODE=${2:-full}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
JAR="$TMP/jar"

read -rsp "Password for $SMOKE_USER: " SMOKE_PW; echo >&2
export SMOKE_PW

say health "$(curl -sS "$BASE/api/health")"
say web "$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "$BASE/")"
LOGIN=$(json_login | curl -sS -c "$JAR" -H 'content-type: application/json' --data-binary @- "$BASE/api/auth/login")
unset SMOKE_PW
say login "$LOGIN"
echo "$LOGIN" | jq -e '.user.id' >/dev/null
say me "$(curl -sS -b "$JAR" "$BASE/api/auth/me")"
say bg "$(curl -sS -b "$JAR" "$BASE/api/bg" | jq -c '{mgdl, arrow, age_ms, fresh, error}')"

if [ "$MODE" != --login-only ]; then
  say usda "$(curl -sS -b "$JAR" "$BASE/api/usda/manifest" | jq -c '{version, food_count, portion_count, error}')"
  if [ "$MODE" = --tombstone ]; then
    ID=${3:?--tombstone needs the sentinel food id}
    DELETED=1
  else
    ID=$(python3 -c 'import os, time
b = int(time.time() * 1000).to_bytes(6, "big") + bytearray(os.urandom(10))
b[6] = (b[6] & 0x0F) | 0x70; b[8] = (b[8] & 0x3F) | 0x80
h = bytes(b).hex(); print(f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}")')
    DELETED=0
  fi
  NOW=$(python3 -c 'import time; print(int(time.time() * 1000))')
  PUSH=$(jq -nc --arg id "$ID" --argjson ts "$NOW" --argjson del "$DELETED" \
    '{changes: [{table: "food", record: {id: $id, name: "CarbBook deploy smoke test", brand: null, source: "custom", source_ref: null, derived_from: null, carbs_per_100g: 10, fiber_per_100g: null, density_g_per_ml: null, notes: "created by deploy/smoke.sh", updated_at: $ts, updated_by: "deploy-smoke", deleted: $del}}]}' \
    | curl -sS -b "$JAR" -H 'content-type: application/json' --data-binary @- "$BASE/api/sync/push")
  say push "$(echo "$PUSH" | jq -c '.results[0]')"
  SEQ=$(echo "$PUSH" | jq -e '.results[0] | select(.status == "accepted") | .server_seq')
  PULL=$(curl -sS -b "$JAR" "$BASE/api/sync/pull?since=$((SEQ - 1))&limit=10")
  say pull "$(echo "$PULL" | jq -c --arg id "$ID" '[.changes[] | select(.record.id == $id) | {table, id: .record.id, deleted: .record.deleted, server_seq: .record.server_seq}]')"
  echo "$PULL" | jq -e --arg id "$ID" --argjson del "$DELETED" '.changes[] | select(.record.id == $id and .record.deleted == $del)' >/dev/null
  say sentinel "$ID"
fi

curl -sS -b "$JAR" -X POST "$BASE/api/auth/logout" -o /dev/null
echo SMOKE_OK
