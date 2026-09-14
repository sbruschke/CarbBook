#!/usr/bin/env bash
# DESTRUCTIVE: replace the live CarbBook DB with a backup. The current DB files are moved to
# /opt/carbbook/data/pre-restore-<timestamp>/ first, so this is itself reversible.
# Usage: carbbook-restore.sh /opt/carbbook/backups/carbbook-YYYYmmdd-HHMMSS.db.gz
set -euo pipefail

SRC=${1:?usage: carbbook-restore.sh /opt/carbbook/backups/carbbook-YYYYmmdd-HHMMSS.db.gz}
cd /opt/carbbook
test -f "$SRC"
gzip -t "$SRC"
KEEP="data/pre-restore-$(date +%Y%m%d-%H%M%S)"

docker compose stop carbs-server
mkdir -p "$KEEP"
mv data/carbbook.db data/carbbook.db-wal data/carbbook.db-shm "$KEEP"/ 2>/dev/null || true
gunzip -c "$SRC" > data/carbbook.db
docker compose start carbs-server

STATUS=starting
for i in $(seq 1 30); do
  STATUS=$(docker inspect -f '{{.State.Health.Status}}' carbs-server)
  [ "$STATUS" = healthy ] && break
  sleep 5
done
echo "restored $(basename "$SRC"); previous DB kept in /opt/carbbook/$KEEP; carbs-server $STATUS"
[ "$STATUS" = healthy ]
