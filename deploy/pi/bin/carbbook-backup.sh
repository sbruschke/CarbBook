#!/usr/bin/env bash
# Online SQLite backup of CarbBook (safe while the server runs in WAL mode).
# Writes /opt/carbbook/backups/carbbook-YYYYmmdd-HHMMSS.db.gz, verifies it, keeps the newest $KEEP.
set -euo pipefail

KEEP=${KEEP:-14}
DIR=/opt/carbbook/backups
NAME="carbbook-$(date +%Y%m%d-%H%M%S).db"

docker exec carbs-server sqlite3 /data/carbbook.db ".backup '/backups/$NAME'"
CHECK=$(docker exec carbs-server sqlite3 "/backups/$NAME" 'PRAGMA integrity_check;')
if [ "$CHECK" != ok ]; then
  echo "integrity_check failed for $NAME: $CHECK" >&2
  rm -f "$DIR/$NAME"
  exit 1
fi
COUNTS=$(docker exec carbs-server sqlite3 "/backups/$NAME" \
  "SELECT 'users=' || (SELECT count(*) FROM user) || ' foods=' || (SELECT count(*) FROM food) || ' logs=' || (SELECT count(*) FROM log_entry) || ' usda=' || (SELECT count(*) FROM usda_food);")
gzip -9 "$DIR/$NAME"
ls -1 "$DIR"/carbbook-*.db.gz | sort | head -n -"$KEEP" | xargs -r rm -f
echo "backup $NAME.gz ok ($COUNTS, $(stat -c %s "$DIR/$NAME.gz") bytes); keeping $(ls -1 "$DIR"/carbbook-*.db.gz | wc -l)"
