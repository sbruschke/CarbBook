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

# The Dexcom reading history (pi-infra dexcom-api, /opt/dexcom-data). Share only keeps 24 h, so this
# file is the only copy of anything older. Cumulative, so a week of copies is plenty. Its failure is
# reported but never fails the CarbBook backup above.
DEX="dexcom-readings-$(date +%Y%m%d-%H%M%S).db.gz"
# Backed up inside the container (online, WAL-safe) and streamed out gzipped, so nothing here
# needs to touch the root-owned /opt/dexcom-data.
if docker exec -i dexcom-api python - > "$DIR/$DEX" 2>/tmp/dexcom-backup.log <<'PY'
import gzip, os, sqlite3, sys
src = sqlite3.connect("/data/readings.db")
dst = sqlite3.connect("/tmp/backup.db")
src.backup(dst)
ok = dst.execute("PRAGMA integrity_check").fetchone()[0]
count = dst.execute("SELECT count(*) FROM readings").fetchone()[0]
dst.close()
if ok != "ok":
    sys.exit("integrity_check: " + ok)
with open("/tmp/backup.db", "rb") as f:
    sys.stdout.buffer.write(gzip.compress(f.read(), 9))
os.remove("/tmp/backup.db")
print(f"readings={count}", file=sys.stderr)
PY
then
  ls -1 "$DIR"/dexcom-readings-*.db.gz | sort | head -n -7 | xargs -r rm -f
  echo "backup $DEX ok ($(cat /tmp/dexcom-backup.log), $(stat -c %s "$DIR/$DEX") bytes)"
else
  rm -f "$DIR/$DEX"
  echo "dexcom readings backup FAILED: $(cat /tmp/dexcom-backup.log)" >&2
fi
