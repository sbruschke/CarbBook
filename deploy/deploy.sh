#!/usr/bin/env bash
# Build CarbBook on the Pi from this checkout and (re)start carbs-server.
# Usage: deploy/deploy.sh [--allow-dirty]
set -euo pipefail
cd "$(dirname "$0")/.."

# Untracked files are ignored (they are not part of the build unless listed in the Dockerfile).
DIRTY=$(git status --porcelain --untracked-files=no)
if [ -n "$DIRTY" ] && [ "${1:-}" != "--allow-dirty" ]; then
  echo "working tree is dirty; commit first or pass --allow-dirty" >&2
  exit 1
fi
TAG=$(git rev-parse --short=12 HEAD)
[ -z "$DIRTY" ] || TAG="$TAG-dirty"
test -f web/package.json || { echo "web/ is missing; the web PWA must exist before deploying" >&2; exit 1; }

FREE_MB=$(ssh pi "df -Pm /opt | awk 'NR==2 {print \$4}'")
[ "$FREE_MB" -ge 3000 ] || { echo "Pi has only ${FREE_MB} MB free; need 3000 MB to build" >&2; exit 1; }
ssh pi 'test -f /opt/carbbook/.env' || { echo "missing /opt/carbbook/.env; run deploy/make-env.sh" >&2; exit 1; }

rsync -a --delete \
  --exclude '.git/' --exclude 'node_modules/' --exclude 'dist/' --exclude 'coverage/' \
  --exclude 'docs/' --exclude 'ios/' --exclude 'deploy/' --exclude '.env' --exclude 'HANDOFF.md' \
  --exclude 'test-results/' --exclude 'playwright-report/' \
  ./ pi:/opt/carbbook/src/
rsync -a deploy/compose.yml pi:/opt/carbbook/compose.yml
rsync -a --delete deploy/pi/bin/ pi:/opt/carbbook/bin/
rsync -a --delete deploy/pi/systemd/ pi:/opt/carbbook/systemd/

ssh pi "TAG=$TAG bash -s" <<'EOF'
set -euo pipefail
cd /opt/carbbook
CUR=$(grep -E '^CARBBOOK_TAG=' .env | cut -d= -f2-)
CARBBOOK_TAG="$TAG" docker compose build carbs-server
if [ "$CUR" != "$TAG" ] && docker image inspect "carbbook-server:$CUR" >/dev/null 2>&1; then
  echo "$CUR" > previous-tag
fi
sed -i "s/^CARBBOOK_TAG=.*/CARBBOOK_TAG=$TAG/" .env
docker compose up -d carbs-server
STATUS=starting
for i in $(seq 1 30); do
  STATUS=$(docker inspect -f '{{.State.Health.Status}}' carbs-server)
  [ "$STATUS" = healthy ] && break
  sleep 5
done
PREV=$(cat previous-tag 2>/dev/null || echo none)
echo "carbs-server $STATUS (tag $TAG, previous $PREV)"
[ "$STATUS" = healthy ] || { docker logs --tail 30 carbs-server; exit 1; }
docker image ls carbbook-server --format '{{.Tag}}' \
  | grep -vxF -e "$TAG" -e "$PREV" \
  | xargs -r -I{} docker image rm "carbbook-server:{}" >/dev/null
docker image prune -f >/dev/null
docker builder prune -f --filter until=168h >/dev/null
df -h / | awk 'NR==2 {print "Pi disk free: " $4}'
EOF
