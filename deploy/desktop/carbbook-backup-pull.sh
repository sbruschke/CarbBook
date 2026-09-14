#!/usr/bin/env bash
# Pull CarbBook backups from the Pi into ~/HomelabServer/appdata/carbbook-backups and keep the newest 30.
# Fails (and notifies) if the Pi is unreachable or the newest backup is older than MAX_AGE_H hours.
set -euo pipefail

DEST="$HOME/HomelabServer/appdata/carbbook-backups"
KEEP=${KEEP:-30}
MAX_AGE_H=${MAX_AGE_H:-36}

notify() {
  echo "$1" >&2
  command -v notify-send >/dev/null && notify-send -u critical "CarbBook backup" "$1" || true
}

mkdir -p "$DEST"
if ! rsync -a --ignore-existing --include='carbbook-*.db.gz' --exclude='*' \
     -e 'ssh -o BatchMode=yes -o ConnectTimeout=15' pi:/opt/carbbook/backups/ "$DEST/"; then
  notify "pull from pi failed (Pi unreachable?)"
  exit 1
fi

for f in "$DEST"/carbbook-*.db.gz; do
  gzip -t "$f" || { notify "corrupt backup $f"; exit 1; }
done

ls -1 "$DEST"/carbbook-*.db.gz | sort | head -n -"$KEEP" | xargs -r rm -f

NEWEST=$(ls -1 "$DEST"/carbbook-*.db.gz | sort | tail -n 1)
if [ -z "$(find "$NEWEST" -mmin -$((MAX_AGE_H * 60)))" ]; then
  notify "newest backup $(basename "$NEWEST") is older than ${MAX_AGE_H}h"
  exit 1
fi
echo "ok: $(ls -1 "$DEST"/carbbook-*.db.gz | wc -l) backups, newest $(basename "$NEWEST")"
