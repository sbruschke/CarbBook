#!/usr/bin/env bash
# Non-destructive restore test: unpack a backup into a scratch dir, boot a throwaway carbs-server
# on it (no network), check integrity, migrations, health, and optionally a sentinel food record.
# Usage: carbbook-restore-test.sh [backup.db.gz]   (default: newest)   env SENTINEL_ID=<food id>
set -euo pipefail

DIR=/opt/carbbook/backups
SRC=${1:-$(ls -1 "$DIR"/carbbook-*.db.gz | sort | tail -n 1)}
TAG=$(grep -E '^CARBBOOK_TAG=' /opt/carbbook/.env | cut -d= -f2-)
WORK=$(mktemp -d /opt/carbbook/restore-test.XXXXXX)
NAME=carbs-restore-test
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

gzip -t "$SRC"
gunzip -c "$SRC" > "$WORK/carbbook.db"
chmod 755 "$WORK"
echo "restoring $(basename "$SRC") with image carbbook-server:$TAG"

docker run -d --name "$NAME" --network none \
  -e DATABASE_PATH=/restore/carbbook.db -e USDA_DIR=/restore/usda -e WEB_DIR= -e COOKIE_SECURE=false \
  -v "$WORK:/restore" "carbbook-server:$TAG" >/dev/null

STATUS=down
for i in $(seq 1 30); do
  if docker exec "$NAME" node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null; then
    STATUS=up; break
  fi
  sleep 1
done
echo "restored server: $STATUS"
[ "$STATUS" = up ] || { docker logs --tail 30 "$NAME"; exit 1; }

docker exec "$NAME" sqlite3 /restore/carbbook.db \
  "SELECT 'integrity=' || (SELECT integrity_check FROM pragma_integrity_check) || ' users=' || (SELECT count(*) FROM user) || ' foods=' || (SELECT count(*) FROM food) || ' usda=' || (SELECT count(*) FROM usda_food) || ' dose_settings=' || (SELECT count(*) FROM dose_settings);"
if [ -n "${SENTINEL_ID:-}" ]; then
  docker exec "$NAME" sqlite3 /restore/carbbook.db "SELECT 'restored sentinel ' || id || ' deleted=' || deleted FROM food WHERE id = '$SENTINEL_ID';" | grep . \
    || { echo "sentinel $SENTINEL_ID not in backup" >&2; exit 1; }
  docker exec carbs-server sqlite3 /data/carbbook.db "SELECT 'live sentinel ' || id || ' deleted=' || deleted FROM food WHERE id = '$SENTINEL_ID';"
fi
echo RESTORE_TEST_OK
