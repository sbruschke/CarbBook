# CarbBook Pi Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `carbs-server` (API + built web PWA) on the Raspberry Pi at `https://recipes.dxshdw.dev`, with the USDA library imported, owner + viewer accounts, nightly verified backups kept 30 days on the desktop, one tested restore, and a documented rollback.

**Architecture:** A multi-stage `Dockerfile` at the repo root builds the pnpm workspace (web PWA + server with its native deps) **on the Pi** (arm64) through `docker compose build` with `network: host`. `/opt/carbbook/compose.yml` runs one container `carbs-server` on the external network `pi_net` with **no published host ports**; `/opt/carbbook/data` (bind mount → `/data`) holds the SQLite DB and USDA bundles. Cloudflare tunnel `pi` gains one ingress rule `recipes.dxshdw.dev → http://carbs-server:3000` plus a proxied CNAME; Pi-hole gets a `misc.dnsmasq_lines` exception. A Pi systemd timer takes `sqlite3 .backup` snapshots (keeps 14) and a desktop systemd **user** timer (`Persistent=true`) pulls them into `~/HomelabServer/appdata/carbbook-backups/` (keeps 30).

**Tech Stack:** Docker 29.8 + compose v5 on Pi 5 (Debian 13 aarch64), `node:22-bookworm-slim`, pnpm 10.33.2, tsx 4.23 runtime, better-sqlite3 13.0.3 + @node-rs/argon2 2.2.1 (prebuilt arm64 binaries), sqlite3 CLI, systemd timers, rsync over `ssh pi`, Cloudflare API (Python stdlib `urllib`), Pi-hole FTL v6.5.

**Spec:** `docs/superpowers/specs/2026-09-13-carbbook-design.md` §2.1 (Pi layout, backups), §4.4 (BG proxy), §7 (accounts, rate limit), §10 (deploy smoke). Builds on `2026-09-14-carbbook-server-foundation.md`, `2026-09-14-carbbook-server-data.md`, the web PWA plan, and `~/Projects/pi-infra` (already deployed).

---

## Verified facts (2026-09-14, read-only investigation)

| Fact | Evidence |
|---|---|
| Pi: `ssh pi` → `pihole@192.168.1.148`, uid/gid 1000, in `docker` group, `sudo -n` works (NOPASSWD). Debian 13, aarch64, 4 cores, 7.9 GiB RAM, TZ America/Chicago | `id`, `sudo -n true`, `uname -m`, `nproc`, `timedatectl` |
| Pi disk: 29 G root, **23 G free**; Docker images 473 MB + 240 MB build cache | `df -h /`, `docker system df` |
| Pi has `curl`, `unzip`, `python3`, `gzip`, `rsync`; **no `sqlite3` CLI on the host** (so the CLI goes in the image); system `cron` active but no crontab; Pi has systemd timers | `which`, `crontab -l`, `systemctl list-timers` |
| Pi containers on `pi_net`: `cloudflared`, `dexcom-api` (healthy), `ipa-web`. `/opt/pi-infra`, `/opt/ipa-hub` owned by `pihole`. No `/opt/carbbook` yet | `docker ps`, `ls -la /opt` |
| BuildKit on the Pi copies resolv.conf minus 127.0.0.1 (Pi-hole) → package-manager DNS fails in builds; `build.network: host` fixes it | `~/Projects/pi-infra/compose.yml` comment + commit `f03341b` |
| Desktop `docker buildx ls`: only builder `default`, platforms `linux/amd64, amd64/v2, amd64/v3`; `/proc/sys/fs/binfmt_misc` has no `qemu-aarch64` entry → **no arm64 emulation on the desktop** | `docker buildx inspect default`, `ls /proc/sys/fs/binfmt_misc` |
| Pi buildx `default` builder: `linux/arm64`, BuildKit v0.33.0 | `ssh pi docker buildx ls` |
| Pi-hole v6.5 `misc.dnsmasq_lines` today = `address=/shadow.lab/192.168.1.210`, `address=/dxshdw.dev/192.168.1.210`, `server=/ipa.dxshdw.dev/#`, `server=/dexcom.dxshdw.dev/#` | `/etc/pihole/pihole.toml:1403-1408` |
| Tunnel `pi` id `fdb3aebf-bc6c-48e1-bdf7-133261a745c0`, account `ff4fdd9b459736d57f017e6645225586`, `config_src=cloudflare`, ingress: `ipa.dxshdw.dev → http://ipa-web:80`, `dexcom.dxshdw.dev → http://dexcom-api:8000`, catch-all `http_status:404`. Zone `dxshdw.dev` id `ed198a1135f51217415ceb107db532f3` | `~/Projects/pi-infra/README.md`, pi-infra plan facts table |
| Tunnel+DNS-capable API token: exactly **one** distinct match of `T='([A-Za-z0-9._-]{30,})'` in `~/.claude/projects/-home-shadow-linux/1dc9e5ca-f3e6-4d3e-b8ac-7cfd09fe7f53.jsonl` (counted, never printed) | `grep -oP … \| sort -u \| wc -l` → `1` |
| dexcom-api on the Pi accepts `Authorization: Bearer <API_TOKEN>` or `?token=`; token is `DEXCOM_API_TOKEN` in `/opt/pi-infra/.env` (mode 600) | `dexcom-api/app.py:17,244-250`, `scripts/make-env.sh` |
| Server config env names (`server/src/config.ts`): `HOST` (0.0.0.0), `PORT` (3000), `DATABASE_PATH` (/data/carbbook.db), `WEB_DIR` (unset → no static), `USDA_DIR` (/data/usda), `DEXCOM_API_URL` (http://dexcom-api:8000), `DEXCOM_API_TOKEN`, `OFF_BASE_URL`, `OFF_USER_AGENT`, `HTTP_TIMEOUT_MS`, `COOKIE_SECURE` (true), `TRUST_PROXY` (false) | source |
| **`TRUST_PROXY=true` contract (feat/server review fix):** Fastify no longer uses `trustProxy: true`; with `TRUST_PROXY=true` the client IP for login rate limiting/logs comes from the `CF-Connecting-IP` header, falling back to the socket address; with it off the header is ignored. Trusting that header is only safe because `carbs-server` publishes no host ports and is reachable only over `pi_net` (from `cloudflared`) | coordinator message 2026-09-14 |
| Entry points: `server/src/main.ts` (top-level await, SIGTERM/SIGINT graceful), `server/src/cli.ts` (`carbbook user add <username> [--role owner\|viewer]`, password from `CARBBOOK_PASSWORD` or a readline prompt **that echoes**; `carbbook import-usda <csv-dir>...`). Runtime is `tsx` (prod dep), no build step. `MIN_PASSWORD_LENGTH = 8` | `server/src/cli.ts`, `server/package.json`, foundation plan Task 15, data plan Task 11, `server/src/auth/users.ts:19` |
| DB: WAL mode, tables `food`, `portion`, `barcode`, `meal`, `meal_item`, `log_entry`, `log_item`, `dose_settings`, `user`, `auth_session` (+ `usda_food`, `usda_portion`, `usda_fts` from migration 002) | `server/src/db.ts:12`, `server/migrations/001_init.sql`, data plan Task 7 |
| HTTP: `GET /api/health` → `{"ok":true}`; `POST /api/auth/login` `{username,password}` → `{"user":{id,username,role}}` + `carbbook_session` cookie; 6th attempt within 15 min per IP+username → `429 {"error":"rate_limited"}`; `GET /api/auth/me`; `POST /api/auth/logout`; `GET /api/bg` → `{mgdl,trend,arrow,delta_mgdl,read_at,age_ms,fresh}` or `503 bg_unavailable`; `POST /api/sync/push {changes:[{table,record}]}` → `{results:[{table,id,status,server_seq}],server_seq}`; `GET /api/sync/pull?since=&limit=` → `{changes:[{table,record}],next_since,has_more}`; `GET /api/usda/manifest` → `{version,food_count,portion_count,…}` or `404 usda_not_imported` | foundation plan Tasks 9, 10, 13; data plan Tasks 5, 11 |
| USDA downloads: `https://fdc.nal.usda.gov/fdc-datasets/{FoodData_Central_foundation_food_csv_2026-04-30,FoodData_Central_sr_legacy_food_csv_2018-04,FoodData_Central_survey_food_csv_2024-10-31}.zip`, each extracts to a same-named folder; import → `Imported 13694 foods and 32505 portions (4177 skipped) from 3 datasets` and bundle `fdc-a5f82e4f92a5` (~474 KB json.gz, ~3.6 MB sqlite) | data plan header + Task 15 |
| `pnpm-lock.yaml` (lockfile 9.0) already lists `@node-rs/argon2-linux-arm64-gnu@2.2.1`; better-sqlite3 13.0.3 ships `prebuilds/linux-arm64` with FTS5; pnpm 10 "Ignored build scripts: better-sqlite3, esbuild" is harmless | lockfile, foundation plan notes |
| Desktop: `~/.ssh/id_ed25519` has no passphrase and no agent is needed (works from systemd user units); user lingering `Linger=yes`; `~/HomelabServer/appdata/` exists on `/home` (316 G free), `carbbook-backups/` does not exist yet; existing user-timer convention = unit files in the project repo symlinked into `~/.config/systemd/user/` (`ipa-sync`) | `ssh-keygen -y -P ""`, `loginctl`, `systemctl --user cat ipa-sync.*` |
| Repo `~/Projects/CarbBook` is on `feat/server` (others committing there); **no `web/` directory and no web plan exist yet** | `git branch`, `ls` |

## Decisions

**Build on the Pi (not cross-build on the desktop).** The desktop has no arm64 emulation (buildx platforms are amd64 only, no `qemu-aarch64` binfmt); enabling it means installing qemu/binfmt system-wide, and emulated `pnpm install` + a Vite build under qemu is typically several times slower than the Pi natively. The Pi has 4 cores and 8 GB, both native deps ship prebuilt arm64 binaries (nothing compiles), `network: host` builds are already proven for `dexcom-api`, and building in place avoids a `docker save | ssh | docker load` transfer of a ~300 MB image. Cost: BuildKit cache on the SD card — `deploy.sh` checks for ≥3 GB free first and prunes old images afterwards. The Dockerfile is still validated natively on the desktop (amd64) in Task 2 so mistakes surface before touching the Pi.

**Backups: Pi snapshots + desktop pull.** The Pi takes a nightly `sqlite3 .backup` (safe on a live WAL DB), runs `PRAGMA integrity_check`, gzips it and keeps the newest **14** locally. The desktop pulls with a systemd user timer (`OnCalendar` 04:30, `Persistent=true`) using its existing `ssh pi` key and keeps the newest **30**. Pull beats push because the Pi then needs no credentials into the desktop (which holds every homelab secret) and no desktop listener; if the desktop is off, `Persistent=true` runs the pull at next boot and `rsync` copies every missed file, so up to ~13 days offline loses nothing from the 30-day window. The pull fails loudly (non-zero exit, `notify-send`) when the newest backup is older than 36 h. The USDA tables live in the same DB, so each backup is self-contained (tens of MB uncompressed, a few MB gzipped).

**Bind mount, not named volume**, for `/data` and `/backups`: host-side scripts (gzip, rsync, restore) read the files directly, and the image's `node` user is uid 1000 = `pihole` on the Pi, so ownership needs no chown.

**Passwords** are typed by the user into `read -rs` on the Pi and passed to `docker exec -e CARBBOOK_PASSWORD` (name only, value from the environment, so it never appears in argv, files, chat or terminal echo). The CLI's own prompt echoes, so it is not used.

**`OFF_USER_AGENT`** is `CarbBook/0.1 (+https://recipes.dxshdw.dev)` — a contact URL rather than an email, so no personal email is sent to Open Food Facts without the user asking.

**TRUST_PROXY=true** is set because every request arrives from `cloudflared`'s socket; without it all users would share one rate-limit IP. It is safe only while `carbs-server` has no published ports and `pi_net` holds only trusted containers (`cloudflared`, `dexcom-api`, `ipa-web`): Cloudflare overwrites any client-sent `CF-Connecting-IP`, but a container on `pi_net` could forge it. Task 4 verifies there are no host ports and Task 11 verifies that bad logins from outside are still limited, including with a forged header.

## Target file structure

```
~/Projects/CarbBook/
├── Dockerfile                                  # multi-stage: web build, prod deps, runtime (node:22-bookworm-slim + sqlite3)
├── .dockerignore
└── deploy/
    ├── README.md                               # runbook: deploy, logs, backups, restore, rollback
    ├── compose.yml                             # → /opt/carbbook/compose.yml (carbs-server on pi_net, no ports)
    ├── .env.example                            # variable names only
    ├── deploy.sh                               # desktop: rsync → Pi, build on Pi, tag, up, health, prune
    ├── make-env.sh                             # desktop: writes /opt/carbbook/.env on the Pi (token copied Pi-side, never printed)
    ├── cloudflare-route.py                     # desktop: show/add/remove recipes ingress + CNAME (token never printed)
    ├── smoke.sh                                # desktop, interactive: spec §10 checks over the public hostname
    ├── pi/
    │   ├── bin/carbbook-backup.sh              # → /opt/carbbook/bin/  nightly .backup + integrity + gzip + keep 14
    │   ├── bin/carbbook-restore.sh             # → /opt/carbbook/bin/  replace live DB from a backup (rollback)
    │   ├── bin/carbbook-restore-test.sh        # → /opt/carbbook/bin/  non-destructive restore into a scratch container
    │   ├── bin/usda-import.sh                  # → /opt/carbbook/bin/  disk check, download, unzip, import, cleanup
    │   └── systemd/carbbook-backup.{service,timer}   # → /etc/systemd/system/
    └── desktop/
        ├── carbbook-backup-pull.sh             # rsync Pi backups → ~/HomelabServer/appdata/carbbook-backups, keep 30
        └── systemd/carbbook-backup-pull.{service,timer}  # symlinked into ~/.config/systemd/user/
```

On the Pi:

```
/opt/carbbook/            pihole:pihole 755
├── compose.yml
├── .env                  600  TZ, DEXCOM_API_TOKEN, OFF_USER_AGENT, CARBBOOK_TAG
├── previous-tag          image tag to roll back to
├── bin/  systemd/        from deploy/pi/
├── src/                  build context (repo minus .git, node_modules, dist, docs, ios, deploy)
├── data/                 → /data   carbbook.db (+ -wal/-shm), usda/
└── backups/              → /backups carbbook-YYYYmmdd-HHMMSS.db.gz (newest 14)
```

---

### Task 1: Prerequisites and deploy branch

**Files:** none

- [ ] **Step 1: Server plans and web plan are implemented and merged to `main`**

```bash
cd ~/Projects/CarbBook
git fetch --all --quiet 2>/dev/null || true
git log --oneline main | grep -cE 'process entry point with graceful shutdown|USDA bundle endpoints and import-usda command|sync push/pull HTTP routes'
ls docs/superpowers/plans/ | grep -E 'carbbook-web'
```
Expected: `3`, and at least one `2026-09-14-carbbook-web*.md` line. If the count is lower, stop: the server plans are not merged yet.

- [ ] **Step 2: Confirm the web build output directory (ASSUMPTION CHECK)**

This plan assumes the web PWA is the workspace package at `web/` with a `build` script that writes `web/dist/index.html`. Verify against the web plan and the code:

```bash
cd ~/Projects/CarbBook
git checkout main && git pull --ff-only 2>/dev/null || true
grep -nE 'outDir|web/dist' docs/superpowers/plans/2026-09-14-carbbook-web*.md | head -5
node -e 'const p=require("./web/package.json"); console.log(p.name, "build:", p.scripts && p.scripts.build)'
grep -n 'web' pnpm-workspace.yaml
```
Expected: no `outDir` other than `dist` (or none, Vite's default is `dist`); a package name and a non-empty build script; `  - web` in the workspace file.
If the output dir differs (for example `web/build`), replace every `web/dist` in this plan (Dockerfile `COPY --from=build`, `test -f`, compose `WEB_DIR`) with the real path before continuing.

- [ ] **Step 3: Workspace is green on main**

```bash
cd ~/Projects/CarbBook && pnpm install --frozen-lockfile && pnpm test && pnpm typecheck && pnpm --dir web run build && ls web/dist/index.html
```
Expected: all packages pass, no type errors, `web/dist/index.html`.

- [ ] **Step 4: Create the deploy branch**

```bash
cd ~/Projects/CarbBook && git checkout -b feat/deploy main && git status --short | wc -l
```
Expected: `Switched to a new branch 'feat/deploy'` and `0`.

---

### Task 2: Dockerfile, validated natively on the desktop

**Files:**
- Create: `~/Projects/CarbBook/Dockerfile`
- Create: `~/Projects/CarbBook/.dockerignore`

- [ ] **Step 1: Write `.dockerignore`**

```gitignore
**/node_modules
**/dist
**/coverage
**/*.log
.git
.github
docs
ios
deploy
**/.env
**/.env.*
.DS_Store
```

- [ ] **Step 2: Write `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
# CarbBook server + web PWA. Built on the Raspberry Pi (arm64) by deploy/deploy.sh.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV CI=true
RUN npm install -g pnpm@10.33.2 && pnpm --version
WORKDIR /app

# ---- web PWA build (needs dev dependencies) ----
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY server server
COPY web web
COPY testdata testdata
RUN pnpm --dir web run build && test -f web/dist/index.html

# ---- production dependencies for the server (+ @carbbook/core as source) ----
FROM base AS prod
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --prod --filter "@carbbook/server..."
COPY packages/core packages/core
COPY server server

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends sqlite3 \
 && rm -rf /var/lib/apt/lists/* \
 && printf '#!/bin/sh\ncd /app/server && exec node --import tsx src/cli.ts "$@"\n' > /usr/local/bin/carbbook \
 && chmod 755 /usr/local/bin/carbbook \
 && mkdir -p /data /backups && chown node:node /data /backups
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/carbbook.db \
    USDA_DIR=/data/usda \
    WEB_DIR=/app/web/dist
COPY --from=prod /app /app
COPY --from=build /app/web/dist /app/web/dist
WORKDIR /app/server
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/main.ts"]
```

- [ ] **Step 3: Build natively on the desktop (amd64) to validate the Dockerfile**

```bash
cd ~/Projects/CarbBook && docker build -t carbbook-server:local . 2>&1 | tail -3
docker image ls carbbook-server:local --format '{{.Size}}'
```
Expected: `naming to docker.io/library/carbbook-server:local done` near the end; a size under `450MB`.

- [ ] **Step 4: Native modules, FTS5 and CLI load inside the image**

```bash
docker run --rm carbbook-server:local node -e '
const D = require("better-sqlite3"); const db = new D(":memory:");
db.exec("CREATE VIRTUAL TABLE t USING fts5(x)");
console.log("sqlite", db.prepare("select sqlite_version() v").get().v, "fts5 ok");
require("@node-rs/argon2").hash("x").then(h => console.log("argon2", h.slice(0, 10)));'
docker run --rm carbbook-server:local sqlite3 --version | cut -d" " -f1
docker run --rm carbbook-server:local carbbook 2>&1 | head -1; docker run --rm carbbook-server:local id -u
```
Expected: `sqlite 3.53.4 fts5 ok`, `argon2 $argon2id$`, a `3.x` version, `Usage:`, `1000`.

- [ ] **Step 5: Server boots, serves the PWA and health**

```bash
D=$(mktemp -d) && docker run -d --name carbbook-local -e COOKIE_SECURE=false -p 127.0.0.1:3998:3000 -v "$D:/data" carbbook-server:local >/dev/null
for i in $(seq 1 30); do curl -s 127.0.0.1:3998/api/health >/dev/null && break; sleep 1; done
curl -s 127.0.0.1:3998/api/health; echo
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' 127.0.0.1:3998/
curl -s 127.0.0.1:3998/api/nope; echo
docker rm -f carbbook-local >/dev/null && docker image rm carbbook-server:local >/dev/null && rm -rf "$D" && echo CLEAN
```
Expected: `{"ok":true}`, `200 text/html; charset=utf-8`, `{"error":"not_found","message":"No route for GET /api/nope"}`, `CLEAN`.
(Publishing `-p 127.0.0.1:3998` is for this desktop test only; the Pi compose publishes nothing.)

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook && git add Dockerfile .dockerignore && git commit -m "build: multi-stage Docker image for carbs-server with web PWA"
```

---

### Task 3: Compose file, env and deploy scripts

**Files:**
- Create: `~/Projects/CarbBook/deploy/compose.yml`
- Create: `~/Projects/CarbBook/deploy/.env.example`
- Create: `~/Projects/CarbBook/deploy/make-env.sh`
- Create: `~/Projects/CarbBook/deploy/deploy.sh`

- [ ] **Step 1: Write `deploy/compose.yml`**

```yaml
# CarbBook on the Raspberry Pi — deployed to /opt/carbbook by deploy/deploy.sh.
# https://recipes.dxshdw.dev → tunnel pi (cloudflared on pi_net) → carbs-server:3000
# NO host ports: Pi-hole owns 80/443, and TRUST_PROXY=true (CF-Connecting-IP) is only
# safe while this container is reachable solely from cloudflared over pi_net.
name: carbbook

networks:
  pi_net:
    external: true

services:
  carbs-server:
    build:
      context: ./src
      # BuildKit drops Pi-hole (127.0.0.1) from resolv.conf -> npm/apt DNS fails. Host network fixes it.
      network: host
    image: carbbook-server:${CARBBOOK_TAG:-latest}
    container_name: carbs-server
    init: true
    environment:
      - TZ=${TZ:-America/Chicago}
      - HOST=0.0.0.0
      - PORT=3000
      - DATABASE_PATH=/data/carbbook.db
      - USDA_DIR=/data/usda
      - WEB_DIR=/app/web/dist
      - DEXCOM_API_URL=http://dexcom-api:8000
      - DEXCOM_API_TOKEN=${DEXCOM_API_TOKEN}
      - OFF_USER_AGENT=${OFF_USER_AGENT}
      - COOKIE_SECURE=true
      - TRUST_PROXY=true
    volumes:
      - /opt/carbbook/data:/data
      - /opt/carbbook/backups:/backups
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
      start_interval: 5s
    networks:
      - pi_net
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

- [ ] **Step 2: Write `deploy/.env.example`**

```dotenv
TZ=America/Chicago
DEXCOM_API_TOKEN=
OFF_USER_AGENT='CarbBook/0.1 (+https://recipes.dxshdw.dev)'
CARBBOOK_TAG=latest
```

- [ ] **Step 3: Write `deploy/make-env.sh`**

```bash
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
  echo "OFF_USER_AGENT='CarbBook/0.1 (+https://recipes.dxshdw.dev)'"
  echo "$TAG_LINE"
} > /opt/carbbook/.env.new
mv /opt/carbbook/.env.new /opt/carbbook/.env
stat -c '%a %U' /opt/carbbook/.env
cut -d= -f1 /opt/carbbook/.env | sort | tr '\n' ' '; echo
EOF
```

- [ ] **Step 4: Write `deploy/deploy.sh`**

```bash
#!/usr/bin/env bash
# Build CarbBook on the Pi from this checkout and (re)start carbs-server.
# Usage: deploy/deploy.sh [--allow-dirty]
set -euo pipefail
cd "$(dirname "$0")/.."

DIRTY=$(git status --porcelain)
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
  --exclude 'docs/' --exclude 'ios/' --exclude 'deploy/' --exclude '.env' \
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
```

- [ ] **Step 5: Validate locally**

```bash
cd ~/Projects/CarbBook
chmod +x deploy/*.sh
bash -n deploy/deploy.sh && bash -n deploy/make-env.sh && echo SYNTAX_OK
cp deploy/.env.example /tmp/carbbook-env-test && (cd deploy && docker compose --env-file /tmp/carbbook-env-test config --quiet) && echo COMPOSE_OK; rm /tmp/carbbook-env-test
(cd deploy && docker compose --env-file .env.example config --format json) | jq -c '.services["carbs-server"] | {ports, networks: (.networks|keys), restart}'
```
Expected: `SYNTAX_OK`, `COMPOSE_OK` (a warning that `pi_net` is external is fine), `{"ports":null,"networks":["pi_net"],"restart":"unless-stopped"}`.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook && git add deploy/compose.yml deploy/.env.example deploy/make-env.sh deploy/deploy.sh && git commit -m "deploy: Pi compose, env builder and deploy script for carbs-server"
```

---

### Task 4: Prepare the Pi and first deploy

**Files:** none (Pi state)

- [ ] **Step 1: Pre-flight (disk, network, uid)**

```bash
ssh pi 'df -Pm / | awk "NR==2 {print \$4\" MB free\"}"; docker network ls --filter name=pi_net --format "{{.Name}}"; id -u; docker ps --format "{{.Names}} {{.Status}}"'
```
Expected: ≥ `5000 MB free` (23 G today); `pi_net`; `1000`; `cloudflared Up…`, `dexcom-api Up… (healthy)`, `ipa-web Up…`. Stop if free space is under 5000 MB and ask the user what to clean.

- [ ] **Step 2: Create `/opt/carbbook` tree**

```bash
ssh pi 'sudo install -d -o pihole -g pihole -m 755 /opt/carbbook /opt/carbbook/data /opt/carbbook/backups /opt/carbbook/bin /opt/carbbook/systemd /opt/carbbook/src && ls -ld /opt/carbbook /opt/carbbook/data /opt/carbbook/backups | awk "{print \$1, \$3, \$4, \$NF}"'
```
Expected: three lines `drwxr-xr-x pihole pihole /opt/carbbook…`.

- [ ] **Step 3: Write the env file**

```bash
cd ~/Projects/CarbBook && deploy/make-env.sh
```
Expected: `600 pihole` then `CARBBOOK_TAG DEXCOM_API_TOKEN OFF_USER_AGENT TZ `.

- [ ] **Step 4: Create `deploy/pi/bin` and `deploy/pi/systemd` placeholders so rsync has sources**

`deploy.sh` rsyncs these directories; Task 6 and 7 fill them. Create them now with a keep file:

```bash
cd ~/Projects/CarbBook && mkdir -p deploy/pi/bin deploy/pi/systemd && touch deploy/pi/bin/.keep deploy/pi/systemd/.keep && git add deploy/pi && git commit -m "deploy: Pi bin and systemd directories"
```
Expected: a commit with two empty files.

- [ ] **Step 5: First deploy (build on the Pi)**

```bash
cd ~/Projects/CarbBook && time deploy/deploy.sh
```
Expected: the build finishes (several minutes the first time), then `carbs-server healthy (tag <12-hex>, previous none)` and `Pi disk free: …G`.
If `pnpm install` or `apt-get` fails with a DNS error (`EAI_AGAIN`, `Temporary failure resolving`), confirm `network: host` is in `/opt/carbbook/compose.yml` (`ssh pi grep -n network: /opt/carbbook/compose.yml`).

- [ ] **Step 6: Native modules on arm64**

```bash
ssh pi 'docker exec carbs-server node -e "
const D = require(\"better-sqlite3\"); const db = new D(\":memory:\");
db.exec(\"CREATE VIRTUAL TABLE t USING fts5(x)\");
console.log(process.arch, \"sqlite\", db.prepare(\"select sqlite_version() v\").get().v);
require(\"@node-rs/argon2\").hash(\"x\").then(h => console.log(\"argon2\", h.slice(0, 10)));"'
ssh pi 'docker image ls carbbook-server --format "{{.Tag}} {{.Size}}"'
```
Expected: `arm64 sqlite 3.53.4`, `argon2 $argon2id$`, one tag line with a size under `450MB`.

- [ ] **Step 7: No host ports, only pi_net, restart policy, log rotation**

```bash
ssh pi 'docker inspect carbs-server --format "ports={{json .HostConfig.PortBindings}} published={{json .NetworkSettings.Ports}} nets={{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}} {{end}}restart={{.HostConfig.RestartPolicy.Name}} log={{.HostConfig.LogConfig.Type}} {{json .HostConfig.LogConfig.Config}} user={{.Config.User}}"; docker port carbs-server | wc -l; sudo ss -tlnp | grep -c ":3000 " || true'
```
Expected: `ports={} published={"3000/tcp":null} nets=pi_net restart=unless-stopped log=json-file {"max-file":"3","max-size":"10m"} user=node`, then `0`, then `0`.
This is the precondition for `TRUST_PROXY=true`: if any port binding appears, stop and remove it before continuing.

- [ ] **Step 8: Reachable from pi_net, DB initialised, dexcom-api reachable with the token**

```bash
ssh pi 'docker run --rm --network pi_net curlimages/curl -s http://carbs-server:3000/api/health; echo
docker exec carbs-server sqlite3 /data/carbbook.db "PRAGMA journal_mode; SELECT count(*) FROM dose_settings; SELECT count(*) FROM user;"
docker exec carbs-server node -e "fetch(process.env.DEXCOM_API_URL + \"/glucose?history=0\", {headers: {authorization: \"Bearer \" + process.env.DEXCOM_API_TOKEN}}).then(r => r.json()).then(d => console.log(\"dexcom ok=\" + d.ok, \"mgdl=\" + d.mgdl, \"minutes_ago=\" + d.minutes_ago))"
ls -l /opt/carbbook/data'
```
Expected: `{"ok":true}`; `wal`, `3` (seed + two historical versions), `0`; `dexcom ok=true mgdl=<number> minutes_ago=<number>`; `carbbook.db`, `carbbook.db-shm`, `carbbook.db-wal` owned by `pihole`.

---

### Task 5: USDA import on the Pi

**Files:**
- Create: `~/Projects/CarbBook/deploy/pi/bin/usda-import.sh`

- [ ] **Step 1: Write `deploy/pi/bin/usda-import.sh`**

```bash
#!/usr/bin/env bash
# Download the FoodData Central CSVs, import them into carbs-server and build the client bundles.
# Runs on the Pi. Set KEEP_SRC=1 to keep the downloaded/extracted files.
set -euo pipefail

WORK=/opt/carbbook/data/usda-src          # visible in the container as /data/usda-src
NEED_MB=1500
DATASETS=(
  FoodData_Central_foundation_food_csv_2026-04-30
  FoodData_Central_sr_legacy_food_csv_2018-04
  FoodData_Central_survey_food_csv_2024-10-31
)

FREE_MB=$(df -Pm /opt/carbbook | awk 'NR==2 {print $4}')
if [ "$FREE_MB" -lt "$NEED_MB" ]; then
  echo "only ${FREE_MB} MB free on /opt/carbbook; need ${NEED_MB} MB" >&2
  exit 1
fi
docker inspect -f '{{.State.Health.Status}}' carbs-server | grep -qx healthy \
  || { echo "carbs-server is not healthy" >&2; exit 1; }

mkdir -p "$WORK"
cd "$WORK"
for z in "${DATASETS[@]}"; do
  [ -f "$z.zip" ] || curl -sSfL -o "$z.zip" "https://fdc.nal.usda.gov/fdc-datasets/$z.zip"
  [ -d "$z" ] || unzip -q "$z.zip"
  test -f "$z/food.csv" -a -f "$z/food_nutrient.csv" -a -f "$z/food_portion.csv" -a -f "$z/measure_unit.csv" \
    || { echo "$z is missing expected CSV files" >&2; exit 1; }
done
echo "downloaded+extracted: $(du -sh "$WORK" | cut -f1); free now $(df -Pm /opt/carbbook | awk 'NR==2 {print $4}') MB"

docker exec carbs-server carbbook import-usda "${DATASETS[@]/#//data/usda-src/}"
ls -l /opt/carbbook/data/usda

if [ "${KEEP_SRC:-0}" != 1 ]; then
  rm -rf "$WORK"
  echo "removed $WORK"
fi
```

- [ ] **Step 2: Syntax check, commit, deploy the script**

```bash
cd ~/Projects/CarbBook && chmod +x deploy/pi/bin/usda-import.sh && bash -n deploy/pi/bin/usda-import.sh && echo SYNTAX_OK
git add deploy/pi/bin/usda-import.sh && git commit -m "deploy: USDA import script for the Pi"
deploy/deploy.sh && ssh pi 'ls -l /opt/carbbook/bin/usda-import.sh'
```
Expected: `SYNTAX_OK`, `carbs-server healthy (tag <new>, previous <old>)`, the script listed as executable.

- [ ] **Step 3: Run the import**

```bash
ssh pi 'time /opt/carbbook/bin/usda-import.sh'
```
Expected:
```
downloaded+extracted: <size under 1.5G>; free now <MB> MB
Imported 13694 foods and 32505 portions (4177 skipped) from 3 datasets
USDA bundle fdc-a5f82e4f92a5 written to /data/usda
```
then `manifest.json`, `usda-fdc-a5f82e4f92a5.json.gz` (~474 KB), `usda-fdc-a5f82e4f92a5.sqlite` (~3.6 MB), and `removed /opt/carbbook/data/usda-src`. (If USDA republished a file at the same URL the counts and hash differ — fine.)

- [ ] **Step 4: Spot-check search data and disk**

```bash
ssh pi 'docker exec carbs-server sqlite3 /data/carbbook.db "SELECT u.fdc_id || \" \" || u.name || \" \" || u.carbs_per_100g FROM usda_fts JOIN usda_food u ON u.fdc_id = usda_fts.rowid WHERE usda_fts MATCH '"'"'\"rice\"* \"cooked\"*'"'"' ORDER BY bm25(usda_fts) LIMIT 3;"; ls -l /opt/carbbook/data/carbbook.db | awk "{print \$5}"; df -h / | awk "NR==2 {print \$4}"'
```
Expected: `168897 Wild rice, cooked 21.34`, `168914 Rice noodles, cooked 24.01`, `2708356 Rice noodles, cooked 23.87`; DB size in bytes (tens of MB); free space still ≥ 20G.

---

### Task 6: Owner and viewer accounts (user types passwords)

**Files:** none

- [ ] **Step 1: Ask the user to create the owner account**

Tell the user to run this in the Claude Code prompt (the `!` prefix runs it in their terminal; passwords go into `read -s`, are passed by variable name to `docker exec`, and never appear in files, argv or chat). Minimum 8 characters.

```bash
! ssh -t pi 'read -rsp "New password for brett: " P1; echo; read -rsp "Repeat: " P2; echo; [ "$P1" = "$P2" ] || { echo "passwords differ"; exit 1; }; CARBBOOK_PASSWORD=$P1; export CARBBOOK_PASSWORD; unset P1 P2; docker exec -e CARBBOOK_PASSWORD carbs-server carbbook user add brett --role owner'
```
Expected: `Created owner "brett" (id 1)`.

- [ ] **Step 2: Ask the user to create the viewer account (they choose the username)**

```bash
! ssh -t pi 'read -rp "Viewer username: " U; read -rsp "New password for $U: " P1; echo; read -rsp "Repeat: " P2; echo; [ "$P1" = "$P2" ] || { echo "passwords differ"; exit 1; }; CARBBOOK_PASSWORD=$P1; export CARBBOOK_PASSWORD; unset P1 P2; docker exec -e CARBBOOK_PASSWORD carbs-server carbbook user add "$U" --role viewer'
```
Expected: `Created viewer "<name they typed>" (id 2)`.

- [ ] **Step 3: Verify (no secrets shown)**

```bash
ssh pi 'docker exec carbs-server sqlite3 /data/carbbook.db "SELECT id, username, role, substr(password_hash, 1, 9) FROM user ORDER BY id;"; docker exec carbs-server printenv CARBBOOK_PASSWORD || echo NOT_IN_CONTAINER_ENV'
```
Expected: `1|brett|owner|$argon2id`, `2|<viewer>|viewer|$argon2id`, then `NOT_IN_CONTAINER_ENV`.

---

### Task 7: Pi backups and restore scripts

**Files:**
- Create: `~/Projects/CarbBook/deploy/pi/bin/carbbook-backup.sh`
- Create: `~/Projects/CarbBook/deploy/pi/bin/carbbook-restore.sh`
- Create: `~/Projects/CarbBook/deploy/pi/bin/carbbook-restore-test.sh`
- Create: `~/Projects/CarbBook/deploy/pi/systemd/carbbook-backup.service`
- Create: `~/Projects/CarbBook/deploy/pi/systemd/carbbook-backup.timer`
- Delete: `deploy/pi/bin/.keep`, `deploy/pi/systemd/.keep`

- [ ] **Step 1: Write `deploy/pi/bin/carbbook-backup.sh`**

```bash
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
```

- [ ] **Step 2: Write `deploy/pi/bin/carbbook-restore-test.sh`**

```bash
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
```

- [ ] **Step 3: Write `deploy/pi/bin/carbbook-restore.sh`**

```bash
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
```

- [ ] **Step 4: Write `deploy/pi/systemd/carbbook-backup.service`**

```ini
[Unit]
Description=CarbBook nightly SQLite backup
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
User=pihole
Group=pihole
ExecStart=/opt/carbbook/bin/carbbook-backup.sh
TimeoutStartSec=10min
```

- [ ] **Step 5: Write `deploy/pi/systemd/carbbook-backup.timer`**

```ini
[Unit]
Description=Run CarbBook backup nightly at 03:15

[Timer]
OnCalendar=*-*-* 03:15:00
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 6: Syntax check, commit, deploy**

```bash
cd ~/Projects/CarbBook
rm -f deploy/pi/bin/.keep deploy/pi/systemd/.keep
chmod +x deploy/pi/bin/*.sh
for f in deploy/pi/bin/*.sh; do bash -n "$f" || echo "BAD $f"; done; echo SYNTAX_DONE
systemd-analyze verify deploy/pi/systemd/carbbook-backup.timer 2>&1 | grep -v 'carbbook-backup.sh' || true
git add -A deploy/pi && git commit -m "deploy: Pi backup, restore and restore-test scripts with systemd timer"
deploy/deploy.sh
```
Expected: `SYNTAX_DONE` with no `BAD` lines; no unit errors other than the script path not existing on the desktop; `carbs-server healthy`.

- [ ] **Step 7: Install and enable the timer on the Pi**

```bash
ssh pi 'sudo install -m 644 /opt/carbbook/systemd/carbbook-backup.service /opt/carbbook/systemd/carbbook-backup.timer /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now carbbook-backup.timer && systemctl list-timers carbbook-backup.timer --no-pager | sed -n 2p'
```
Expected: a line with the next run at `03:15:00` and `carbbook-backup.service`.

- [ ] **Step 8: Run a backup now and verify**

```bash
ssh pi 'sudo systemctl start carbbook-backup.service && journalctl -u carbbook-backup.service -n 1 --no-pager -o cat && ls -l /opt/carbbook/backups && gzip -t /opt/carbbook/backups/*.gz && echo GZIP_OK'
```
Expected: `backup carbbook-<stamp>.db.gz ok (users=2 foods=0 logs=0 usda=13694, <bytes> bytes); keeping 1`, one file owned by `pihole`, `GZIP_OK`.

- [ ] **Step 9: Restore test against that backup (no sentinel yet)**

```bash
ssh pi '/opt/carbbook/bin/carbbook-restore-test.sh'
```
Expected: `restoring carbbook-<stamp>.db.gz with image carbbook-server:<tag>`, `restored server: up`, `integrity=ok users=2 foods=0 usda=13694 dose_settings=3`, `RESTORE_TEST_OK`; afterwards `ssh pi 'docker ps -a --filter name=carbs-restore-test -q | wc -l; ls -d /opt/carbbook/restore-test.* 2>/dev/null | wc -l'` prints `0` and `0`.

---

### Task 8: Desktop backup pull

**Files:**
- Create: `~/Projects/CarbBook/deploy/desktop/carbbook-backup-pull.sh`
- Create: `~/Projects/CarbBook/deploy/desktop/systemd/carbbook-backup-pull.service`
- Create: `~/Projects/CarbBook/deploy/desktop/systemd/carbbook-backup-pull.timer`

- [ ] **Step 1: Write `deploy/desktop/carbbook-backup-pull.sh`**

```bash
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
```

- [ ] **Step 2: Write `deploy/desktop/systemd/carbbook-backup-pull.service`**

```ini
[Unit]
Description=Pull CarbBook backups from the Raspberry Pi
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=3h
StartLimitBurst=6

[Service]
Type=oneshot
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=%h/Projects/CarbBook/deploy/desktop/carbbook-backup-pull.sh
Restart=on-failure
RestartSec=15min
TimeoutStartSec=15min
```

- [ ] **Step 3: Write `deploy/desktop/systemd/carbbook-backup-pull.timer`**

```ini
[Unit]
Description=Pull CarbBook backups daily at 04:30 (catches up after the desktop was off)

[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 4: Verify units, link, enable**

```bash
cd ~/Projects/CarbBook
chmod +x deploy/desktop/carbbook-backup-pull.sh && bash -n deploy/desktop/carbbook-backup-pull.sh && echo SYNTAX_OK
systemd-analyze --user verify deploy/desktop/systemd/carbbook-backup-pull.service deploy/desktop/systemd/carbbook-backup-pull.timer && echo UNITS_OK
ln -sf ~/Projects/CarbBook/deploy/desktop/systemd/carbbook-backup-pull.service ~/.config/systemd/user/carbbook-backup-pull.service
ln -sf ~/Projects/CarbBook/deploy/desktop/systemd/carbbook-backup-pull.timer ~/.config/systemd/user/carbbook-backup-pull.timer
systemctl --user daemon-reload && systemctl --user enable --now carbbook-backup-pull.timer
systemctl --user list-timers carbbook-backup-pull.timer --no-pager | sed -n 2p
```
Expected: `SYNTAX_OK`, `UNITS_OK`, `Created symlink …timers.target.wants/carbbook-backup-pull.timer …`, a line showing next run `04:30:00`.
Note: the unit runs the script from the repo checkout, so the desktop checkout must stay on a branch that contains `deploy/desktop/` (main after merge).

- [ ] **Step 5: Run once and verify**

```bash
systemctl --user start carbbook-backup-pull.service; systemctl --user show carbbook-backup-pull.service -p Result --value
journalctl --user -u carbbook-backup-pull.service -n 1 --no-pager -o cat
ls -l ~/HomelabServer/appdata/carbbook-backups/
```
Expected: `success`, `ok: 1 backups, newest carbbook-<stamp>.db.gz`, the file with the same size as on the Pi.

- [ ] **Step 6: Catch-up behaviour check (Persistent)**

```bash
systemctl --user show carbbook-backup-pull.timer -p Persistent -p TimersCalendar --value
```
Expected: `yes` and `{ OnCalendar=*-*-* 04:30:00 ; next_elapse=… }`.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/CarbBook && git add deploy/desktop && git commit -m "deploy: desktop systemd timer pulling CarbBook backups from the Pi"
```

---

### Task 9: Tunnel route and DNS — **CONFIRM WITH USER before Step 4**

**Files:**
- Create: `~/Projects/CarbBook/deploy/cloudflare-route.py`

- [ ] **Step 1: Write `deploy/cloudflare-route.py`**

```python
#!/usr/bin/env python3
"""Show, add or remove the recipes.dxshdw.dev route on Cloudflare tunnel `pi`.

  cloudflare-route.py show
  cloudflare-route.py add [--apply]      # dry run unless --apply
  cloudflare-route.py remove [--apply]

Only touches the one ingress rule (inserted just before the catch-all) and the one CNAME.
The API token is read from a Claude session log and is never printed.
"""
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

TOKEN_FILE = Path.home() / ".claude/projects/-home-shadow-linux/1dc9e5ca-f3e6-4d3e-b8ac-7cfd09fe7f53.jsonl"
TOKEN_RE = re.compile(r"T='([A-Za-z0-9._-]{30,})'")
ACCOUNT = "ff4fdd9b459736d57f017e6645225586"
TUNNEL = "fdb3aebf-bc6c-48e1-bdf7-133261a745c0"
ZONE = "ed198a1135f51217415ceb107db532f3"
ZONE_NAME = "dxshdw.dev"
HOST = "recipes.dxshdw.dev"
SERVICE = "http://carbs-server:3000"
API = "https://api.cloudflare.com/client/v4"


def token() -> str:
    matches = sorted(set(TOKEN_RE.findall(TOKEN_FILE.read_text(errors="replace"))))
    if len(matches) != 1:
        sys.exit(f"expected exactly 1 distinct token in {TOKEN_FILE.name}, found {len(matches)}")
    return matches[0]


def call(method: str, path: str, body=None):
    req = urllib.request.Request(
        API + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as err:
        data = json.load(err)
    if not data.get("success"):
        sys.exit(f"{method} {path} failed: {data.get('errors')}")
    return data["result"]


def get_config():
    return call("GET", f"/accounts/{ACCOUNT}/cfd_tunnel/{TUNNEL}/configurations")["config"]


def ingress_lines(config):
    return [f"  {r.get('hostname', '*')} -> {r['service']}" for r in config["ingress"]]


def dns_records():
    return call("GET", f"/zones/{ZONE}/dns_records?name={HOST}")


def show():
    zone = call("GET", f"/zones/{ZONE}")
    if zone["name"] != ZONE_NAME:
        sys.exit(f"zone id is {zone['name']}, expected {ZONE_NAME}")
    print("ingress:")
    print("\n".join(ingress_lines(get_config())))
    recs = dns_records()
    print("dns:", [f"{r['type']} {r['name']} -> {r['content']} proxied={r['proxied']}" for r in recs] or "none")


def check_catch_all(ingress):
    if not ingress or "hostname" in ingress[-1] or ingress[-1]["service"] != "http_status:404":
        sys.exit("last ingress rule is not the http_status:404 catch-all; refusing to edit")


def add(apply: bool):
    config = get_config()
    ingress = config["ingress"]
    check_catch_all(ingress)
    existing = [r for r in ingress if r.get("hostname") == HOST]
    if existing and existing[0]["service"] != SERVICE:
        sys.exit(f"{HOST} already routed to {existing[0]['service']}; refusing to change it")
    if not existing:
        config["ingress"] = ingress[:-1] + [{"hostname": HOST, "service": SERVICE, "originRequest": {}}] + ingress[-1:]
    print("ingress after:")
    print("\n".join(ingress_lines(config)))

    recs = dns_records()
    target = f"{TUNNEL}.cfargotunnel.com"
    if recs and not (len(recs) == 1 and recs[0]["type"] == "CNAME" and recs[0]["content"] == target and recs[0]["proxied"]):
        sys.exit(f"unexpected existing DNS records for {HOST}: {[(r['type'], r['content']) for r in recs]}")
    print("dns:", "already correct" if recs else f"create CNAME {HOST} -> {target} proxied")

    if not apply:
        print("dry run; re-run with --apply")
        return
    if not existing:
        call("PUT", f"/accounts/{ACCOUNT}/cfd_tunnel/{TUNNEL}/configurations", {"config": config})
    if not recs:
        call("POST", f"/zones/{ZONE}/dns_records",
             {"type": "CNAME", "name": HOST, "content": target, "proxied": True, "comment": "CarbBook via tunnel pi"})
    print("applied; now:")
    show()


def remove(apply: bool):
    config = get_config()
    check_catch_all(config["ingress"])
    config["ingress"] = [r for r in config["ingress"] if r.get("hostname") != HOST]
    print("ingress after:")
    print("\n".join(ingress_lines(config)))
    target = f"{TUNNEL}.cfargotunnel.com"
    recs = [r for r in dns_records() if r["type"] == "CNAME" and r["content"] == target]
    print("dns: delete", [r["name"] for r in recs] or "nothing")
    if not apply:
        print("dry run; re-run with --apply")
        return
    call("PUT", f"/accounts/{ACCOUNT}/cfd_tunnel/{TUNNEL}/configurations", {"config": config})
    for r in recs:
        call("DELETE", f"/zones/{ZONE}/dns_records/{r['id']}")
    print("removed; now:")
    show()


if __name__ == "__main__":
    args = sys.argv[1:]
    apply = "--apply" in args
    cmd = next((a for a in args if not a.startswith("--")), "show")
    {"show": show, "add": lambda: add(apply), "remove": lambda: remove(apply)}.get(cmd, lambda: sys.exit(__doc__))()
```

- [ ] **Step 2: Read the current ingress and DNS (read-only)**

```bash
cd ~/Projects/CarbBook && chmod +x deploy/cloudflare-route.py && python3 deploy/cloudflare-route.py show
```
Expected:
```
ingress:
  ipa.dxshdw.dev -> http://ipa-web:80
  dexcom.dxshdw.dev -> http://dexcom-api:8000
  * -> http_status:404
dns: none
```
If the ingress differs from this (someone changed it), stop and show the user before continuing.

- [ ] **Step 3: Dry run**

```bash
python3 deploy/cloudflare-route.py add
```
Expected:
```
ingress after:
  ipa.dxshdw.dev -> http://ipa-web:80
  dexcom.dxshdw.dev -> http://dexcom-api:8000
  recipes.dxshdw.dev -> http://carbs-server:3000
  * -> http_status:404
dns: create CNAME recipes.dxshdw.dev -> fdb3aebf-bc6c-48e1-bdf7-133261a745c0.cfargotunnel.com proxied
dry run; re-run with --apply
```

- [ ] **Step 4: CONFIRM WITH USER, then apply (public exposure of recipes.dxshdw.dev)**

Show the user the dry-run output and that login is the only way in (no open signup). After a yes:

```bash
python3 deploy/cloudflare-route.py add --apply
```
Expected: `applied; now:` followed by the four ingress lines and `dns: ['CNAME recipes.dxshdw.dev -> fdb3aebf-bc6c-48e1-bdf7-133261a745c0.cfargotunnel.com proxied=True']`.

- [ ] **Step 5: Verify via public DNS (not Pi-hole yet)**

```bash
sleep 20
curl -sS --doh-url https://1.1.1.1/dns-query https://recipes.dxshdw.dev/api/health; echo
curl -sS --doh-url https://1.1.1.1/dns-query -o /dev/null -w '%{http_code} %{content_type}\n' https://recipes.dxshdw.dev/
curl -sS --doh-url https://1.1.1.1/dns-query https://dexcom.dxshdw.dev/healthz; echo
curl -sS --doh-url https://1.1.1.1/dns-query -o /dev/null -w '%{http_code}\n' https://ipa.dxshdw.dev/
```
Expected: `{"ok":true}`, `200 text/html; charset=utf-8`, `{"error":null,"ok":true}` (dexcom unchanged), and for ipa any code other than `404`/`502`/`530` (ipa route unchanged).

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook && git add deploy/cloudflare-route.py && git commit -m "deploy: Cloudflare tunnel route script for recipes.dxshdw.dev"
```

---

### Task 10: Pi-hole LAN exception — **CONFIRM WITH USER before Step 2**

**Files:** none (Pi `/etc/pihole/pihole.toml`)

- [ ] **Step 1: Check the current value is exactly what this plan expects, and back up**

```bash
ssh pi 'sudo pihole-FTL --config misc.dnsmasq_lines'
dig +short @192.168.1.148 recipes.dxshdw.dev
```
Expected: `[ address=/shadow.lab/192.168.1.210, address=/dxshdw.dev/192.168.1.210, server=/ipa.dxshdw.dev/#, server=/dexcom.dxshdw.dev/# ]` (four entries, in any display format) and `192.168.1.210` (the LAN wildcard still captures recipes). If there are more or different entries, stop and include them in Step 2.

```bash
ssh pi 'sudo cp -a /etc/pihole/pihole.toml /etc/pihole/pihole.toml.bak-2026-09-14-recipes && ls -l /etc/pihole/pihole.toml.bak-2026-09-14-recipes'
```
Expected: the backup listed.

- [ ] **Step 2: CONFIRM WITH USER (changes LAN DNS for every client), then add the exception**

```bash
ssh pi 'sudo pihole-FTL --config misc.dnsmasq_lines "[\"address=/shadow.lab/192.168.1.210\", \"address=/dxshdw.dev/192.168.1.210\", \"server=/ipa.dxshdw.dev/#\", \"server=/dexcom.dxshdw.dev/#\", \"server=/recipes.dxshdw.dev/#\"]" && sudo pihole-FTL --config misc.dnsmasq_lines'
```
Expected: the five-entry array echoed back.

- [ ] **Step 3: Verify resolution and nothing else changed**

```bash
sleep 3
dig +short @192.168.1.148 recipes.dxshdw.dev
dig +short @192.168.1.148 dexcom.dxshdw.dev
dig +short @192.168.1.148 ipa.dxshdw.dev
dig +short @192.168.1.148 jellyfin.dxshdw.dev
dig +short @192.168.1.148 google.com | head -1
curl -sS --resolve recipes.dxshdw.dev:443:$(dig +short @192.168.1.148 recipes.dxshdw.dev | head -1) https://recipes.dxshdw.dev/api/health; echo
```
Expected: Cloudflare IPs (`104.21.x.x` / `172.67.x.x`) for recipes, dexcom and ipa; `192.168.1.210` for jellyfin; an IP for google.com; `{"ok":true}`.

---

### Task 11: Deploy smoke tests (spec §10) and the tested restore

**Files:**
- Create: `~/Projects/CarbBook/deploy/smoke.sh`

- [ ] **Step 1: Write `deploy/smoke.sh`**

```bash
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
```

- [ ] **Step 2: Syntax check and commit**

```bash
cd ~/Projects/CarbBook && chmod +x deploy/smoke.sh && bash -n deploy/smoke.sh && echo SYNTAX_OK && git add deploy/smoke.sh && git commit -m "deploy: public smoke test script"
```
Expected: `SYNTAX_OK` and a commit.

- [ ] **Step 3: Owner smoke — loads over the Pi tunnel, login, BG from Pi dexcom-api, USDA, sync round-trip**

Ask the user to run (password prompt):

```bash
! ~/Projects/CarbBook/deploy/smoke.sh brett
```
Expected:
```
health    {"ok":true}
web       200 text/html; charset=utf-8
login     {"user":{"id":1,"username":"brett","role":"owner"}}
me        {"user":{"id":1,"username":"brett","role":"owner"}}
bg        {"mgdl":<number>,"arrow":"<arrow>","age_ms":<number>,"fresh":true,"error":null}
usda      {"version":"fdc-a5f82e4f92a5","food_count":13694,"portion_count":32505,"error":null}
push      {"table":"food","id":"<uuid>","status":"accepted","server_seq":<n>}
pull      [{"table":"food","id":"<uuid>","deleted":0,"server_seq":<n>}]
sentinel  <uuid>
SMOKE_OK
```
`fresh` may be `false` if the sensor is between readings; `mgdl` must be a number (a `503 bg_unavailable` is a failure — check `ssh pi docker logs --tail 20 carbs-server`). Record the sentinel UUID for Steps 4–6.

- [ ] **Step 4: Backup containing the sentinel**

```bash
ssh pi 'sudo systemctl start carbbook-backup.service && journalctl -u carbbook-backup.service -n 1 --no-pager -o cat'
```
Expected: `backup carbbook-<stamp>.db.gz ok (users=2 foods=1 logs=0 usda=13694, … bytes); keeping 2`.

- [ ] **Step 5: Tombstone the sentinel (second sync round-trip, soft delete)**

Ask the user to run, with the UUID from Step 3:

```bash
! ~/Projects/CarbBook/deploy/smoke.sh brett --tombstone <uuid printed by Step 3>
```
Expected: `push … "status":"accepted"`, `pull [{"table":"food","id":"<uuid>","deleted":1,…}]`, `SMOKE_OK`.

- [ ] **Step 6: The tested restore — backup restores to the point it was taken**

```bash
ssh pi 'SENTINEL_ID=<uuid from Step 3> /opt/carbbook/bin/carbbook-restore-test.sh'
```
Expected:
```
restoring carbbook-<stamp from Step 4>.db.gz with image carbbook-server:<tag>
restored server: up
integrity=ok users=2 foods=1 usda=13694 dose_settings=3
restored sentinel <uuid> deleted=0
live sentinel <uuid> deleted=1
RESTORE_TEST_OK
```
The restored copy boots the real image (migrations run), passes integrity, and holds the pre-tombstone state; the live DB has the later change.

- [ ] **Step 7: Backups reach the desktop**

```bash
systemctl --user start carbbook-backup-pull.service; journalctl --user -u carbbook-backup-pull.service -n 1 --no-pager -o cat
zcat "$(ls -1 ~/HomelabServer/appdata/carbbook-backups/carbbook-*.db.gz | sort | tail -n 1)" > /tmp/carbbook-desktop-check.db && sqlite3 /tmp/carbbook-desktop-check.db 'PRAGMA integrity_check; SELECT count(*) FROM food;' ; rm -f /tmp/carbbook-desktop-check.db
```
Expected: `ok: 2 backups, newest carbbook-<stamp from Step 4>.db.gz`, then `ok` and `1`.

- [ ] **Step 8: Viewer login**

```bash
! ~/Projects/CarbBook/deploy/smoke.sh <viewer username from Task 6> --login-only
```
Expected: `login {"user":{"id":2,"username":"<viewer>","role":"viewer"}}`, `bg {"mgdl":<number>,…}`, `SMOKE_OK`.

- [ ] **Step 9: Login rate limit still bites from outside (TRUST_PROXY=true + CF-Connecting-IP)**

Runs 7 wrong-password logins for a throwaway username that does not exist, so real accounts are not locked out:

```bash
~/Projects/CarbBook/deploy/smoke.sh --rate-limit
```
Expected: `ratelimit codes: 401 401 401 401 401 429 forged-header:429` and `RATE_LIMIT_OK`.
The 6th attempt proves the limiter keys on a stable per-client IP through Cloudflare; the 7th, with a forged `CF-Connecting-IP`, proves an outside client cannot rotate the header to escape the limit (Cloudflare overwrites it). If the forged request returns `401`, the server is trusting a client-supplied header: set `TRUST_PROXY=false` in `/opt/carbbook/compose.yml`, redeploy, and report it.

- [ ] **Step 10: Widgy endpoint still served from the Pi**

```bash
curl -sS https://dexcom.dxshdw.dev/healthz; echo
T=$(ssh pi "grep '^DEXCOM_API_TOKEN=' /opt/pi-infra/.env | cut -d= -f2-"); curl -sS "https://dexcom.dxshdw.dev/glucose?history=0&token=$T" | jq -c '{ok, display, minutes_ago}'; unset T
```
Expected: `{"error":null,"ok":true}` and `{"ok":true,"display":"<number + arrow>","minutes_ago":<number>}`.

- [ ] **Step 11: User checks on the phone**

Ask the user to: open `https://recipes.dxshdw.dev` on the iPhone on cellular and on Wi-Fi, sign in as `brett`, see the Calculator with a BG value, and confirm the Widgy widget still updates.

- [ ] **Step 12: Healthy after a container restart and a Pi reboot survivability check**

```bash
ssh pi 'docker restart carbs-server >/dev/null; sleep 20; docker inspect -f "{{.State.Health.Status}} restarts={{.RestartCount}}" carbs-server; systemctl is-enabled docker carbbook-backup.timer'
```
Expected: `healthy restarts=0`, `enabled`, `enabled`. (A real reboot is not required; `restart: unless-stopped` + enabled `docker.service` cover it.)

---

### Task 12: Runbook and rollback

**Files:**
- Create: `~/Projects/CarbBook/deploy/README.md`

- [ ] **Step 1: Write `deploy/README.md`**

````markdown
# CarbBook deploy (Raspberry Pi)

`https://recipes.dxshdw.dev` → Cloudflare tunnel `pi` (`fdb3aebf-bc6c-48e1-bdf7-133261a745c0`, managed by
`deploy/cloudflare-route.py`) → `cloudflared` on `pi_net` → `carbs-server:3000` in `/opt/carbbook` on `ssh pi`.

- Image built **on the Pi** by `deploy/deploy.sh` (desktop has no arm64 emulation). Tag = git short sha, kept in
  `/opt/carbbook/.env` as `CARBBOOK_TAG`; the previous tag is in `/opt/carbbook/previous-tag`.
- Data: `/opt/carbbook/data` (`carbbook.db`, `usda/`). Secrets: `/opt/carbbook/.env` (600), rebuilt by `deploy/make-env.sh`.
- No host ports. `TRUST_PROXY=true` makes the server read the client IP from `CF-Connecting-IP`; that is only
  safe because nothing but `pi_net` containers can reach it. Never add `ports:`.
- Pi-hole: `misc.dnsmasq_lines` has `server=/recipes.dxshdw.dev/#` (backup `/etc/pihole/pihole.toml.bak-2026-09-14-recipes`).
- USDA: `ssh pi /opt/carbbook/bin/usda-import.sh` (re-runnable; bundle version is content-hashed).
- Accounts: `carbbook user add <name> --role owner|viewer` inside the container; pass the password via
  `read -rs` + `docker exec -e CARBBOOK_PASSWORD` (the CLI's own prompt echoes).

## Common commands

    deploy/deploy.sh                                   # build + restart from this checkout (must be clean)
    ssh pi 'docker logs --tail 50 -f carbs-server'
    ssh pi 'cd /opt/carbbook && docker compose ps'
    deploy/smoke.sh brett                              # public smoke (prompts for password)
    python3 deploy/cloudflare-route.py show

## Backups

- Pi: `carbbook-backup.timer` 03:15 → `/opt/carbbook/backups/carbbook-YYYYmmdd-HHMMSS.db.gz`, integrity-checked, newest 14.
  Run now: `ssh pi sudo systemctl start carbbook-backup.service`.
- Desktop: user timer `carbbook-backup-pull.timer` 04:30, `Persistent=true` → `~/HomelabServer/appdata/carbbook-backups/`,
  newest 30; fails + notifies if the Pi is unreachable or the newest backup is > 36 h old.
- Restore test (non-destructive): `ssh pi /opt/carbbook/bin/carbbook-restore-test.sh [file]`.

## Rollback

1. **Bad app version:** `ssh pi 'cd /opt/carbbook && sed -i "s/^CARBBOOK_TAG=.*/CARBBOOK_TAG=$(cat previous-tag)/" .env && docker compose up -d --no-build carbs-server && docker inspect -f "{{.State.Health.Status}}" carbs-server'`
2. **Bad data:** `ssh pi /opt/carbbook/bin/carbbook-restore.sh /opt/carbbook/backups/<file>.db.gz`
   (old DB kept in `/opt/carbbook/data/pre-restore-<stamp>/`). A desktop copy can be sent back first with
   `rsync ~/HomelabServer/appdata/carbbook-backups/<file>.db.gz pi:/opt/carbbook/backups/`.
3. **Take it offline entirely:**
   - `python3 deploy/cloudflare-route.py remove` (dry run) then `--apply`
   - `ssh pi 'sudo pihole-FTL --config misc.dnsmasq_lines "[\"address=/shadow.lab/192.168.1.210\", \"address=/dxshdw.dev/192.168.1.210\", \"server=/ipa.dxshdw.dev/#\", \"server=/dexcom.dxshdw.dev/#\"]"'`
   - `ssh pi 'cd /opt/carbbook && docker compose down'` (data and backups stay on disk)
   - `ssh pi 'sudo systemctl disable --now carbbook-backup.timer'`; `systemctl --user disable --now carbbook-backup-pull.timer`
````

- [ ] **Step 2: Rollback drill (app version) — non-destructive**

Only if `previous-tag` exists (a second deploy has happened, e.g. Task 5 Step 2):

```bash
ssh pi 'cd /opt/carbbook && CUR=$(grep -E "^CARBBOOK_TAG=" .env | cut -d= -f2-) && PREV=$(cat previous-tag) && echo "current $CUR previous $PREV" \
&& sed -i "s/^CARBBOOK_TAG=.*/CARBBOOK_TAG=$PREV/" .env && docker compose up -d --no-build carbs-server && sleep 25 && docker inspect -f "{{.Config.Image}} {{.State.Health.Status}}" carbs-server \
&& sed -i "s/^CARBBOOK_TAG=.*/CARBBOOK_TAG=$CUR/" .env && docker compose up -d --no-build carbs-server && sleep 25 && docker inspect -f "{{.Config.Image}} {{.State.Health.Status}}" carbs-server'
```
Expected: `carbbook-server:<previous> healthy`, then `carbbook-server:<current> healthy`.

- [ ] **Step 3: Commit and hand the branch back**

```bash
cd ~/Projects/CarbBook && git add deploy/README.md && git commit -m "docs(deploy): Pi runbook, backups and rollback" && git log --oneline main..feat/deploy
```
Expected: the deploy commits listed. Then use superpowers:finishing-a-development-branch to merge `feat/deploy` into `main`.

---

### Task 13: Memory and knowledge base

**Files:**
- Modify: `~/.claude/projects/-home-shadow-linux/memory/project_carbbook.md`
- Modify: `~/.claude/projects/-home-shadow-linux/memory/MEMORY.md`

- [ ] **Step 1: Append a deploy section to `project_carbbook.md`**

Append (keep the existing frontmatter and body; update the "Progress" line to say server/web/deploy are done):

```markdown
**Deployed on the Pi (2026-09-14 plan `docs/superpowers/plans/2026-09-14-carbbook-deploy.md`):**
- `https://recipes.dxshdw.dev` → tunnel `pi` ingress (added via `deploy/cloudflare-route.py`, token from session log, never printed)
  → `carbs-server:3000` on `pi_net`, `/opt/carbbook` (compose from `deploy/compose.yml`). No host ports; `TRUST_PROXY=true`
  reads `CF-Connecting-IP` — safe only because nothing outside `pi_net` reaches it.
- Image built on the Pi by `deploy/deploy.sh` (desktop has no arm64 qemu); tag = git sha, `previous-tag` for rollback.
- Data `/opt/carbbook/data/carbbook.db` (USDA tables inside, bundle `fdc-…` in `data/usda`). Accounts: owner `brett` + one viewer,
  created with `read -rs` → `docker exec -e CARBBOOK_PASSWORD carbs-server carbbook user add` (CLI prompt echoes — don't use it).
- Backups: Pi timer 03:15 `sqlite3 .backup` → `/opt/carbbook/backups` (keep 14); desktop user timer 04:30 `Persistent=true`
  pulls to `~/HomelabServer/appdata/carbbook-backups` (keep 30, alerts if >36 h stale). Restore test: `ssh pi /opt/carbbook/bin/carbbook-restore-test.sh`.
- Pi-hole `misc.dnsmasq_lines` has `server=/recipes.dxshdw.dev/#`. Runbook + rollback: `deploy/README.md`.
```

- [ ] **Step 2: Add the index line to `MEMORY.md`** (it has no CarbBook entry yet)

```markdown
- [CarbBook](project_carbbook.md) — self-hosted T1D carb counter + dose estimator at recipes.dxshdw.dev on the Pi (/opt/carbbook); dosing rules, deploy, backups
```

- [ ] **Step 3: Ingest**

```bash
kb-ingest -c claude_memory ~/.claude/projects/-home-shadow-linux/memory/project_carbbook.md
```
Expected: the file reported as indexed (idempotent).

---

## Self-review

**Spec coverage**
- §2.1 `/opt/carbbook` `carbs-server` Node 22, API + built PWA, port 3000, reaches `dexcom-api` over `pi_net` → Tasks 2, 3, 4 (Step 8 checks dexcom with the token).
- §2.1 nothing binds host 80/443 → compose has no `ports`; Task 4 Step 7 verifies (also the `TRUST_PROXY` precondition).
- §2.1 tunnel `recipes.dxshdw.dev → carbs-server:3000` → Task 9 (read current ingress first, insert only before the catch-all, proxied CNAME).
- §2.1 Pi-hole exception for `recipes.` → Task 10 (`misc.dnsmasq_lines`, `server=/…/#`).
- §2.1 backups nightly `sqlite3 .backup` → desktop `~/HomelabServer/appdata/carbbook-backups/`, keep 30, one tested restore → Tasks 7, 8, 11 Steps 4–7.
- §6 USDA import + bundles on the server → Task 5 (disk check, download, import, cleanup).
- §7 initial accounts via `carbbook user add`, rate limit 5/15 min → Task 6, Task 11 Step 9.
- §10 deploy smoke: loads over the Pi tunnel, login, sync round-trip, `/api/bg` reading, Widgy endpoint from the Pi, backup restores → Task 11 Steps 3, 5, 6, 10.
- Image with native deps on arm64, healthcheck, restart policy, log rotation → Tasks 2, 3, 4 Steps 6–7.
- Rollback + CONFIRM markers (tunnel route, Pi-hole) → Tasks 9, 10, 12. Memory + kb-ingest → Task 13.

**Placeholder scan:** no TBD/TODO. Values the executor cannot know in advance are produced by earlier steps and named where used (`<uuid printed by Step 3>`, the viewer username the user typed in Task 6, image tag from `deploy.sh`).

**Consistency:** container `carbs-server`, image `carbbook-server:${CARBBOOK_TAG}`, paths `/opt/carbbook/{data,backups,bin,systemd,src}`, in-container `/data` + `/backups`, env names match `server/src/config.ts`, units `carbbook-backup.{service,timer}` (Pi) and `carbbook-backup-pull.{service,timer}` (desktop), backup filename `carbbook-YYYYmmdd-HHMMSS.db.gz` used by backup, pull, restore and restore-test scripts. The `web/dist` output path is an assumption checked in Task 1 Step 2.
