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
- Accounts (the CLI prompt hides the password and asks for confirmation):
  `ssh -t pi docker exec -it carbs-server carbbook user add <name> --role owner|viewer`

## Common commands

    deploy/deploy.sh                                   # build + restart from this checkout (tracked files must be clean)
    ssh pi 'docker logs --tail 50 -f carbs-server'
    ssh pi 'cd /opt/carbbook && docker compose ps'
    deploy/smoke.sh <username>                         # public smoke (prompts for password)
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
