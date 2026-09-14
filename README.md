# CarbBook

Self-hosted carb counter and MDI bolus estimator. Server + web PWA at `https://recipes.dxshdw.dev`
(Raspberry Pi), native iOS app (sideloaded via `https://ipa.dxshdw.dev/source.json`).

Design: `docs/superpowers/specs/2026-09-13-carbbook-design.md`. Plans: `docs/superpowers/plans/`.

## Layout

| Path | What |
|---|---|
| `packages/core` | Shared units, carb math, dose estimate, sync LWW (TypeScript) |
| `testdata/` | Unit/carb/dose vectors shared with the iOS tests — never change existing expectations |
| `server/` | Fastify API, SQLite, sync, USDA import, Open Food Facts lookup, auth |

## Development

```bash
pnpm install
pnpm test        # core + server
pnpm typecheck
pnpm --filter @carbbook/server start
pnpm --filter @carbbook/server carbbook user add <username> [--role owner|viewer]
pnpm --filter @carbbook/server carbbook import-usda <csv-dir> [<csv-dir>...]   # extracted FDC CSV folders, all at once
```

The dose estimate is informational. Any invalid input or settings produce a refusal, never a number.

## Server environment

| Variable | Default | Notes |
|---|---|---|
| `HOST` | `0.0.0.0` | |
| `PORT` | `3000` | |
| `DATABASE_PATH` | `/data/carbbook.db` | SQLite file |
| `WEB_DIR` | unset | Built web PWA to serve; API-only when unset |
| `USDA_DIR` | `/data/usda` | USDA bundle files + manifest |
| `DEXCOM_API_URL` | `http://dexcom-api:8000` | Internal dexcom-api on `pi_net` |
| `DEXCOM_API_TOKEN` | unset | Sent upstream only, never returned to clients |
| `OFF_BASE_URL` | `https://world.openfoodfacts.org` | |
| `OFF_USER_AGENT` | `CarbBook/0.1 (https://recipes.dxshdw.dev)` | Contact is the site URL, not an email |
| `HTTP_TIMEOUT_MS` | `5000` | Upstream timeouts |
| `COOKIE_SECURE` | `true` | |
| `TRUST_PROXY` | `false` | `true` behind cloudflared: client IP from `CF-Connecting-IP`. Only safe when the server has no published ports |
| `CARBBOOK_PASSWORD` | unset | CLI only: non-interactive password for `user add` |
