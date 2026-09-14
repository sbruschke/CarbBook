# CarbBook — Design Spec

Date: 2026-09-13
Status: approved in brainstorming, pending written-spec review

## 1. Purpose

A self-hosted carb counter and MDI bolus estimator for one type 1 diabetic (owner)
plus one secondary account (viewer). Search foods and saved meals, enter amounts in
any sensible unit or number of servings, see total carbs, get an insulin dose
estimate from the owner's ratio schedule, correction scale and current Dexcom BG,
and log what was eaten and dosed.

Clients:
- **Web PWA** at `https://recipes.dxshdw.dev`, works offline and syncs on reconnect.
- **Native iOS app** (sideloaded via LiveContainer), works offline and syncs on reconnect.

Non-goals: recipe instructions/photos, macro tracking beyond carbs + fiber, insulin-on-board
math, pump integration, App Store distribution.

## 2. Architecture

```
iPhone app (SwiftUI + GRDB SQLite)  ─┐
                                     ├─ HTTPS ─ Cloudflare ─ cloudflared (Pi) ─ carbs-server
Web PWA (React + Dexie/IndexedDB)   ─┘                                        │
                                                                              ├─ SQLite (/data/carbbook.db)
                                                                              └─ dexcom-api (Pi, internal)
```

### 2.1 Host: Raspberry Pi 5 (8 GB, aarch64, Debian 13) at 192.168.1.148

- Also runs Pi-hole v6 natively (holds :80/:443) — nothing in this stack binds host 80/443.
- Docker Engine + compose plugin installed for this project.
- Compose project at `/opt/carbbook/` (on the Pi), services:
  - `carbs-server` — Node 22, Fastify, better-sqlite3. Serves API + built web PWA. Internal port 3000.
  - `dexcom-api` — the existing container from `~/HomelabServer/dexcom-api/`, moved off the desktop.
    Same env (`DEXCOM_*`), same endpoints. Internal only to `carbs-server`, and also published
    as `dexcom.dxshdw.dev` for the Widgy widget.
  - `cloudflared` — a **new** tunnel (`pi`), separate from the desktop's `homelab` tunnel, with
    public hostnames `recipes.dxshdw.dev → carbs-server:3000` and
    `dexcom.dxshdw.dev → dexcom-api:8000`.
- Migration of dexcom: bring up on Pi, switch the `dexcom.dxshdw.dev` hostname from the desktop
  tunnel to the Pi tunnel, verify the widget, then remove `dexcom-api` from
  `~/HomelabServer/compose.infra.yml` and its Caddy route.
- LAN DNS: Pi-hole currently overrides `*.dxshdw.dev → 192.168.1.210`. Add exceptions so
  `recipes.` and `dexcom.dxshdw.dev` resolve publicly (via Cloudflare) from the LAN.
- Backups: nightly `sqlite3 .backup` on the Pi → copied to the desktop
  (`~/HomelabServer/appdata/carbbook-backups/`), keep 30 days. One restore is tested during deploy.

### 2.2 Repo layout (`~/Projects/CarbBook/`, single git repo)

```
packages/core/     TypeScript: units, carb math, dose calc, sync merge, shared types
server/            Fastify API, SQLite schema/migrations, USDA import, OFF lookup, auth
web/               React + Vite PWA, Dexie local store, sync client
ios/               SwiftUI app, XcodeGen project.yml, GRDB, VisionKit scanner
testdata/          dose-vectors.json, units-vectors.json (shared by TS and Swift tests)
deploy/            Pi compose file, cloudflared notes, backup script
.github/workflows/ build-ipa + release (LiveContainer source.json), same shape as Cipherbook
```

## 3. Data model

All synced tables share: `id` (UUIDv7 text), `updated_at` (int ms, client clock),
`updated_by` (device id), `deleted` (0/1), `server_seq` (int, assigned by server on accept).

- **food** — `name`, `brand?`, `source` (`usda` | `off` | `custom`), `source_ref?` (FDC id / barcode),
  `carbs_per_100g`, `fiber_per_100g?`, `density_g_per_ml?`, `notes?`.
  A USDA food edited by the user becomes a `custom` copy (`derived_from` = original id);
  the original stays untouched.
- **portion** — `food_id`, `label` (e.g. "cup", "slice", "label serving"), `kind`
  (`volume` | `count` | `serving`), `quantity` (e.g. 1), `grams`. Editable, user can add their own.
- **barcode** — `code`, `food_id`. Multiple codes may map to one food.
- **meal** — `name`, `yield_servings` (default 1), `total_weight_g?`, `notes?`.
- **meal_item** — `meal_id`, `ref_type` (`food` | `meal`), `ref_id`, `amount`, `unit`, `position`.
  Cycles (meal containing itself directly or transitively) are rejected on save.
- **log_entry** — `eaten_at`, `window_name`, `bg_mgdl?`, `bg_source` (`dexcom` | `manual` | `none`),
  `bg_trend?`, `total_carbs_g`, `suggested_units?`, `taken_units?`, `settings_version_id`, `notes?`.
- **log_item** — `log_entry_id`, `ref_type`, `ref_id`, `display_name`, `amount`, `unit`, `carbs_g`
  (snapshot at log time).
- **dose_settings** (versioned; newest `effective_from` ≤ now applies) —
  `effective_from`, `windows` (JSON: `[{name, start "HH:MM", ratio_g_per_unit}]`, sorted,
  end = next start, wrapping midnight), `correction` (JSON: `{threshold, step, units_per_step,
  mode: started|full|proportional}`), `rounding` (JSON: `{increment, round_down_below_bg}`).
- **user** (server only, not synced) — `username`, `password_hash` (argon2id), `role` (`owner` | `viewer`).
- **usda_food / usda_portion** — read-only reference library, not per-record synced; shipped as a
  versioned bundle (see §6).

Seed `dose_settings` (effective 2026-08-12):
- windows: Breakfast 05:00 → 1:8, AM Snack 09:00 → 1:10, Lunch 11:00 → 1:8,
  PM Snack 14:00 → 1:10, Dinner 16:30 → 1:8, HS Snack 19:30 → 1:12 (covers until 05:00).
- correction: threshold 200, step 50, units_per_step 1, mode `started`.
- rounding: increment 1, round_down_below_bg 130.
Historical rows from the owner's sliding-scale file (2025-07-19, 2025-08-20) are imported as
older versions for record keeping.

## 4. Core logic (`packages/core`, mirrored in Swift)

### 4.1 Units
- Mass: g, kg, oz, lb — always available.
- Volume: ml, l, tsp, tbsp, fl oz, cup — available when the food has `density_g_per_ml`
  or any `volume` portion (density derived from it).
- Count/serving: the food's own `count`/`serving` portions.
- Meals: `serving` always; `g` when `total_weight_g` is set.
- Unit picker shows only units valid for the item.

### 4.2 Carbs
- Food: `grams(amount, unit) × carbs_per_100g / 100`.
- Meal per serving: `Σ item carbs / yield_servings`; per gram: `Σ item carbs / total_weight_g`.
- Nested meals resolve recursively; any item with missing carb data marks the total **incomplete**.

### 4.3 Dose estimate
1. Window = last window whose start ≤ time of eating (start inclusive; wraps past midnight).
2. `meal_units = carbs / ratio`.
3. Correction (BG present, BG > threshold):
   - `started`: `ceil((BG − threshold) / step) × units_per_step`
   - `full`: `floor((BG − threshold) / step) × units_per_step`
   - `proportional`: `(BG − threshold) / step × units_per_step`
   BG ≤ threshold → 0.
4. `raw = meal_units + correction`.
5. Round to `increment`: if BG present and BG < `round_down_below_bg` → round **down**; else round
   half-up.
6. No suggestion if carbs are incomplete. No insulin-on-board subtraction. If a dose was logged
   within the last 4 hours, show a warning.
7. UI always shows the breakdown, e.g. `72g ÷ 8 = 9.0 + BG 263 → 2u = 11.0 → 11u`, labeled as an estimate.

### 4.4 BG
- `carbs-server` proxies `dexcom-api` at `GET /api/bg`; the client prefills BG if the reading is
  ≤ 15 min old, otherwise asks for manual entry. Offline → manual entry.

## 5. Sync

- Push: `POST /api/sync/push` with changed records since last successful push.
  Server accepts per record: if incoming `updated_at` > stored (tie → higher `updated_by`
  lexicographically), overwrite and assign new `server_seq`; else ignore (client will pull the winner).
- Pull: `GET /api/sync/pull?since=<seq>` returns records with `server_seq > since`, paged.
- Order per sync: push, then pull until drained. Triggered on launch, on reconnect, after local
  writes (debounced 2 s), and every 60 s while online.
- Deletes are soft (`deleted=1`); nothing is hard-deleted by sync.
- Pending changes survive app/browser restarts; UI shows "last synced" and pending count.
- Client clock skew is tolerated (LWW is per-record and conflicts are rare with two users).
- USDA library is not synced row-by-row: clients download a versioned bundle (SQLite file for iOS,
  compressed JSON for web) once and on version change.

## 6. Food data

- **USDA FoodData Central** — Foundation, SR Legacy, and FNDDS/Survey datasets (~15k foods with
  gram-weighted portions like "1 cup, cooked"). Imported by a server script from the official CSV
  downloads; branded dataset excluded.
- **Open Food Facts** — `GET /api/barcode/:code`: check local `barcode` table first, else query OFF,
  normalize (carbs/100 g, fiber, serving size → portion), return a draft the user confirms before it
  is saved as a `food` (`source=off`). Offline: known barcodes resolve locally; unknown codes are
  queued with a note to look up later.
- Search: server uses SQLite FTS5; clients search locally (FTS5 in GRDB, a prebuilt index in web).
  Ranking: user's meals and custom foods first, then recently logged, then USDA.

## 7. Auth and roles

- Web: session cookie (httpOnly, Secure, SameSite=Lax), 30-day sliding expiry.
- iOS: long-lived bearer token issued at login, revocable from Settings.
- Login rate limit: 5 attempts / 15 min per IP + username.
- `owner`: everything. `viewer`: read everything; create/edit foods, meals, log entries;
  cannot change dose settings or users. Enforced server-side on push (rejected records reported back).
- Initial accounts created with a server CLI command (`carbbook user add`).

## 8. UI

Same screens on web and iOS:
- **Calculator (home)** — unified search (meals, foods, recents, USDA) + barcode button; item rows
  with amount + unit picker (or servings for meals) and live carbs; BG with trend + age; window
  (auto, overridable); dose breakdown; **Log it** (editable taken dose); **Save as meal**
  (yield servings, optional total weight).
- **Foods** — list/search; create from label (serving size + carbs → per 100 g); edit any field and
  portions; scan barcode.
- **Meals** — list; edit name, yield, weight, and components (add/remove/reorder, change amount/unit)
  at any time; live per-serving carbs.
- **Log** — per-day list with carbs, BG, doses, day totals; edit any entry; **Recalculate from current
  meal** refreshes an entry's snapshot from current food/meal data.
- **Settings** — dose settings editor (windows: add/remove/rename/times/ratios; correction: threshold,
  step, units per step, mode; rounding: increment, round-down BG), saved as a new version with an
  effective date; version history; users (owner only); sync status; sign out.
- Web barcode scanning: `BarcodeDetector` where supported, ZXing fallback. iOS: VisionKit
  `DataScannerViewController`.

## 9. Error handling

- Incomplete carb data → item flagged, no dose suggestion.
- Stale/unavailable BG → manual entry field, never silently omitted from the breakdown.
- Sync errors → retry with backoff; auth expiry → prompt re-login without losing pending changes.
- OFF lookup failure/timeout (5 s) → manual food entry prefilled with the barcode.
- Server validation failures on push are returned per record and shown in Settings → Sync.

## 10. Testing

- `testdata/dose-vectors.json` run by Vitest (core) and XCTest (iOS). Must include:
  BG 200 → 0u, 201 → 1u, 250 → 1u, 251 → 2u; BG 125 with 9.9u raw → 9u; BG 140 with 9.5u raw → 10u;
  23:30 and 04:59 → 1:12; 09:00 → 1:10; 08:59 → 1:8; all three correction modes; incomplete carbs.
- `testdata/units-vectors.json`: mass conversions, volume via density, count portions, meal servings
  and grams, nested meals.
- Sync tests: two simulated clients editing/deleting offline, reconnecting; LWW ties; viewer
  permission rejections.
- Playwright e2e (web): login, search, add items with units, log, save meal, edit meal, go offline,
  log, reconnect, verify server state.
- Deploy smoke: `recipes.dxshdw.dev` loads over the Pi tunnel, login, sync round-trip, `/api/bg`
  returns a reading, Widgy endpoint works from the Pi, backup restores.
- iOS: CI build on every push; device smoke via LiveContainer (launch, login, offline log, sync).

## 11. Delivery order

1. `packages/core` + test vectors.
2. `server` (schema, auth, sync, USDA import, OFF lookup, BG proxy).
3. `web` PWA.
4. Pi deploy: Docker, compose, new tunnel, dexcom migration, Pi-hole exceptions, backups.
5. `ios` app + release pipeline.

Steps 1–4 are usable without the iOS app.
