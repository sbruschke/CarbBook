# CarbBook Server Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `@carbbook/server` foundation: config, SQLite schema + migrations, seeded dose settings (with history), argon2id users + `carbbook user add` CLI, cookie/bearer sessions with login rate limiting, the `/api/bg` Dexcom proxy, and static serving of the built web PWA.

**Architecture:** A pnpm workspace package at `server/` exposing `buildApp({ db, config, deps })`, a Fastify 5 app factory that tests drive with `app.inject`. SQLite via better-sqlite3 with plain numbered SQL migrations tracked in `PRAGMA user_version`. External HTTP services (dexcom-api now; Open Food Facts in the data plan) and the clock are injected through `deps`, so no unit test touches the network. TypeScript runs directly with `tsx` (no build step), matching how `@carbbook/core` is consumed as source.

**Tech Stack:** Node 22 LTS target (developed on Node 25), pnpm 10, TypeScript ^7 (strict), Vitest ^5, fastify 5.12.4, @fastify/cookie 11.1.2, @fastify/rate-limit 11.2.0, @fastify/static 10.1.3, better-sqlite3 13.0.3 (+ @types/better-sqlite3 9.6.0), @node-rs/argon2 2.2.1, tsx 4.23.13, @types/node 22.20.2.

**Spec:** `docs/superpowers/specs/2026-09-13-carbbook-design.md` — this plan covers §2.2 `server/`, §3 schema + seed, §4.4 BG proxy, §7 auth/roles, §9 server error handling. **Second plan:** `docs/superpowers/plans/2026-09-14-carbbook-server-data.md` (sync §5, USDA import + bundles + FTS5 search + Open Food Facts §6, sync tests §10). Execute this plan first.

**Branch:** `feat/server`, branched from `feat/core` after the pending core fix (createCatalog skips `deleted === 1` rows) has landed. The server never depends on that internal behavior — it filters deleted rows itself.

---

## Verified facts this plan relies on (2026-09-14)

- Versions above are the current `npm view` results; all were installed and exercised in a scratch copy of this workspace (full plan code: 49 tests passing, `tsc` clean).
- better-sqlite3 13.0.3 ships prebuilt binaries in `prebuilds/` (`linux-arm64`, `linuxmusl-arm64`, `linux-x64`, …) and bundles SQLite 3.53.4 with FTS5 (`tokenize = 'unicode61 remove_diacritics 2'` works). pnpm 10 prints "Ignored build scripts: better-sqlite3, esbuild" — harmless, the prebuilt binary loads.
- @node-rs/argon2 2.2.1 has `@node-rs/argon2-linux-arm64-gnu` and `-musl` prebuilt packages; `hash()` defaults to argon2id (`$argon2id$v=19$m=19456,t=2,p=1$…`).
- @fastify/rate-limit's default key generator runs at `onRequest` (no body yet). Per-route `config.rateLimit` with `hook: 'preHandler'` and a custom `keyGenerator` can key on the parsed `username` — verified: the 6th attempt returns 429.
- @fastify/static with `wildcard: false` + `setNotFoundHandler` gives SPA fallback while `/api/*` stays JSON 404.
- dexcom-api (`~/HomelabServer/dexcom-api/app.py`): `GET /glucose?history=0` returns `{ok, mgdl, unit, delta, arrow, trend_direction, epoch (s), …}`; `ok:false` with `error` when no data; requires `Authorization: Bearer <API_TOKEN>` when the container has `API_TOKEN` set.
- Vitest 5 reports a missing module as `Error: Cannot find module '../src/x' imported from …`.

## Decisions and open questions for the owner

1. **Historical sliding-scale rows are ambiguous.** The 2025-07-19 ("threshold 120 / BG fix 8 / iteration 10") and 2025-08-20 ("120 / 6 / 10") rows are stored as `correction {threshold: 120, step: 10, units_per_step: 8|6, mode: 'started'}`. Read literally that is 8 units per 10 mg/dL — almost certainly not what "fix" meant (it may be a divisor/ISF or a flat dose). They are record-keeping only: `activeSettings` picks the 2026-08-12 row for any date after 2026-08-12. **Please confirm what "BG fix" and "iteration" meant** so the history can be corrected.
2. Historical rows reuse the seed windows (per instructions) and the seed rounding (increment 1, round down below BG 130) — rounding was not specified for them.
3. `effective_from` for seed rows is local midnight **America/Chicago** (this machine's zone, CDT −05:00) on each date.
4. The login limit counts every attempt (success or failure) per IP + lower-cased username, 5 per 15 minutes, in memory (resets on restart). Behind cloudflared set `TRUST_PROXY=true`, otherwise every request shares cloudflared's IP (the username part still limits).
5. User management is CLI-only (`carbbook user add`). The spec's Settings → Users screen needs an API that is not in either server plan.
6. `OFF_USER_AGENT` defaults to `CarbBook/0.1 (self-hosted)`. Open Food Facts asks for `AppName/Version (ContactEmail)` — set it with your contact email at deploy time.
7. Runtime uses `tsx` (a production dependency). The Pi/Docker plan may prefer an esbuild bundle; nothing here prevents that.

---

## File structure

```
pnpm-workspace.yaml                 add `server`
server/package.json                 @carbbook/server, pinned deps, scripts test/typecheck/start/carbbook
server/tsconfig.json                extends ../tsconfig.base.json, node types
server/migrations/001_init.sql      synced tables + seq_counter + user + auth_session
server/src/config.ts                loadConfig(env) → Config (validated env vars)
server/src/db.ts                    openDb, migrate (user_version), nextServerSeq/currentServerSeq
server/src/seed.ts                  SEED_DOSE_SETTINGS (history + current), seedDoseSettings
server/src/init.ts                  initDatabase(path) = open + migrate + seed
server/src/errors.ts                ApiError + Fastify error handler → { error, message }
server/src/context.ts               AppDeps (injected clock + HTTP clients), AppContext
server/src/app.ts                   buildApp({ db, config, deps, logger })
server/src/auth/passwords.ts        argon2id hash/verify
server/src/auth/users.ts            createUser, findUserByUsername, getUser
server/src/auth/sessions.ts         token → sha256 id, create/resolve (sliding)/revoke/list
server/src/auth/plugin.ts           session cookie options, authenticate hook, requireAuth
server/src/routes/auth.ts           login (rate limited), me, logout, bearer token list/revoke
server/src/bg/client.ts             dexcom-api client (BgClient)
server/src/routes/bg.ts             GET /api/bg
server/src/static.ts                web PWA static dir + SPA fallback + JSON 404
server/src/cli.ts                   `carbbook user add`
server/src/main.ts                  process entry: config → db → listen
server/test/helpers.ts              makeTestApp, TestClock, addUser, loginCookie, loginBearer
server/test/fixtures.ts             fixture paths
server/test/fixtures/web/…          index.html + assets/app.js
server/test/*.test.ts               one file per task
```

---

### Task 1: Scaffold `@carbbook/server`

**Files:**
- Modify: `pnpm-workspace.yaml`
- Create: `server/package.json`, `server/tsconfig.json`
- Test: `server/test/smoke.test.ts`

- [ ] **Step 1: Add the package to the workspace**

`pnpm-workspace.yaml` (full file):
```yaml
packages:
  - packages/*
  - server
```

`server/package.json`:
```json
{
  "name": "@carbbook/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json",
    "start": "tsx src/main.ts",
    "carbbook": "tsx src/cli.ts"
  },
  "dependencies": {
    "@carbbook/core": "workspace:*",
    "@fastify/cookie": "11.1.2",
    "@fastify/rate-limit": "11.2.0",
    "@fastify/static": "10.1.3",
    "@node-rs/argon2": "2.2.1",
    "better-sqlite3": "13.0.3",
    "csv-parse": "7.0.2",
    "fastify": "5.12.4",
    "tsx": "4.23.13"
  },
  "devDependencies": {
    "@types/better-sqlite3": "9.6.0",
    "@types/node": "22.20.2",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```
(`csv-parse` is used by the data plan; installing it now keeps the lockfile change in one commit.)

`server/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test"]
}
```

- [ ] **Step 2: Write the smoke test**

`server/test/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isNewer } from '@carbbook/core';

describe('server workspace', () => {
  it('imports @carbbook/core', () => {
    expect(isNewer({ updated_at: 2, updated_by: 'a' }, undefined)).toBe(true);
  });
});
```

- [ ] **Step 3: Install**

Run: `cd ~/Projects/CarbBook && pnpm install`
Expected: ends with `Done in …`; a boxed warning "Ignored build scripts: better-sqlite3@13.0.3, esbuild@0.28.2" is expected and harmless.

- [ ] **Step 4: Run the smoke test**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/smoke.test.ts`
Expected: `Test Files  1 passed (1)` and `Tests  1 passed (1)`.

- [ ] **Step 5: Confirm the native modules load (no build scripts needed)**

Run:
```bash
cd ~/Projects/CarbBook/server && node -e '
const Database = require("better-sqlite3");
const db = new Database(":memory:");
db.exec("CREATE VIRTUAL TABLE t USING fts5(name)");
require("@node-rs/argon2").hash("x").then((h) => console.log(db.prepare("select sqlite_version() v").get().v, h.slice(0, 10)));
'
```
Expected: `3.53.4 $argon2id$`

- [ ] **Step 6: Typecheck**

Run: `cd ~/Projects/CarbBook/server && pnpm typecheck`
Expected: exits 0 with no output after the `tsc -p tsconfig.json` banner.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/CarbBook
git add pnpm-workspace.yaml pnpm-lock.yaml server/package.json server/tsconfig.json server/test/smoke.test.ts
git commit -m "chore(server): scaffold @carbbook/server workspace package"
```

---

### Task 2: Config from environment

**Files:**
- Create: `server/src/config.ts`
- Test: `server/test/config.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      host: '0.0.0.0',
      port: 3000,
      databasePath: '/data/carbbook.db',
      webDir: null,
      usdaDir: '/data/usda',
      dexcomApiUrl: 'http://dexcom-api:8000',
      dexcomApiToken: null,
      offBaseUrl: 'https://world.openfoodfacts.org',
      offUserAgent: 'CarbBook/0.1 (self-hosted)',
      httpTimeoutMs: 5000,
      cookieSecure: true,
      trustProxy: false,
    });
  });

  it('reads overrides and trims trailing slashes from URLs', () => {
    const config = loadConfig({
      PORT: '8080',
      WEB_DIR: '/srv/web',
      DEXCOM_API_URL: 'http://localhost:9000/',
      DEXCOM_API_TOKEN: 'secret',
      COOKIE_SECURE: 'false',
      TRUST_PROXY: 'true',
    });
    expect(config.port).toBe(8080);
    expect(config.webDir).toBe('/srv/web');
    expect(config.dexcomApiUrl).toBe('http://localhost:9000');
    expect(config.dexcomApiToken).toBe('secret');
    expect(config.cookieSecure).toBe(false);
    expect(config.trustProxy).toBe(true);
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ COOKIE_SECURE: 'maybe' })).toThrow(ConfigError);
    expect(() => loadConfig({ OFF_BASE_URL: 'not a url' })).toThrow(ConfigError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/config.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/config' imported from …/server/test/config.test.ts`

- [ ] **Step 3: Implement**

`server/src/config.ts`:
```ts
export interface Config {
  host: string;
  port: number;
  databasePath: string;
  /** Directory holding the built web PWA; null disables static serving. */
  webDir: string | null;
  /** Where USDA bundle files and manifest.json are written and served from. */
  usdaDir: string;
  dexcomApiUrl: string;
  dexcomApiToken: string | null;
  offBaseUrl: string;
  offUserAgent: string;
  httpTimeoutMs: number;
  cookieSecure: boolean;
  trustProxy: boolean;
}

export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

function text(env: Env, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

function optionalText(env: Env, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function boolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${name} must be true or false, got "${raw}"`);
}

function absoluteUrl(env: Env, name: string, fallback: string): string {
  const value = text(env, name, fallback);
  if (!URL.canParse(value)) throw new ConfigError(`${name} must be an absolute URL, got "${value}"`);
  return value.replace(/\/+$/, '');
}

export function loadConfig(env: Env = process.env): Config {
  return {
    host: text(env, 'HOST', '0.0.0.0'),
    port: integer(env, 'PORT', 3000, 1, 65535),
    databasePath: text(env, 'DATABASE_PATH', '/data/carbbook.db'),
    webDir: optionalText(env, 'WEB_DIR'),
    usdaDir: text(env, 'USDA_DIR', '/data/usda'),
    dexcomApiUrl: absoluteUrl(env, 'DEXCOM_API_URL', 'http://dexcom-api:8000'),
    dexcomApiToken: optionalText(env, 'DEXCOM_API_TOKEN'),
    offBaseUrl: absoluteUrl(env, 'OFF_BASE_URL', 'https://world.openfoodfacts.org'),
    offUserAgent: text(env, 'OFF_USER_AGENT', 'CarbBook/0.1 (self-hosted)'),
    httpTimeoutMs: integer(env, 'HTTP_TIMEOUT_MS', 5000, 100, 60000),
    cookieSecure: boolean(env, 'COOKIE_SECURE', true),
    trustProxy: boolean(env, 'TRUST_PROXY', false),
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/config.test.ts`
Expected: `Tests  3 passed (3)`

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/config.ts server/test/config.test.ts
git commit -m "feat(server): load and validate config from environment"
```

---

### Task 3: Migration runner and schema 001

**Files:**
- Create: `server/src/db.ts`, `server/migrations/001_init.sql`
- Test: `server/test/db.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/db.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentServerSeq, migrate, nextServerSeq, openDb } from '../src/db';

describe('migrate', () => {
  it('applies numbered files in order once and records user_version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'carbbook-mig-'));
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x INTEGER);');
    writeFileSync(join(dir, '002_b.sql'), 'CREATE TABLE b (y INTEGER);');
    writeFileSync(join(dir, 'README.txt'), 'ignored');
    const db = openDb(':memory:');
    expect(migrate(db, dir)).toBe(2);
    expect(migrate(db, dir)).toBe(2);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all();
    expect(tables).toEqual(['a', 'b']);
  });

  it('rolls back a failing migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'carbbook-mig-'));
    writeFileSync(join(dir, '001_ok.sql'), 'CREATE TABLE ok (x INTEGER);');
    writeFileSync(join(dir, '002_bad.sql'), 'CREATE TABLE half (x INTEGER); THIS IS NOT SQL;');
    const db = openDb(':memory:');
    expect(() => migrate(db, dir)).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get()).toBeUndefined();
  });
});

describe('schema 001', () => {
  it('creates every synced table with sync metadata columns', () => {
    const db = openDb(':memory:');
    migrate(db);
    for (const table of ['food', 'portion', 'barcode', 'meal', 'meal_item', 'log_entry', 'log_item', 'dose_settings']) {
      const columns = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).pluck().all();
      expect(columns, table).toEqual(expect.arrayContaining(['id', 'updated_at', 'updated_by', 'deleted', 'server_seq']));
    }
  });

  it('enforces enum CHECK constraints', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO food (id, name, source, updated_at, updated_by, server_seq) VALUES ('f1', 'x', 'bogus', 1, 'd', 1)",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('hands out increasing server_seq values', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(currentServerSeq(db)).toBe(0);
    expect(nextServerSeq(db)).toBe(1);
    expect(nextServerSeq(db)).toBe(2);
    expect(currentServerSeq(db)).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/db.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/db' imported from …/server/test/db.test.ts`

- [ ] **Step 3: Implement the runner**

`server/src/db.ts`:
```ts
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Applies `NNN_name.sql` files newer than `PRAGMA user_version`, each in its own transaction. */
export function migrate(db: Db, dir: string = MIGRATIONS_DIR): number {
  const files = readdirSync(dir)
    .filter((file) => /^\d{3}_[\w-]+\.sql$/.test(file))
    .sort();
  let version = db.pragma('user_version', { simple: true }) as number;
  for (const file of files) {
    const target = Number(file.slice(0, 3));
    if (target <= version) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${target}`);
    })();
    version = target;
  }
  return version;
}

/** Next global sync sequence number. Call inside the transaction that writes the row. */
export function nextServerSeq(db: Db): number {
  const row = db.prepare('UPDATE seq_counter SET value = value + 1 WHERE id = 1 RETURNING value').get() as {
    value: number;
  };
  return row.value;
}

export function currentServerSeq(db: Db): number {
  return (db.prepare('SELECT value FROM seq_counter WHERE id = 1').get() as { value: number }).value;
}
```

- [ ] **Step 4: Write the schema**

`server/migrations/001_init.sql`:
```sql
-- CarbBook schema v1 (spec §3). Synced tables share id/updated_at/updated_by/deleted/server_seq.

CREATE TABLE seq_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL
);
INSERT INTO seq_counter (id, value) VALUES (1, 0);

CREATE TABLE food (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT,
  source TEXT NOT NULL CHECK (source IN ('usda', 'off', 'custom')),
  source_ref TEXT,
  derived_from TEXT,
  carbs_per_100g REAL,
  fiber_per_100g REAL,
  density_g_per_ml REAL,
  notes TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX food_server_seq ON food (server_seq);

CREATE TABLE portion (
  id TEXT PRIMARY KEY,
  food_id TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('volume', 'count', 'serving')),
  quantity REAL NOT NULL,
  grams REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX portion_server_seq ON portion (server_seq);
CREATE INDEX portion_food ON portion (food_id);

CREATE TABLE barcode (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  food_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX barcode_server_seq ON barcode (server_seq);
CREATE INDEX barcode_code ON barcode (code);

CREATE TABLE meal (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  yield_servings REAL NOT NULL DEFAULT 1,
  total_weight_g REAL,
  notes TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX meal_server_seq ON meal (server_seq);

CREATE TABLE meal_item (
  id TEXT PRIMARY KEY,
  meal_id TEXT NOT NULL,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('food', 'meal')),
  ref_id TEXT NOT NULL,
  amount REAL NOT NULL,
  unit TEXT NOT NULL,
  position INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX meal_item_server_seq ON meal_item (server_seq);
CREATE INDEX meal_item_meal ON meal_item (meal_id);

CREATE TABLE log_entry (
  id TEXT PRIMARY KEY,
  eaten_at INTEGER NOT NULL,
  window_name TEXT,
  bg_mgdl REAL,
  bg_source TEXT NOT NULL CHECK (bg_source IN ('dexcom', 'manual', 'none')),
  bg_trend TEXT,
  total_carbs_g REAL NOT NULL,
  suggested_units REAL,
  taken_units REAL,
  settings_version_id TEXT,
  notes TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX log_entry_server_seq ON log_entry (server_seq);
CREATE INDEX log_entry_eaten_at ON log_entry (eaten_at);

CREATE TABLE log_item (
  id TEXT PRIMARY KEY,
  log_entry_id TEXT NOT NULL,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('food', 'meal')),
  ref_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  amount REAL NOT NULL,
  unit TEXT NOT NULL,
  carbs_g REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX log_item_server_seq ON log_item (server_seq);
CREATE INDEX log_item_entry ON log_item (log_entry_id);
CREATE INDEX log_item_ref ON log_item (ref_id);

-- windows/correction/rounding hold JSON text; the sync layer (de)serializes them.
CREATE TABLE dose_settings (
  id TEXT PRIMARY KEY,
  effective_from INTEGER NOT NULL,
  windows TEXT NOT NULL,
  correction TEXT NOT NULL,
  rounding TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX dose_settings_server_seq ON dose_settings (server_seq);

-- Server-only tables (not synced).
CREATE TABLE user (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'viewer')),
  created_at INTEGER NOT NULL
);

-- id = sha256(token) hex; the raw token is only ever held by the client.
CREATE TABLE auth_session (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('cookie', 'bearer')),
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX auth_session_user ON auth_session (user_id);
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/db.test.ts`
Expected: `Tests  5 passed (5)`

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/db.ts server/migrations/001_init.sql server/test/db.test.ts
git commit -m "feat(server): SQLite migration runner and initial schema"
```

---

### Task 4: Seed dose settings with history

**Files:**
- Create: `server/src/seed.ts`, `server/src/init.ts`
- Test: `server/test/seed.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/seed.test.ts`:
```ts
import { activeSettings, estimateDose, type DoseSettingsData } from '@carbbook/core';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../src/db';
import { initDatabase } from '../src/init';
import { SEED_DOSE_SETTINGS, seedDoseSettings } from '../src/seed';

function loadSettings(db: ReturnType<typeof openDb>): DoseSettingsData[] {
  const rows = db
    .prepare('SELECT id, effective_from, windows, correction, rounding FROM dose_settings WHERE deleted = 0')
    .all() as { id: string; effective_from: number; windows: string; correction: string; rounding: string }[];
  return rows.map((r) => ({
    id: r.id,
    effective_from: r.effective_from,
    windows: JSON.parse(r.windows),
    correction: JSON.parse(r.correction),
    rounding: JSON.parse(r.rounding),
  }));
}

describe('seedDoseSettings', () => {
  it('inserts the current version plus two historical versions, idempotently', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(seedDoseSettings(db)).toBe(3);
    expect(seedDoseSettings(db)).toBe(0);
    const seqs = db.prepare('SELECT server_seq FROM dose_settings ORDER BY effective_from').pluck().all();
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('stores the owner history exactly as specified', () => {
    const db = initDatabase(':memory:');
    const byDate = Object.fromEntries(
      loadSettings(db).map((s) => [new Date(s.effective_from).toISOString(), s.correction]),
    );
    expect(byDate).toEqual({
      '2025-07-19T05:00:00.000Z': { threshold: 120, step: 10, units_per_step: 8, mode: 'started' },
      '2025-08-20T05:00:00.000Z': { threshold: 120, step: 10, units_per_step: 6, mode: 'started' },
      '2026-08-12T05:00:00.000Z': { threshold: 200, step: 50, units_per_step: 1, mode: 'started' },
    });
  });

  it('makes the 2026-08-12 row drive dosing today (spec §10 vectors)', () => {
    const db = initDatabase(':memory:');
    const active = activeSettings(loadSettings(db), Date.parse('2026-09-14T12:00:00Z'));
    expect(active?.id).toBe(SEED_DOSE_SETTINGS[2]!.id);
    const dose = (bg: number) =>
      estimateDose({ settings: active!, minutes: 12 * 60, carbs: { carbs_g: 0, complete: true }, bg });
    expect(dose(200)).toMatchObject({ ok: true, units: 0 });
    expect(dose(201)).toMatchObject({ ok: true, units: 1 });
    expect(dose(251)).toMatchObject({ ok: true, units: 2 });
  });

  it('does not resurrect a soft-deleted seed row', () => {
    const db = initDatabase(':memory:');
    db.prepare('UPDATE dose_settings SET deleted = 1 WHERE id = ?').run(SEED_DOSE_SETTINGS[0]!.id);
    expect(seedDoseSettings(db)).toBe(0);
    expect(db.prepare('SELECT deleted FROM dose_settings WHERE id = ?').pluck().get(SEED_DOSE_SETTINGS[0]!.id)).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/seed.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/init' imported from …/server/test/seed.test.ts`

- [ ] **Step 3: Implement the seed**

`server/src/seed.ts`:
```ts
import type { DoseSettingsData, DoseWindow, RoundingRule } from '@carbbook/core';
import { type Db, nextServerSeq } from './db';

export const SEED_DEVICE_ID = 'server-seed';

/** Owner's ratio windows (spec §3). Historical versions reuse the same windows. */
export const SEED_WINDOWS: DoseWindow[] = [
  { name: 'Breakfast', start: '05:00', ratio_g_per_unit: 8 },
  { name: 'AM Snack', start: '09:00', ratio_g_per_unit: 10 },
  { name: 'Lunch', start: '11:00', ratio_g_per_unit: 8 },
  { name: 'PM Snack', start: '14:00', ratio_g_per_unit: 10 },
  { name: 'Dinner', start: '16:30', ratio_g_per_unit: 8 },
  { name: 'HS Snack', start: '19:30', ratio_g_per_unit: 12 },
];

const SEED_ROUNDING: RoundingRule = { increment: 1, round_down_below_bg: 130 };

/** Local midnight in America/Chicago (CDT, UTC-5) on each effective date. */
const at = (isoDate: string) => Date.parse(`${isoDate}T00:00:00-05:00`);

/**
 * Oldest first. The 2025 rows come from the owner's sliding-scale file: "BG fix" is stored as
 * units_per_step and "iteration" as step — see the plan notes; only the 2026-08-12 row is active.
 */
export const SEED_DOSE_SETTINGS: DoseSettingsData[] = [
  {
    id: '0198210d-a880-7000-8000-000000000001',
    effective_from: at('2025-07-19'),
    windows: SEED_WINDOWS,
    correction: { threshold: 120, step: 10, units_per_step: 8, mode: 'started' },
    rounding: SEED_ROUNDING,
  },
  {
    id: '0198c5d9-2880-7000-8000-000000000002',
    effective_from: at('2025-08-20'),
    windows: SEED_WINDOWS,
    correction: { threshold: 120, step: 10, units_per_step: 6, mode: 'started' },
    rounding: SEED_ROUNDING,
  },
  {
    id: '019ff457-7480-7000-8000-000000000003',
    effective_from: at('2026-08-12'),
    windows: SEED_WINDOWS,
    correction: { threshold: 200, step: 50, units_per_step: 1, mode: 'started' },
    rounding: SEED_ROUNDING,
  },
];

/** Inserts seed versions whose id is not present yet (a deleted seed row is never resurrected). */
export function seedDoseSettings(db: Db): number {
  const exists = db.prepare('SELECT 1 FROM dose_settings WHERE id = ?');
  const insert = db.prepare(
    `INSERT INTO dose_settings
       (id, effective_from, windows, correction, rounding, updated_at, updated_by, deleted, server_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  );
  return db.transaction(() => {
    let inserted = 0;
    for (const s of SEED_DOSE_SETTINGS) {
      if (exists.get(s.id)) continue;
      insert.run(
        s.id,
        s.effective_from,
        JSON.stringify(s.windows),
        JSON.stringify(s.correction),
        JSON.stringify(s.rounding),
        s.effective_from,
        SEED_DEVICE_ID,
        nextServerSeq(db),
      );
      inserted++;
    }
    return inserted;
  })();
}
```

The ids are UUIDv7-shaped: the first 48 bits are the `effective_from` milliseconds in hex (1752901200000, 1755666000000, 1786510800000).

`server/src/init.ts`:
```ts
import { type Db, migrate, openDb } from './db';
import { seedDoseSettings } from './seed';

/** Open, migrate and seed. Use ':memory:' in tests. */
export function initDatabase(path: string): Db {
  const db = openDb(path);
  migrate(db);
  seedDoseSettings(db);
  return db;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/seed.test.ts`
Expected: `Tests  4 passed (4)`

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/seed.ts server/src/init.ts server/test/seed.test.ts
git commit -m "feat(server): seed dose settings including sliding-scale history"
```

---

### Task 5: App skeleton, error shape and test helpers

**Files:**
- Create: `server/src/errors.ts`, `server/src/context.ts`, `server/src/app.ts`, `server/test/helpers.ts`
- Test: `server/test/health.test.ts`

- [ ] **Step 1: Write the test helpers**

`server/test/helpers.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { type Config, loadConfig } from '../src/config';
import type { AppDeps } from '../src/context';
import type { Db } from '../src/db';
import { initDatabase } from '../src/init';

export const T0 = Date.parse('2026-09-14T17:00:00Z');

export class TestClock {
  constructor(public ms = T0) {}
  now = () => this.ms;
  advance(ms: number) {
    this.ms += ms;
  }
}

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  clock: TestClock;
  config: Config;
}

export async function makeTestApp(
  options: { env?: Record<string, string>; deps?: Partial<AppDeps> } = {},
): Promise<TestApp> {
  const config = loadConfig({ DATABASE_PATH: ':memory:', COOKIE_SECURE: 'false', ...options.env });
  const db = initDatabase(':memory:');
  const clock = new TestClock();
  const app = await buildApp({ db, config, deps: { now: clock.now, ...options.deps } });
  return { app, db, clock, config };
}
```

- [ ] **Step 2: Write the failing test**

`server/test/health.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors';
import { makeTestApp } from './helpers';

describe('app skeleton', () => {
  it('serves /api/health without auth', async () => {
    const { app } = await makeTestApp();
    const response = await app.inject({ url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const { app } = await makeTestApp();
    const response = await app.inject({ url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found', message: 'No route for GET /api/nope' });
  });

  it('maps ApiError, validation errors and unexpected errors to { error, message }', async () => {
    const { app } = await makeTestApp();
    app.get('/test/api-error', async () => {
      throw new ApiError(409, 'conflict', 'Already exists');
    });
    app.post('/test/validated', { schema: { body: { type: 'object', required: ['n'] } } }, async () => ({ ok: true }));
    app.get('/test/boom', async () => {
      throw new Error('secret internals');
    });

    const apiError = await app.inject({ url: '/test/api-error' });
    expect(apiError.statusCode).toBe(409);
    expect(apiError.json()).toEqual({ error: 'conflict', message: 'Already exists' });

    const invalid = await app.inject({ method: 'POST', url: '/test/validated', payload: {} });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe('invalid_request');

    const boom = await app.inject({ url: '/test/boom' });
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({ error: 'internal', message: 'Internal server error' });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/health.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/errors' imported from …/server/test/health.test.ts`

- [ ] **Step 4: Implement errors, context and app**

`server/src/errors.ts`:
```ts
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/** An expected failure with a stable machine-readable code, sent as `{ error, message }`. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ErrorBody {
  error: string;
  message: string;
}

export function errorHandler(error: FastifyError | ApiError, request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof ApiError) {
    void reply.code(error.statusCode).send({ error: error.code, message: error.message } satisfies ErrorBody);
    return;
  }
  if ('validation' in error && error.validation) {
    void reply.code(400).send({ error: 'invalid_request', message: error.message } satisfies ErrorBody);
    return;
  }
  const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
  if (status === 429) {
    void reply.code(429).send({ error: 'rate_limited', message: error.message } satisfies ErrorBody);
    return;
  }
  if (status >= 400 && status < 500) {
    void reply.code(status).send({ error: 'bad_request', message: error.message } satisfies ErrorBody);
    return;
  }
  request.log.error({ err: error }, 'unhandled error');
  void reply.code(500).send({ error: 'internal', message: 'Internal server error' } satisfies ErrorBody);
}
```

`server/src/context.ts`:
```ts
import type { Config } from './config';
import type { Db } from './db';

/** External HTTP services and the clock, injected so tests never touch the network. */
export interface AppDeps {
  now: () => number;
}

export interface AppContext {
  db: Db;
  config: Config;
  deps: AppDeps;
}
```

`server/src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';
import type { AppDeps } from './context';
import type { Db } from './db';
import { errorHandler } from './errors';

export interface BuildAppOptions {
  db: Db;
  config: Config;
  deps?: Partial<AppDeps>;
  logger?: boolean;
}

export function defaultDeps(_config: Config): AppDeps {
  return { now: () => Date.now() };
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: options.config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
  });
  app.setErrorHandler(errorHandler);

  app.get('/api/health', async () => ({ ok: true }));

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0]!;
    return reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${path}` });
  });
  return app;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/health.test.ts`
Expected: `Tests  3 passed (3)`

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/errors.ts server/src/context.ts server/src/app.ts server/test/helpers.ts server/test/health.test.ts
git commit -m "feat(server): Fastify app factory with JSON error shape"
```

---

### Task 6: Password hashing and users

**Files:**
- Create: `server/src/auth/passwords.ts`, `server/src/auth/users.ts`
- Test: `server/test/users.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/users.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/passwords';
import { createUser, findUserByUsername, getUser, UserError } from '../src/auth/users';
import { initDatabase } from '../src/init';

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const stored = await hashPassword('hunter2hunter2');
    expect(stored.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(stored, 'hunter2hunter2')).toBe(true);
    expect(await verifyPassword(stored, 'wrong')).toBe(false);
  });

  it('treats a malformed stored hash as a mismatch', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});

describe('users', () => {
  it('creates and finds users case-insensitively', async () => {
    const db = initDatabase(':memory:');
    const user = await createUser(db, { username: 'Brett', password: 'long enough', role: 'owner' }, 1);
    expect(user).toEqual({ id: 1, username: 'Brett', role: 'owner' });
    expect(findUserByUsername(db, 'brett')?.id).toBe(1);
    expect(getUser(db, 1)).toEqual(user);
  });

  it('rejects duplicates, short passwords, bad usernames and roles', async () => {
    const db = initDatabase(':memory:');
    await createUser(db, { username: 'brett', password: 'long enough', role: 'owner' }, 1);
    await expect(createUser(db, { username: 'BRETT', password: 'long enough', role: 'viewer' }, 1)).rejects.toThrow(UserError);
    await expect(createUser(db, { username: 'kim', password: 'short', role: 'viewer' }, 1)).rejects.toThrow(/at least 8/);
    await expect(createUser(db, { username: 'no spaces', password: 'long enough', role: 'viewer' }, 1)).rejects.toThrow(/Username/);
    await expect(
      createUser(db, { username: 'kim', password: 'long enough', role: 'admin' as 'owner' }, 1),
    ).rejects.toThrow(/Role/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/users.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/auth/passwords' imported from …/server/test/users.test.ts`

- [ ] **Step 3: Implement**

`server/src/auth/passwords.ts`:
```ts
import { hash, verify } from '@node-rs/argon2';

/** argon2id with the library defaults (m=19456 KiB, t=2, p=1). */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}
```

`server/src/auth/users.ts`:
```ts
import type { Db } from '../db';
import { hashPassword } from './passwords';

export type Role = 'owner' | 'viewer';

export interface User {
  id: number;
  username: string;
  role: Role;
}

export interface StoredUser extends User {
  password_hash: string;
}

export class UserError extends Error {}

const USERNAME_RE = /^[A-Za-z0-9_.-]{2,32}$/;
export const MIN_PASSWORD_LENGTH = 8;

export async function createUser(
  db: Db,
  input: { username: string; password: string; role: Role },
  now: number,
): Promise<User> {
  if (!USERNAME_RE.test(input.username)) {
    throw new UserError('Username must be 2-32 characters: letters, digits, "_", "." or "-"');
  }
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new UserError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (input.role !== 'owner' && input.role !== 'viewer') {
    throw new UserError('Role must be "owner" or "viewer"');
  }
  if (findUserByUsername(db, input.username)) {
    throw new UserError(`User "${input.username}" already exists`);
  }
  const passwordHash = await hashPassword(input.password);
  const result = db
    .prepare('INSERT INTO user (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(input.username, passwordHash, input.role, now);
  return { id: Number(result.lastInsertRowid), username: input.username, role: input.role };
}

export function findUserByUsername(db: Db, username: string): StoredUser | undefined {
  return db
    .prepare('SELECT id, username, role, password_hash FROM user WHERE username = ?')
    .get(username) as StoredUser | undefined;
}

export function getUser(db: Db, id: number): User | undefined {
  return db.prepare('SELECT id, username, role FROM user WHERE id = ?').get(id) as User | undefined;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/users.test.ts`
Expected: `Tests  4 passed (4)`

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/auth/passwords.ts server/src/auth/users.ts server/test/users.test.ts
git commit -m "feat(server): argon2id password hashing and user store"
```

---

### Task 7: `carbbook user add` CLI

**Files:**
- Create: `server/src/cli.ts`
- Test: `server/test/cli.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/cli.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { findUserByUsername } from '../src/auth/users';
import { runCli, type CliIo } from '../src/cli';
import { initDatabase } from '../src/init';

function io(overrides: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliIo = {
    env: {},
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    readPassword: async () => 'typed password',
    db: initDatabase(':memory:'),
    now: () => 1,
    ...overrides,
  };
  return { io: value, out, err };
}

describe('carbbook user add', () => {
  it('creates an owner with the prompted password', async () => {
    const t = io();
    expect(await runCli(['user', 'add', 'brett', '--role', 'owner'], t.io)).toBe(0);
    expect(t.out).toEqual(['Created owner "brett" (id 1)']);
    expect(findUserByUsername(t.io.db!, 'brett')?.role).toBe('owner');
  });

  it('defaults to viewer and prefers CARBBOOK_PASSWORD', async () => {
    let prompted = false;
    const t = io({
      env: { CARBBOOK_PASSWORD: 'from env var' },
      readPassword: async () => {
        prompted = true;
        return 'x';
      },
    });
    expect(await runCli(['user', 'add', 'kim'], t.io)).toBe(0);
    expect(prompted).toBe(false);
    expect(findUserByUsername(t.io.db!, 'kim')?.role).toBe('viewer');
  });

  it('reports validation errors with exit code 1 and usage with exit code 2', async () => {
    const t = io({ readPassword: async () => 'short' });
    expect(await runCli(['user', 'add', 'kim'], t.io)).toBe(1);
    expect(t.err[0]).toMatch(/at least 8/);
    expect(await runCli(['bogus'], t.io)).toBe(2);
    expect(t.err[1]).toMatch(/Usage/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/cli.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/cli' imported from …/server/test/cli.test.ts`

- [ ] **Step 3: Implement**

`server/src/cli.ts`:
```ts
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { createUser, type Role, UserError } from './auth/users';
import { type Env, loadConfig } from './config';
import type { Db } from './db';
import { initDatabase } from './init';

export interface CliIo {
  env: Env;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  readPassword: () => Promise<string>;
  /** Tests pass an in-memory database; otherwise DATABASE_PATH is opened. */
  db?: Db;
  now?: () => number;
}

const USAGE = `Usage:
  carbbook user add <username> [--role owner|viewer]   (password from CARBBOOK_PASSWORD or prompt)`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [group, command, ...rest] = argv;
  if (group === 'user' && command === 'add') {
    const username = rest[0];
    if (!username || username.startsWith('--')) {
      io.stderr(USAGE);
      return 2;
    }
    const role = (flag(rest, '--role') ?? 'viewer') as Role;
    const password = io.env.CARBBOOK_PASSWORD ?? (await io.readPassword());
    const db = io.db ?? initDatabase(loadConfig(io.env).databasePath);
    try {
      const user = await createUser(db, { username, password, role }, (io.now ?? Date.now)());
      io.stdout(`Created ${user.role} "${user.username}" (id ${user.id})`);
      return 0;
    } catch (error) {
      if (error instanceof UserError) {
        io.stderr(error.message);
        return 1;
      }
      throw error;
    } finally {
      if (!io.db) db.close();
    }
  }
  io.stderr(USAGE);
  return 2;
}

async function promptPassword(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question('Password: ');
  } finally {
    rl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    readPassword: promptPassword,
  }).then((code) => process.exit(code));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/cli.test.ts`
Expected: `Tests  3 passed (3)`

- [ ] **Step 5: Run the real CLI against a file database**

Run:
```bash
cd ~/Projects/CarbBook/server && T=$(mktemp -d) && DATABASE_PATH=$T/c.db CARBBOOK_PASSWORD='smoke password' pnpm -s carbbook user add brett --role owner
```
Expected: `Created owner "brett" (id 1)`

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/cli.ts server/test/cli.test.ts
git commit -m "feat(server): carbbook user add CLI"
```

---

### Task 8: Session store

**Files:**
- Create: `server/src/auth/sessions.ts`
- Test: `server/test/sessions.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/sessions.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  createSession,
  listBearerTokens,
  resolveSession,
  revokeSession,
  SESSION_SLIDE_INTERVAL_MS,
  SESSION_TTL_MS,
  sessionIdForToken,
} from '../src/auth/sessions';
import { createUser } from '../src/auth/users';
import { initDatabase } from '../src/init';

async function setup() {
  const db = initDatabase(':memory:');
  const user = await createUser(db, { username: 'brett', password: 'long enough', role: 'owner' }, 0);
  return { db, user };
}

describe('sessions', () => {
  it('stores only the sha256 of the token', async () => {
    const { db, user } = await setup();
    const { token, id } = createSession(db, { userId: user.id, kind: 'cookie', label: 'web' }, 1000);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(id).toBe(sessionIdForToken(token));
    expect(db.prepare('SELECT count(*) FROM auth_session WHERE id = ?').pluck().get(token)).toBe(0);
  });

  it('resolves cookie sessions, slides expiry hourly and expires after 30 idle days', async () => {
    const { db, user } = await setup();
    const { token } = createSession(db, { userId: user.id, kind: 'cookie', label: 'web' }, 0);

    expect(resolveSession(db, token, 10)).toMatchObject({ user: { username: 'brett', role: 'owner' }, renewed: false });
    const slid = resolveSession(db, token, SESSION_SLIDE_INTERVAL_MS);
    expect(slid).toMatchObject({ renewed: true, session: { expires_at: SESSION_SLIDE_INTERVAL_MS + SESSION_TTL_MS } });

    expect(resolveSession(db, token, SESSION_SLIDE_INTERVAL_MS + SESSION_TTL_MS)).toBeNull();
    expect(db.prepare('SELECT count(*) FROM auth_session').pluck().get()).toBe(0);
  });

  it('never expires bearer tokens', async () => {
    const { db, user } = await setup();
    const { token } = createSession(db, { userId: user.id, kind: 'bearer', label: 'iPhone' }, 0);
    expect(resolveSession(db, token, 5 * SESSION_TTL_MS)).toMatchObject({ session: { kind: 'bearer', expires_at: null } });
  });

  it('rejects unknown tokens', async () => {
    const { db } = await setup();
    expect(resolveSession(db, 'nope', 0)).toBeNull();
  });

  it('lists bearer tokens and revokes only the owner’s sessions', async () => {
    const { db, user } = await setup();
    const other = await createUser(db, { username: 'kim', password: 'long enough', role: 'viewer' }, 0);
    const phone = createSession(db, { userId: user.id, kind: 'bearer', label: 'iPhone' }, 5);
    createSession(db, { userId: user.id, kind: 'cookie', label: 'web' }, 6);

    expect(listBearerTokens(db, user.id)).toEqual([{ id: phone.id, label: 'iPhone', created_at: 5, last_used_at: 5 }]);
    expect(revokeSession(db, phone.id, other.id)).toBe(false);
    expect(revokeSession(db, phone.id, user.id)).toBe(true);
    expect(resolveSession(db, phone.token, 7)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/sessions.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/auth/sessions' imported from …/server/test/sessions.test.ts`

- [ ] **Step 3: Implement**

`server/src/auth/sessions.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db';
import type { User } from './users';

export type SessionKind = 'cookie' | 'bearer';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding expiry is refreshed at most once per hour to avoid a write on every request. */
export const SESSION_SLIDE_INTERVAL_MS = 60 * 60 * 1000;

export interface SessionRow {
  id: string;
  user_id: number;
  kind: SessionKind;
  label: string | null;
  created_at: number;
  last_used_at: number;
  expires_at: number | null;
}

export interface ResolvedSession {
  session: SessionRow;
  user: User;
  /** True when the expiry was pushed forward; cookie sessions should re-send the cookie. */
  renewed: boolean;
}

export function sessionIdForToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(
  db: Db,
  input: { userId: number; kind: SessionKind; label: string | null },
  now: number,
): { token: string; id: string } {
  const token = randomBytes(32).toString('base64url');
  const id = sessionIdForToken(token);
  const expiresAt = input.kind === 'cookie' ? now + SESSION_TTL_MS : null;
  db.prepare(
    'INSERT INTO auth_session (id, user_id, kind, label, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, input.userId, input.kind, input.label, now, now, expiresAt);
  return { token, id };
}

export function resolveSession(db: Db, token: string, now: number): ResolvedSession | null {
  const row = db
    .prepare(
      `SELECT s.id, s.user_id, s.kind, s.label, s.created_at, s.last_used_at, s.expires_at,
              u.username, u.role
         FROM auth_session s JOIN user u ON u.id = s.user_id
        WHERE s.id = ?`,
    )
    .get(sessionIdForToken(token)) as (SessionRow & { username: string; role: User['role'] }) | undefined;
  if (!row) return null;
  if (row.expires_at !== null && row.expires_at <= now) {
    db.prepare('DELETE FROM auth_session WHERE id = ?').run(row.id);
    return null;
  }
  const { username, role, ...session } = row;
  let renewed = false;
  if (now - session.last_used_at >= SESSION_SLIDE_INTERVAL_MS) {
    session.last_used_at = now;
    session.expires_at = session.kind === 'cookie' ? now + SESSION_TTL_MS : null;
    db.prepare('UPDATE auth_session SET last_used_at = ?, expires_at = ? WHERE id = ?').run(
      session.last_used_at,
      session.expires_at,
      session.id,
    );
    renewed = true;
  }
  return { session, user: { id: session.user_id, username, role }, renewed };
}

export function revokeSession(db: Db, id: string, userId: number): boolean {
  return db.prepare('DELETE FROM auth_session WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

export function listBearerTokens(db: Db, userId: number): Omit<SessionRow, 'user_id' | 'kind' | 'expires_at'>[] {
  return db
    .prepare(
      `SELECT id, label, created_at, last_used_at FROM auth_session
        WHERE user_id = ? AND kind = 'bearer' ORDER BY created_at DESC`,
    )
    .all(userId) as Omit<SessionRow, 'user_id' | 'kind' | 'expires_at'>[];
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/sessions.test.ts`
Expected: `Tests  5 passed (5)`

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/auth/sessions.ts server/test/sessions.test.ts
git commit -m "feat(server): hashed session tokens with sliding expiry"
```

---

### Task 9: Login, authentication hook, `/api/auth/me` and logout

**Files:**
- Create: `server/src/auth/plugin.ts`, `server/src/routes/auth.ts`
- Modify: `server/src/app.ts` (full replacement), `server/test/helpers.ts` (full replacement)
- Test: `server/test/auth-login.test.ts`

- [ ] **Step 1: Extend the test helpers**

Replace `server/test/helpers.ts` with:
```ts
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { createUser, type Role, type User } from '../src/auth/users';
import { type Config, loadConfig } from '../src/config';
import type { AppDeps } from '../src/context';
import type { Db } from '../src/db';
import { initDatabase } from '../src/init';

export const TEST_PASSWORD = 'correct horse battery';
export const T0 = Date.parse('2026-09-14T17:00:00Z');

export class TestClock {
  constructor(public ms = T0) {}
  now = () => this.ms;
  advance(ms: number) {
    this.ms += ms;
  }
}

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  clock: TestClock;
  config: Config;
}

export async function makeTestApp(
  options: { env?: Record<string, string>; deps?: Partial<AppDeps> } = {},
): Promise<TestApp> {
  const config = loadConfig({ DATABASE_PATH: ':memory:', COOKIE_SECURE: 'false', ...options.env });
  const db = initDatabase(':memory:');
  const clock = new TestClock();
  const app = await buildApp({ db, config, deps: { now: clock.now, ...options.deps } });
  return { app, db, clock, config };
}

export function addUser(db: Db, username: string, role: Role, password = TEST_PASSWORD): Promise<User> {
  return createUser(db, { username, password, role }, T0);
}

/** Logs in as a web client and returns the Cookie header value to send on later requests. */
export async function loginCookie(app: FastifyInstance, username: string, password = TEST_PASSWORD): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  if (response.statusCode !== 200) throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  const cookie = response.cookies.find((c) => c.name === 'carbbook_session');
  if (!cookie) throw new Error('no session cookie');
  return `carbbook_session=${cookie.value}`;
}

/** Logs in as the iOS client and returns an Authorization header value. */
export async function loginBearer(app: FastifyInstance, username: string, password = TEST_PASSWORD): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password, client: 'ios', device_name: 'Test iPhone' },
  });
  if (response.statusCode !== 200) throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  return `Bearer ${response.json().token}`;
}
```

- [ ] **Step 2: Write the failing test**

`server/test/auth-login.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { SESSION_SLIDE_INTERVAL_MS, SESSION_TTL_MS } from '../src/auth/sessions';
import { addUser, loginBearer, loginCookie, makeTestApp, TEST_PASSWORD } from './helpers';

describe('POST /api/auth/login', () => {
  it('sets an httpOnly SameSite=Lax 30-day cookie for web clients', async () => {
    const { app, db } = await makeTestApp({ env: { COOKIE_SECURE: 'true' } });
    await addUser(db, 'brett', 'owner');
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'brett', password: TEST_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: { id: 1, username: 'brett', role: 'owner' } });
    const cookie = response.cookies.find((c) => c.name === 'carbbook_session')!;
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL_MS / 1000 });
  });

  it('issues a bearer token for iOS clients', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const authorization = await loginBearer(app, 'brett');
    const me = await app.inject({ url: '/api/auth/me', headers: { authorization } });
    expect(me.json()).toEqual({ user: { id: 1, username: 'brett', role: 'owner' } });
  });

  it('rejects wrong passwords and unknown users identically', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    for (const payload of [
      { username: 'brett', password: 'wrong password' },
      { username: 'ghost', password: 'wrong password' },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'invalid_credentials', message: 'Wrong username or password' });
    }
  });

  it('validates the body', async () => {
    const { app } = await makeTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'x' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');
  });
});

describe('authenticated requests', () => {
  it('returns JSON 401 without credentials', async () => {
    const { app } = await makeTestApp();
    const response = await app.inject({ url: '/api/auth/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized', message: 'Sign in required' });
  });

  it('slides cookie expiry after an hour and expires after 30 idle days', async () => {
    const { app, db, clock } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const cookie = await loginCookie(app, 'brett');

    clock.advance(SESSION_SLIDE_INTERVAL_MS);
    const renewed = await app.inject({ url: '/api/auth/me', headers: { cookie } });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.cookies.some((c) => c.name === 'carbbook_session')).toBe(true);

    clock.advance(SESSION_TTL_MS - 1);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);

    clock.advance(SESSION_TTL_MS);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('logout revokes the session', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const cookie = await loginCookie(app, 'brett');
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/auth-login.test.ts`
Expected: FAIL — 7 failed; e.g. `Error: login failed: 404 {"error":"not_found","message":"No route for POST /api/auth/login"}` and `expected 404 to be 401`.

- [ ] **Step 4: Implement the auth hook**

`server/src/auth/plugin.ts`:
```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { ApiError } from '../errors';
import { resolveSession, SESSION_TTL_MS, type SessionKind } from './sessions';
import type { User } from './users';

export const SESSION_COOKIE = 'carbbook_session';

export interface AuthContext {
  user: User;
  sessionId: string;
  kind: SessionKind;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export function sessionCookieOptions(ctx: AppContext) {
  return {
    path: '/',
    httpOnly: true,
    secure: ctx.config.cookieSecure,
    sameSite: 'lax' as const,
    maxAge: SESSION_TTL_MS / 1000,
  };
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1]! : null;
}

/** onRequest hook: accepts `Authorization: Bearer <token>` (iOS) or the session cookie (web). */
export function makeAuthenticate(ctx: AppContext) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const bearer = bearerToken(request);
    const token = bearer ?? request.cookies[SESSION_COOKIE] ?? null;
    if (!token) throw new ApiError(401, 'unauthorized', 'Sign in required');
    const resolved = resolveSession(ctx.db, token, ctx.deps.now());
    if (!resolved) throw new ApiError(401, 'unauthorized', 'Session expired or revoked');
    request.auth = { user: resolved.user, sessionId: resolved.session.id, kind: resolved.session.kind };
    if (resolved.renewed && bearer === null && resolved.session.kind === 'cookie') {
      reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(ctx));
    }
  };
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new ApiError(401, 'unauthorized', 'Sign in required');
  return request.auth;
}
```

- [ ] **Step 5: Implement the routes**

`server/src/routes/auth.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { requireAuth, SESSION_COOKIE, sessionCookieOptions } from '../auth/plugin';
import { hashPassword, verifyPassword } from '../auth/passwords';
import { createSession, revokeSession } from '../auth/sessions';
import { findUserByUsername } from '../auth/users';
import type { AppContext } from '../context';
import { ApiError } from '../errors';

interface LoginBody {
  username: string;
  password: string;
  client?: 'web' | 'ios';
  device_name?: string;
}

let dummyHash: Promise<string> | null = null;
/** Verifying against a throwaway hash keeps unknown-user logins as slow as wrong-password logins. */
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('carbbook-timing-equalizer');
  return dummyHash;
}

export async function loginRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post<{ Body: LoginBody }>(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          additionalProperties: false,
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 64 },
            password: { type: 'string', minLength: 1, maxLength: 256 },
            client: { type: 'string', enum: ['web', 'ios'] },
            device_name: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      const { username, password, client = 'web', device_name } = request.body;
      const user = findUserByUsername(ctx.db, username);
      const ok = user
        ? await verifyPassword(user.password_hash, password)
        : (await verifyPassword(await getDummyHash(), password), false);
      if (!user || !ok) throw new ApiError(401, 'invalid_credentials', 'Wrong username or password');

      const publicUser = { id: user.id, username: user.username, role: user.role };
      const now = ctx.deps.now();
      if (client === 'ios') {
        const { token, id } = createSession(ctx.db, { userId: user.id, kind: 'bearer', label: device_name ?? 'iOS' }, now);
        return { user: publicUser, token, token_id: id };
      }
      const { token } = createSession(ctx.db, { userId: user.id, kind: 'cookie', label: device_name ?? 'web' }, now);
      reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(ctx));
      return { user: publicUser };
    },
  );
}

/** Registered inside the authenticated scope. */
export async function sessionRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/auth/me', async (request) => ({ user: requireAuth(request).user }));

  app.post('/api/auth/logout', async (request, reply) => {
    const auth = requireAuth(request);
    revokeSession(ctx.db, auth.sessionId, auth.user.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
```

- [ ] **Step 6: Wire into the app**

Replace `server/src/app.ts` with:
```ts
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeAuthenticate } from './auth/plugin';
import type { Config } from './config';
import type { AppContext, AppDeps } from './context';
import type { Db } from './db';
import { errorHandler } from './errors';
import { loginRoutes, sessionRoutes } from './routes/auth';

export interface BuildAppOptions {
  db: Db;
  config: Config;
  deps?: Partial<AppDeps>;
  logger?: boolean;
}

export function defaultDeps(_config: Config): AppDeps {
  return { now: () => Date.now() };
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const ctx: AppContext = {
    db: options.db,
    config: options.config,
    deps: { ...defaultDeps(options.config), ...options.deps },
  };
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: options.config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
  });
  app.setErrorHandler(errorHandler);
  app.decorateRequest('auth', null);
  await app.register(cookie);

  app.get('/api/health', async () => ({ ok: true }));
  await app.register(loginRoutes, ctx);

  await app.register(async (api) => {
    api.addHook('onRequest', makeAuthenticate(ctx));
    await api.register(sessionRoutes, ctx);
  });

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0]!;
    return reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${path}` });
  });
  return app;
}
```

- [ ] **Step 7: Run the auth and skeleton tests**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/auth-login.test.ts test/health.test.ts`
Expected: `Test Files  2 passed (2)` and `Tests  10 passed (10)`

- [ ] **Step 8: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/auth/plugin.ts server/src/routes/auth.ts server/src/app.ts server/test/helpers.ts server/test/auth-login.test.ts
git commit -m "feat(server): login with session cookie or bearer token"
```

---

### Task 10: Login rate limit (5 per 15 minutes per IP + username)

**Files:**
- Modify: `server/src/routes/auth.ts` (replace `loginRoutes`, add a constant), `server/src/app.ts` (register the plugin)
- Test: `server/test/auth-rate-limit.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/auth-rate-limit.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { addUser, makeTestApp } from './helpers';

describe('login rate limit', () => {
  it('allows 5 attempts per IP + username (case-insensitive) per 15 minutes', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const attempt = (username: string) =>
      app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'wrong password' } });
    for (let i = 0; i < 5; i++) expect((await attempt('brett')).statusCode).toBe(401);
    const blocked = await attempt('Brett');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('rate_limited');
    expect((await attempt('kim')).statusCode).toBe(401);
  });

  it('keys on the client IP', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const attempt = (remoteAddress: string) =>
      app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress, payload: { username: 'brett', password: 'wrong password' } });
    for (let i = 0; i < 5; i++) await attempt('10.0.0.1');
    expect((await attempt('10.0.0.1')).statusCode).toBe(429);
    expect((await attempt('10.0.0.2')).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/auth-rate-limit.test.ts`
Expected: FAIL — `AssertionError: expected 401 to be 429` (twice).

- [ ] **Step 3: Register @fastify/rate-limit**

In `server/src/app.ts`, add the import after the cookie import:
```ts
import rateLimit from '@fastify/rate-limit';
```
and register it right after `await app.register(cookie);`:
```ts
  await app.register(rateLimit, { global: false });
```

- [ ] **Step 4: Add the per-route limit**

In `server/src/routes/auth.ts`, add after the imports:
```ts
export const LOGIN_RATE_LIMIT = { max: 5, timeWindow: '15 minutes' } as const;
```
and replace the whole `loginRoutes` function with:
```ts
export async function loginRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post<{ Body: LoginBody }>(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          additionalProperties: false,
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 64 },
            password: { type: 'string', minLength: 1, maxLength: 256 },
            client: { type: 'string', enum: ['web', 'ios'] },
            device_name: { type: 'string', maxLength: 64 },
          },
        },
      },
      config: {
        rateLimit: {
          ...LOGIN_RATE_LIMIT,
          // preHandler runs after body parsing, so the key can include the username.
          hook: 'preHandler',
          keyGenerator: (request) => {
            const body = request.body as Partial<LoginBody> | undefined;
            return `${request.ip}|${String(body?.username ?? '').toLowerCase()}`;
          },
          errorResponseBuilder: (_request, context) => ({
            statusCode: 429,
            error: 'rate_limited',
            message: `Too many login attempts, retry in ${context.after}`,
          }),
        },
      },
    },
    async (request, reply) => {
      const { username, password, client = 'web', device_name } = request.body;
      const user = findUserByUsername(ctx.db, username);
      const ok = user
        ? await verifyPassword(user.password_hash, password)
        : (await verifyPassword(await getDummyHash(), password), false);
      if (!user || !ok) throw new ApiError(401, 'invalid_credentials', 'Wrong username or password');

      const publicUser = { id: user.id, username: user.username, role: user.role };
      const now = ctx.deps.now();
      if (client === 'ios') {
        const { token, id } = createSession(ctx.db, { userId: user.id, kind: 'bearer', label: device_name ?? 'iOS' }, now);
        return { user: publicUser, token, token_id: id };
      }
      const { token } = createSession(ctx.db, { userId: user.id, kind: 'cookie', label: device_name ?? 'web' }, now);
      reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(ctx));
      return { user: publicUser };
    },
  );
}
```

- [ ] **Step 5: Run the auth tests**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/auth-rate-limit.test.ts test/auth-login.test.ts`
Expected: `Test Files  2 passed (2)` and `Tests  9 passed (9)`

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/routes/auth.ts server/src/app.ts server/test/auth-rate-limit.test.ts
git commit -m "feat(server): rate limit login attempts per IP and username"
```

---

### Task 11: Bearer token list and revoke

**Files:**
- Modify: `server/src/routes/auth.ts` (import + `sessionRoutes`)
- Test: `server/test/auth-tokens.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/auth-tokens.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { addUser, loginBearer, loginCookie, makeTestApp } from './helpers';

describe('bearer token management', () => {
  it('lists and revokes bearer tokens', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const phone = await loginBearer(app, 'brett');
    const cookie = await loginCookie(app, 'brett');

    const list = await app.inject({ url: '/api/auth/tokens', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const tokens = list.json().tokens as { id: string; label: string }[];
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.label).toBe('Test iPhone');

    const revoke = await app.inject({ method: 'DELETE', url: `/api/auth/tokens/${tokens[0]!.id}`, headers: { cookie } });
    expect(revoke.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/auth/me', headers: { authorization: phone } })).statusCode).toBe(401);
    const again = await app.inject({ method: 'DELETE', url: `/api/auth/tokens/${tokens[0]!.id}`, headers: { cookie } });
    expect(again.statusCode).toBe(404);
  });

  it("cannot revoke another user's token", async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    await addUser(db, 'kim', 'viewer');
    const phone = await loginBearer(app, 'brett');
    const brettCookie = await loginCookie(app, 'brett');
    const kimCookie = await loginCookie(app, 'kim');
    const [token] = (await app.inject({ url: '/api/auth/tokens', headers: { cookie: brettCookie } })).json().tokens;
    const response = await app.inject({ method: 'DELETE', url: `/api/auth/tokens/${token.id}`, headers: { cookie: kimCookie } });
    expect(response.statusCode).toBe(404);
    expect((await app.inject({ url: '/api/auth/me', headers: { authorization: phone } })).statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/auth-tokens.test.ts`
Expected: FAIL — `AssertionError: expected 404 to be 200` (first test) and `TypeError: … is not iterable` / `Cannot read properties of undefined` (second test, `tokens` is undefined).

- [ ] **Step 3: Implement**

In `server/src/routes/auth.ts` change the sessions import to:
```ts
import { createSession, listBearerTokens, revokeSession } from '../auth/sessions';
```
and replace the whole `sessionRoutes` function with:
```ts
/** Registered inside the authenticated scope. */
export async function sessionRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/auth/me', async (request) => ({ user: requireAuth(request).user }));

  app.post('/api/auth/logout', async (request, reply) => {
    const auth = requireAuth(request);
    revokeSession(ctx.db, auth.sessionId, auth.user.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/tokens', async (request) => {
    const auth = requireAuth(request);
    return { tokens: listBearerTokens(ctx.db, auth.user.id) };
  });

  app.delete<{ Params: { id: string } }>('/api/auth/tokens/:id', async (request) => {
    const auth = requireAuth(request);
    if (!revokeSession(ctx.db, request.params.id, auth.user.id)) {
      throw new ApiError(404, 'not_found', 'No such token');
    }
    return { ok: true };
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/auth-tokens.test.ts`
Expected: `Tests  2 passed (2)`

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/routes/auth.ts server/test/auth-tokens.test.ts
git commit -m "feat(server): list and revoke iOS bearer tokens"
```

---

### Task 12: dexcom-api client

**Files:**
- Create: `server/src/bg/client.ts`
- Test: `server/test/bg-client.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/bg-client.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { BgUnavailableError, createDexcomApiClient } from '../src/bg/client';

const READ_AT_S = 1789405200;

/** Shape of dexcom-api GET /glucose?history=0 (~/HomelabServer/dexcom-api/app.py `_render`). */
const DEXCOM_OK = {
  ok: true,
  error: null,
  value: 142,
  display: '142',
  unit: 'mg/dL',
  mgdl: 142,
  mmol: 7.9,
  arrow: '→',
  trend: 4,
  trend_direction: 'Flat',
  trend_description: 'steady',
  delta: -3,
  delta_display: '-3',
  timestamp: '2026-09-14T11:55:00-05:00',
  epoch: READ_AT_S,
  minutes_ago: 5,
  stale: false,
};

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('createDexcomApiClient', () => {
  it('requests /glucose?history=0 with the bearer token and maps the payload', async () => {
    const { fetch, calls } = stubFetch(() => Response.json(DEXCOM_OK));
    const client = createDexcomApiClient({ baseUrl: 'http://dexcom-api:8000', token: 'tok', timeoutMs: 5000, fetch });
    expect(await client.latest()).toEqual({ mgdl: 142, trend: 'Flat', arrow: '→', delta_mgdl: -3, read_at: READ_AT_S * 1000 });
    expect(calls[0]!.url).toBe('http://dexcom-api:8000/glucose?history=0');
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer tok');
  });

  it('drops delta when dexcom-api is configured for mmol', async () => {
    const { fetch } = stubFetch(() => Response.json({ ...DEXCOM_OK, unit: 'mmol/L', delta: -0.2 }));
    const client = createDexcomApiClient({ baseUrl: 'http://x', token: null, timeoutMs: 5000, fetch });
    expect((await client.latest()).delta_mgdl).toBeNull();
  });

  it('maps network errors, HTTP errors and ok:false to BgUnavailableError', async () => {
    const cases: (() => Response)[] = [
      () => {
        throw new TypeError('fetch failed');
      },
      () => new Response('nope', { status: 401 }),
      () => Response.json({ ok: false, error: 'no readings in the last 3 hours' }),
    ];
    for (const handler of cases) {
      const { fetch } = stubFetch(handler);
      const client = createDexcomApiClient({ baseUrl: 'http://x', token: null, timeoutMs: 5000, fetch });
      await expect(client.latest()).rejects.toBeInstanceOf(BgUnavailableError);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/bg-client.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/bg/client' imported from …/server/test/bg-client.test.ts`

- [ ] **Step 3: Implement**

`server/src/bg/client.ts`:
```ts
export interface BgReading {
  mgdl: number;
  /** pydexcom trend_direction, e.g. "Flat", "FortyFiveUp". */
  trend: string | null;
  arrow: string | null;
  delta_mgdl: number | null;
  /** Sensor reading time, ms since epoch. */
  read_at: number;
}

export interface BgClient {
  /** Resolves with the latest cached reading or rejects with BgUnavailableError. */
  latest(): Promise<BgReading>;
}

export class BgUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BgUnavailableError';
  }
}

export interface DexcomApiClientOptions {
  baseUrl: string;
  token: string | null;
  timeoutMs: number;
  fetch: typeof globalThis.fetch;
}

/** Subset of dexcom-api `GET /glucose?history=0` (~/HomelabServer/dexcom-api/app.py `_render`). */
interface DexcomApiPayload {
  ok: boolean;
  error?: string | null;
  mgdl?: number;
  unit?: string;
  delta?: number | null;
  arrow?: string;
  trend_direction?: string;
  epoch?: number;
}

export function createDexcomApiClient(options: DexcomApiClientOptions): BgClient {
  return {
    async latest() {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      let response: Response;
      try {
        response = await options.fetch(`${options.baseUrl}/glucose?history=0`, {
          headers,
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error) {
        throw new BgUnavailableError(`dexcom-api unreachable: ${(error as Error).message}`);
      }
      if (!response.ok) throw new BgUnavailableError(`dexcom-api responded ${response.status}`);
      const body = (await response.json()) as DexcomApiPayload;
      if (!body.ok || typeof body.mgdl !== 'number' || typeof body.epoch !== 'number') {
        throw new BgUnavailableError(body.error ?? 'dexcom-api has no current reading');
      }
      return {
        mgdl: body.mgdl,
        trend: body.trend_direction ?? null,
        arrow: body.arrow ?? null,
        delta_mgdl: body.unit === 'mg/dL' && typeof body.delta === 'number' ? body.delta : null,
        read_at: body.epoch * 1000,
      };
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/bg-client.test.ts`
Expected: `Tests  3 passed (3)`

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/bg/client.ts server/test/bg-client.test.ts
git commit -m "feat(server): dexcom-api client"
```

---

### Task 13: `GET /api/bg`

**Files:**
- Create: `server/src/routes/bg.ts`
- Modify: `server/src/context.ts` (full replacement), `server/src/app.ts` (full replacement), `server/test/helpers.ts` (two edits)
- Test: `server/test/bg-route.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/bg-route.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { BgUnavailableError, type BgClient } from '../src/bg/client';
import { addUser, loginCookie, makeTestApp, T0 } from './helpers';

describe('GET /api/bg', () => {
  it('returns the reading with age and freshness', async () => {
    const bg: BgClient = {
      latest: async () => ({ mgdl: 263, trend: 'FortyFiveUp', arrow: '↗', delta_mgdl: 6, read_at: T0 - 16 * 60_000 }),
    };
    const { app, db } = await makeTestApp({ deps: { bg } });
    await addUser(db, 'kim', 'viewer');
    const cookie = await loginCookie(app, 'kim');
    const response = await app.inject({ url: '/api/bg', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      mgdl: 263,
      trend: 'FortyFiveUp',
      arrow: '↗',
      delta_mgdl: 6,
      read_at: T0 - 16 * 60_000,
      age_ms: 16 * 60_000,
      fresh: false,
    });
  });

  it('marks a 15-minute-old reading as fresh', async () => {
    const bg: BgClient = { latest: async () => ({ mgdl: 120, trend: null, arrow: null, delta_mgdl: null, read_at: T0 - 15 * 60_000 }) };
    const { app, db } = await makeTestApp({ deps: { bg } });
    await addUser(db, 'kim', 'viewer');
    const cookie = await loginCookie(app, 'kim');
    expect((await app.inject({ url: '/api/bg', headers: { cookie } })).json().fresh).toBe(true);
  });

  it('returns 503 bg_unavailable when dexcom-api fails', async () => {
    const bg: BgClient = { latest: () => Promise.reject(new BgUnavailableError('dexcom-api responded 500')) };
    const { app, db } = await makeTestApp({ deps: { bg } });
    await addUser(db, 'kim', 'viewer');
    const cookie = await loginCookie(app, 'kim');
    const response = await app.inject({ url: '/api/bg', headers: { cookie } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'bg_unavailable', message: 'dexcom-api responded 500' });
  });

  it('requires auth', async () => {
    const { app } = await makeTestApp();
    expect((await app.inject({ url: '/api/bg' })).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/bg-route.test.ts`
Expected: FAIL — the route does not exist yet (Vitest does not typecheck, so the extra `deps.bg` is ignored): `expected 404 to be 200`, `expected 404 to be 503`, `expected 404 to be 401`.

- [ ] **Step 3: Implement the route**

`server/src/routes/bg.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { BgUnavailableError } from '../bg/client';
import type { AppContext } from '../context';
import { ApiError } from '../errors';

/** Clients prefill BG only when the reading is at most this old (spec §4.4). */
export const BG_FRESH_MS = 15 * 60 * 1000;

export async function bgRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/bg', async () => {
    try {
      const reading = await ctx.deps.bg.latest();
      const ageMs = Math.max(0, ctx.deps.now() - reading.read_at);
      return { ...reading, age_ms: ageMs, fresh: ageMs <= BG_FRESH_MS };
    } catch (error) {
      if (error instanceof BgUnavailableError) throw new ApiError(503, 'bg_unavailable', error.message);
      throw error;
    }
  });
}
```

- [ ] **Step 4: Add the BG client to deps**

Replace `server/src/context.ts` with:
```ts
import type { BgClient } from './bg/client';
import type { Config } from './config';
import type { Db } from './db';

/** External HTTP services and the clock, injected so tests never touch the network. */
export interface AppDeps {
  now: () => number;
  bg: BgClient;
}

export interface AppContext {
  db: Db;
  config: Config;
  deps: AppDeps;
}
```

Replace `server/src/app.ts` with:
```ts
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeAuthenticate } from './auth/plugin';
import { createDexcomApiClient } from './bg/client';
import type { Config } from './config';
import type { AppContext, AppDeps } from './context';
import type { Db } from './db';
import { errorHandler } from './errors';
import { loginRoutes, sessionRoutes } from './routes/auth';
import { bgRoutes } from './routes/bg';

export interface BuildAppOptions {
  db: Db;
  config: Config;
  deps?: Partial<AppDeps>;
  logger?: boolean;
}

export function defaultDeps(config: Config): AppDeps {
  return {
    now: () => Date.now(),
    bg: createDexcomApiClient({
      baseUrl: config.dexcomApiUrl,
      token: config.dexcomApiToken,
      timeoutMs: config.httpTimeoutMs,
      fetch: globalThis.fetch,
    }),
  };
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const ctx: AppContext = {
    db: options.db,
    config: options.config,
    deps: { ...defaultDeps(options.config), ...options.deps },
  };
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: options.config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
  });
  app.setErrorHandler(errorHandler);
  app.decorateRequest('auth', null);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.get('/api/health', async () => ({ ok: true }));
  await app.register(loginRoutes, ctx);

  await app.register(async (api) => {
    api.addHook('onRequest', makeAuthenticate(ctx));
    await api.register(sessionRoutes, ctx);
    await api.register(bgRoutes, ctx);
  });

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0]!;
    return reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${path}` });
  });
  return app;
}
```

In `server/test/helpers.ts`, add the import:
```ts
import type { BgClient } from '../src/bg/client';
```
add after the `TestClock` class:
```ts
export const unusedBg: BgClient = {
  latest: () => Promise.reject(new Error('bg client not stubbed in this test')),
};
```
and change the `buildApp` call in `makeTestApp` to:
```ts
  const app = await buildApp({ db, config, deps: { now: clock.now, bg: unusedBg, ...options.deps } });
```

- [ ] **Step 5: Run the BG tests and typecheck**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/bg-route.test.ts test/bg-client.test.ts && pnpm typecheck`
Expected: `Test Files  2 passed (2)`, `Tests  7 passed (7)`, then `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/routes/bg.ts server/src/context.ts server/src/app.ts server/test/helpers.ts server/test/bg-route.test.ts
git commit -m "feat(server): proxy current BG from dexcom-api at /api/bg"
```

---

### Task 14: Serve the web PWA from a configurable directory

**Files:**
- Create: `server/src/static.ts`, `server/test/fixtures.ts`, `server/test/fixtures/web/index.html`, `server/test/fixtures/web/assets/app.js`
- Modify: `server/src/app.ts` (replace the not-found handler)
- Test: `server/test/static.test.ts`

- [ ] **Step 1: Create the fixtures**

`server/test/fixtures/web/index.html`:
```html
<!doctype html>
<html><head><title>CarbBook fixture</title></head><body><div id="root"></div></body></html>
```

`server/test/fixtures/web/assets/app.js`:
```js
console.log('fixture asset');
```

`server/test/fixtures.ts`:
```ts
import { fileURLToPath } from 'node:url';

export const WEB_FIXTURE = fileURLToPath(new URL('./fixtures/web/', import.meta.url));
```

- [ ] **Step 2: Write the failing test**

`server/test/static.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { WEB_FIXTURE } from './fixtures';
import { makeTestApp } from './helpers';

describe('web app static serving', () => {
  it('serves index.html at / and for client-side routes', async () => {
    const { app } = await makeTestApp({ env: { WEB_DIR: WEB_FIXTURE } });
    for (const url of ['/', '/log/2026-09-14', '/settings?tab=sync']) {
      const response = await app.inject({ url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-type'], url).toMatch(/^text\/html/);
      expect(response.body, url).toContain('<title>CarbBook fixture</title>');
    }
  });

  it('serves assets and 404s missing assets and API routes as JSON', async () => {
    const { app } = await makeTestApp({ env: { WEB_DIR: WEB_FIXTURE } });
    const asset = await app.inject({ url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('fixture asset');
    for (const url of ['/assets/missing.js', '/api/unknown']) {
      const response = await app.inject({ url });
      expect(response.statusCode, url).toBe(404);
      expect(response.json().error, url).toBe('not_found');
    }
  });

  it('serves nothing but the API when WEB_DIR is unset', async () => {
    const { app } = await makeTestApp();
    const response = await app.inject({ url: '/' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('not_found');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/static.test.ts`
Expected: FAIL — `/ : expected 404 to be 200` and `expected 404 to be 200` for `/assets/app.js`; the third test passes.

- [ ] **Step 4: Implement**

`server/src/static.ts`:
```ts
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';

const HAS_EXTENSION = /\.[A-Za-z0-9]+$/;

/**
 * Serves the built web PWA from `webDir` and falls back to index.html for client-side routes.
 * `/api/*` and missing asset files always get a JSON 404.
 */
export async function registerWebApp(app: FastifyInstance, webDir: string | null): Promise<void> {
  if (webDir) {
    await app.register(fastifyStatic, { root: resolve(webDir), wildcard: false });
  }
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0]!;
    if (webDir && request.method === 'GET' && !path.startsWith('/api/') && !HAS_EXTENSION.test(path)) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${path}` });
  });
}
```

In `server/src/app.ts`, add the import:
```ts
import { registerWebApp } from './static';
```
and replace
```ts
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0]!;
    return reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${path}` });
  });
  return app;
```
with
```ts
  await registerWebApp(app, options.config.webDir);
  return app;
```

- [ ] **Step 5: Run the static and skeleton tests**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/static.test.ts test/health.test.ts`
Expected: `Test Files  2 passed (2)` and `Tests  6 passed (6)`

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/static.ts server/src/app.ts server/test/fixtures.ts server/test/fixtures/web server/test/static.test.ts
git commit -m "feat(server): serve built web app with SPA fallback"
```

---

### Task 15: Process entry point and end-to-end smoke

**Files:**
- Create: `server/src/main.ts`

- [ ] **Step 1: Implement**

`server/src/main.ts`:
```ts
import { buildApp } from './app';
import { loadConfig } from './config';
import { initDatabase } from './init';

const config = loadConfig(process.env);
const db = initDatabase(config.databasePath);
const app = await buildApp({ db, config, logger: true });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
```

- [ ] **Step 2: Full test suite and typecheck**

Run: `cd ~/Projects/CarbBook/server && pnpm test && pnpm typecheck`
Expected: `Test Files  14 passed (14)`, `Tests  49 passed (49)`, then `tsc` exits 0.

- [ ] **Step 3: Workspace-wide check (core still green)**

Run: `cd ~/Projects/CarbBook && pnpm test && pnpm typecheck`
Expected: both packages report all test files passed; no type errors.

- [ ] **Step 4: Smoke the real server**

Run:
```bash
cd ~/Projects/CarbBook/server && T=$(mktemp -d) \
&& DATABASE_PATH=$T/c.db CARBBOOK_PASSWORD='smoke password' pnpm -s carbbook user add brett --role owner \
&& (DATABASE_PATH=$T/c.db WEB_DIR=test/fixtures/web PORT=3999 HOST=127.0.0.1 COOKIE_SECURE=false DEXCOM_API_URL=http://127.0.0.1:9 timeout 8 pnpm -s start > $T/log 2>&1 &) \
&& for i in $(seq 1 30); do curl -s 127.0.0.1:3999/api/health >/dev/null && break; sleep 0.2; done \
&& curl -s 127.0.0.1:3999/api/health; echo \
&& curl -s -c $T/jar -H 'content-type: application/json' -d '{"username":"brett","password":"smoke password"}' 127.0.0.1:3999/api/auth/login; echo \
&& curl -s -b $T/jar 127.0.0.1:3999/api/bg; echo \
&& curl -s 127.0.0.1:3999/log | head -c 40; echo
```
Expected (in order):
```
Created owner "brett" (id 1)
{"ok":true}
{"user":{"id":1,"username":"brett","role":"owner"}}
{"error":"bg_unavailable","message":"dexcom-api unreachable: fetch failed"}
<!doctype html>
<html><head><title>CarbB
```

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/main.ts
git commit -m "feat(server): process entry point with graceful shutdown"
```

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| §2.2 `server/` package, Node 22/Fastify/better-sqlite3 | 1, 5 |
| §3 synced tables with `id/updated_at/updated_by/deleted/server_seq` | 3 |
| §3 `user` table (argon2id, owner/viewer) | 3, 6 |
| §3 seed dose_settings (windows, correction, rounding) + 2025 history | 4 |
| §4.4 `GET /api/bg` proxy, ≤15 min freshness | 12, 13 |
| §7 web session cookie httpOnly/Secure/SameSite=Lax, 30-day sliding | 8, 9 |
| §7 iOS long-lived bearer token, revocable | 8, 9, 11 |
| §7 login rate limit 5/15 min per IP + username | 10 |
| §7 `carbbook user add` | 7 |
| §7 viewer cannot change dose settings | data plan Task 3 (enforced on sync push) |
| §9 server errors as `{error, message}`; stale/unavailable BG → explicit 503 | 5, 13 |
| Static web dir (configurable, fixture-tested) | 14 |
| Sync, USDA, OFF, search, sync tests | `2026-09-14-carbbook-server-data.md` |

Placeholder scan: no TBD/TODO; every code step shows complete code. Type consistency checked: `AppDeps`/`AppContext` (Tasks 5, 13), `makeAuthenticate`/`requireAuth`/`SESSION_COOKIE`/`sessionCookieOptions` (Task 9) match their uses in Tasks 10, 11, 13; `unusedBg` introduced in Task 13 before any test relies on it.
