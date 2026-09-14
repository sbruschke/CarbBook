# CarbBook Web Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the non-visual half of `@carbbook/web`: the Dexie/IndexedDB store with a persistent outbox, the sync client (push then pull, triggers, backoff, auth expiry), web session auth, the USDA bundle download, local search ranking, BG prefill rules and barcode resolution.

**Architecture:** A pnpm workspace package at `web/` (React 19 + Vite 8, set up here, screens come in the second plan). Every synced write goes through `createStore()`, which stamps `updated_at/updated_by/deleted` and puts a row in an `outbox` table in the same IndexedDB transaction, so pending changes survive reloads. `syncOnce()` pushes the outbox in batches and then pulls pages until drained; `SyncEngine` decides *when* to run it (launch, `online`, 2 s after writes, every 60 s, exponential backoff, stop on 401). All carb/dose/unit/LWW logic comes from `@carbbook/core`; this plan never re-implements it. The network is behind a small `Api` interface so tests use an in-memory `FakeApi` and `fake-indexeddb`.

**Tech Stack:** TypeScript ^7 (strict), Vitest ^5 (jsdom environment), React 19.3.0, Vite 8.3.0, @vitejs/plugin-react 6.1.1, Dexie 4.4.6, dexie-react-hooks 4.4.0, fake-indexeddb 6.2.5, jsdom 30.0.1, @testing-library/react 16.3.3 (+ dom 10.4.2, user-event 14.6.7, jest-dom 7.0.1), vite-plugin-pwa 1.3.0, @zxing/browser 0.2.1 (+ @zxing/library 0.23.0), @playwright/test 1.63.0, @types/node 22.20.2.

**Spec:** `docs/superpowers/specs/2026-09-13-carbbook-design.md` §4.4 BG prefill, §5 sync client, §6 USDA bundle + local search, §7 web session auth, §9 client error handling. **Second plan:** `docs/superpowers/plans/2026-09-14-carbbook-web-ui.md` (screens §8, barcode camera, PWA, Playwright e2e §10) — execute this plan first.

**Prerequisites:** `2026-09-14-carbbook-server-foundation.md` and `2026-09-14-carbbook-server-data.md` are implemented (the API contract below is taken from them). Unit tests in this plan never start the server. **Branch:** `feat/web`, branched from `feat/server` once the server plans are merged.

---

## Verified facts this plan relies on (2026-09-14)

- Versions are `pnpm view <pkg> version` results today. Peer ranges checked: vite-plugin-pwa 1.3.0 accepts `vite ^8`; @vitejs/plugin-react 6.1.1 requires `vite ^8`; vitest 5.0.0 accepts `vite ^6.4 || ^7 || ^8` and optional `jsdom`; @testing-library/react 16.3.3 accepts React 19; @testing-library/jest-dom 7.0.1 accepts `vitest >= 0.32` and ships `@testing-library/jest-dom/vitest`; dexie-react-hooks 4.4.0 accepts `dexie >=4.2 <5`; @zxing/browser 0.2.1 peers `@zxing/library ^0.23.0`.
- All code in both web plans was written into a scratch copy of this workspace (core + web) and run: **23 test files / 120 tests passing, `tsc` clean, `vite build` produces `sw.js` precaching the app shell**. This plan's 13 files / 64 tests are part of that run. The Playwright e2e was not run (server not in the tree yet; browsers not installed).
- Under Vitest 5's jsdom environment: `crypto.subtle.digest`, `DecompressionStream` and `Response` are the Node globals and work; `Blob.prototype.stream` and `indexedDB` do **not** exist, hence `fake-indexeddb/auto` in the setup file and `new Response(bytes).body` for gunzip.
- Vite reports a missing module in a test as `Error: Failed to resolve import "../src/x" from "test/x.test.ts". Does the file exist?`
- `vi.useFakeTimers()` would also freeze fake-indexeddb's internal timers, so the sync engine takes injected `Timers` and tests drive them with `ManualTimers`.
- TypeScript 7's DOM lib has no `BarcodeDetector` type (declared locally in the UI plan).

## API contract used (from the server plans, plus review fixes landing on `feat/server`)

- Errors are `{ error, message }`. Every non-bearer POST/PUT/PATCH/DELETE under `/api` (login included) **must** send `Content-Type: application/json`, else 415 `unsupported_media_type` (`server/src/csrf.ts`); there is no Origin check. `createApi().post` always sends JSON, and bodyless calls (logout) send `{}`. A 415 surfaces as an `ApiError` (a client bug, retried with backoff like any other error).
- `POST /api/auth/login {username,password}` → `{user:{id,username,role}}` + `carbbook_session` cookie (httpOnly, SameSite=Lax, 30-day sliding); 401 `invalid_credentials`; 429 `rate_limited`. `GET /api/auth/me` → `{user}` or 401 `unauthorized`. `POST /api/auth/logout` → `{ok:true}`.
- `POST /api/sync/push {changes:[{table,record}]}` (≤500) → `{results:[{table,id,status:'accepted'|'ignored',server_seq} | {table,id,status:'rejected',reason,message}], server_seq}`; results are in request order. Rejections are per record (`invalid`, `forbidden`, `cycle`, `unknown_table`, `append_only`); `updated_at` more than 24 h in the future is `invalid` (`server/src/sync/validate.ts`); `carbs_per_100g`/`fiber_per_100g` outside 0..100 are `invalid`; re-sending an identical dose_settings version is a no-op and editing an existing version is rejected (`append_only`) — the client only ever creates new versions. The server does not enforce references, so children may arrive before parents (core treats dangling refs as incomplete carbs).
- `GET /api/sync/pull?since=&limit=` → `{changes:[{table,record}], next_since, has_more}` in `server_seq` order, soft deletes included; `dose_settings.windows/correction/rounding` are JSON objects.
- `GET /api/usda/manifest` → `{version, food_count, json_url, json_sha256, …}` or 404 `usda_not_imported`; the gzip file (`application/gzip`, not content-encoded) holds `{format:1, foods:[[fdc_id,name,carbs,fiber]], portions:[[id,fdc_id,label,kind,quantity,grams,description]]}`. Carbs/fiber are null when missing or out of range.
- `GET /api/bg` → `{mgdl,trend,arrow,delta_mgdl,read_at,age_ms,fresh}`; 503 `bg_unavailable`. `fresh` is false for readings older than 15 min **or more than 2 min in the future**.
- `GET /api/barcode/:code` (6–14 digits) → 200 with `status` `known {food,portions}` | `draft {draft:{food,portions,barcode,serving_size}}` | `not_found {code}` | `unavailable {code,message}` (upstream failure or timeout). Draft carbs/fiber may be null.
- `index.html` is served `Cache-Control: no-cache` (the service worker update flow in the UI plan relies on it).

## Decisions and open questions for the owner

1. **Deterministic ids for copied USDA foods.** When a USDA food is used in a meal or log it is copied into `food` as `usda-<fdc_id>` (`source:'usda'`, `source_ref:'<fdc_id>'`) with portions `usda-portion-<usda portion id>`, instead of UUIDv7. Two devices copying the same food offline converge on one row via LWW instead of creating duplicates, and a calculator item keeps the same `ref_id`/unit before and after the copy. The server accepts any 1–64 character id. **The iOS app must use the same scheme** — please confirm.
2. `updated_at` is `max(Date.now(), stored.updated_at + 1)` so a local edit always beats the version it replaces even on a slow clock; it only exceeds "now" when the stored row is itself from a fast clock.
3. Rejected push records are recorded in `sync_error` (shown in Settings → Sync) and removed from the outbox; they are retried only when the record is edited again.
4. When the server is unreachable (network error or non-401 HTTP error) the app opens with the last signed-in user from IndexedDB. A 401 signs out but keeps all local data and the outbox; syncing resumes after the next login.
5. Local search requires every query word to prefix-match a word of the name/brand (like the server's FTS5 prefix query). Order: tier (meals + custom foods, other saved foods, USDA library), then most recently logged, then exact word matches, then shorter names. A saved USDA copy hides its library entry.
6. Barcodes scanned offline and unknown locally go to `pending_barcode` ("look up later" list in Foods).

---

## File structure

```
pnpm-workspace.yaml              add `web`
web/package.json                 @carbbook/web, pinned deps, scripts dev/build/preview/test/typecheck/e2e
web/tsconfig.json                extends ../tsconfig.base.json, DOM libs, react-jsx, node + vite/client types
web/vite.config.ts               React plugin, /api dev proxy, Vitest jsdom config (PWA added in the UI plan)
web/src/lib/ids.ts               uuidv7, usdaFoodId/usdaPortionId/parseUsdaFoodId
web/src/lib/api.ts               createApi (same-origin JSON), ApiError, NetworkError
web/src/lib/wire.ts              server response types
web/src/db/db.ts                 CarbBookDb (Dexie schema v1), SYNC_TABLES, outbox/meta/sync_error/usda/pending tables
web/src/db/meta.ts               get/set/deleteMeta, getDeviceId
web/src/db/store.ts              createStore (save/saveMany/remove + outbox), dataOf
web/src/db/catalog.ts            loadCatalogData, usdaAsFood, loadUsdaFood, buildCatalog (core Catalog)
web/src/usda/materialize.ts      saveUsdaFood, saveUsdaFoodsFor
web/src/sync/push.ts             pushOutbox
web/src/sync/pull.ts             pullAll
web/src/sync/sync.ts             syncOnce (push until drained, then pull)
web/src/sync/engine.ts           SyncEngine (triggers, debounce, interval, backoff, 401)
web/src/auth/session.ts          restoreSession, login, logout, loginErrorMessage
web/src/usda/bundle.ts           syncUsdaLibrary (manifest, sha256, gunzip, replace)
web/src/search/search.ts         tokenize, lastLoggedByRef, buildSearchIndex
web/src/bg/bg.ts                 fetchBg, bgPrefill
web/src/barcode/resolve.ts       barcodeCandidates, resolveBarcode
web/test/setup.ts                fake-indexeddb, jest-dom matchers, RTL cleanup
web/test/helpers.ts              openTestDb, record factories, FakeApi, flush
web/test/timers.ts               ManualTimers, FakeEvents
web/test/*.test.ts               one file per task
```

---

### Task 1: Scaffold `@carbbook/web`

**Files:**
- Modify: `pnpm-workspace.yaml` (full replacement)
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/test/setup.ts`
- Test: `web/test/smoke.test.ts`

- [ ] **Step 1: Add the package to the workspace**

`pnpm-workspace.yaml` (full file):
```yaml
packages:
  - packages/*
  - server
  - web
```

`web/package.json`:
```json
{
  "name": "@carbbook/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@carbbook/core": "workspace:*",
    "@zxing/browser": "0.2.1",
    "@zxing/library": "0.23.0",
    "dexie": "4.4.6",
    "dexie-react-hooks": "4.4.0",
    "react": "19.3.0",
    "react-dom": "19.3.0"
  },
  "devDependencies": {
    "@playwright/test": "1.63.0",
    "@testing-library/dom": "10.4.2",
    "@testing-library/jest-dom": "7.0.1",
    "@testing-library/react": "16.3.3",
    "@testing-library/user-event": "14.6.7",
    "@types/node": "22.20.2",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "6.1.1",
    "fake-indexeddb": "6.2.5",
    "jsdom": "30.0.1",
    "typescript": "^7.0.2",
    "vite": "8.3.0",
    "vite-plugin-pwa": "1.3.0",
    "vitest": "^5.0.0"
  }
}
```

`web/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["node", "vite/client"]
  },
  "include": ["src", "test", "e2e", "vite.config.ts", "playwright.config.ts"]
}
```

`web/vite.config.ts` (the UI plan replaces it to add the PWA plugin):
```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    // `pnpm dev` talks to a locally running carbs-server (server/: `pnpm start`, PORT=3000).
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
```

`web/test/setup.ts`:
```ts
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
```

- [ ] **Step 2: Install**

Run: `cd ~/Projects/CarbBook && pnpm install`
Expected: ends with `Done in …`; `web/node_modules/dexie` and `web/node_modules/@carbbook/core` (a workspace link) exist.

- [ ] **Step 3: Write the smoke test**

`web/test/smoke.test.ts`:
```ts
import { CORE_VERSION } from '@carbbook/core';
import { describe, expect, it } from 'vitest';

describe('web test environment', () => {
  it('resolves @carbbook/core and provides the DOM and IndexedDB', () => {
    expect(CORE_VERSION).toBe('0.1.0');
    expect(document.createElement('div')).toBeInstanceOf(HTMLElement);
    expect(typeof indexedDB.open).toBe('function');
  });
});
```

- [ ] **Step 4: Run it**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/smoke.test.ts`
Expected: `Tests  1 passed (1)`. (If it fails with `indexedDB is not defined`, the setup file is not loaded — check `setupFiles`.)

- [ ] **Step 5: Typecheck**

Run: `cd ~/Projects/CarbBook/web && pnpm typecheck`
Expected: `tsc` exits 0 with no output.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add pnpm-workspace.yaml pnpm-lock.yaml web/package.json web/tsconfig.json web/vite.config.ts web/test/setup.ts web/test/smoke.test.ts
git commit -m "feat(web): scaffold web package with Vitest jsdom and fake IndexedDB"
```

---

### Task 2: Ids, API client and wire types

**Files:**
- Create: `web/src/lib/ids.ts`, `web/src/lib/api.ts`, `web/src/lib/wire.ts`
- Test: `web/test/ids.test.ts`, `web/test/api.test.ts`

- [ ] **Step 1: Write the failing tests**

`web/test/ids.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseUsdaFoodId, usdaFoodId, usdaPortionId, uuidv7 } from '../src/lib/ids';

describe('uuidv7', () => {
  it('encodes the timestamp and sets the version and variant bits', () => {
    const id = uuidv7(0x0189_1234_5678, () => new Uint8Array(16).fill(0xff));
    expect(id).toBe('01891234-5678-7fff-bfff-ffffffffffff');
  });

  it('has the UUIDv7 layout and sorts by creation time', () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe('USDA ids', () => {
  it('are deterministic and reversible', () => {
    expect(usdaFoodId(324860)).toBe('usda-324860');
    expect(usdaPortionId(119207)).toBe('usda-portion-119207');
    expect(parseUsdaFoodId('usda-324860')).toBe(324860);
    expect(parseUsdaFoodId('usda-portion-119207')).toBeNull();
    expect(parseUsdaFoodId('0190f1e2-aaaa-7bbb-8ccc-dddddddddddd')).toBeNull();
  });
});
```

`web/test/api.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ApiError, createApi, type Fetch, NetworkError } from '../src/lib/api';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function recordingFetch(response: () => Response | Promise<Response>) {
  const calls: [string, RequestInit][] = [];
  const fetchImpl: Fetch = async (input, init) => {
    calls.push([input, init]);
    return response();
  };
  return { calls, fetchImpl };
}

describe('createApi', () => {
  it('GETs JSON with same-origin credentials', async () => {
    const { calls, fetchImpl } = recordingFetch(() => json(200, { ok: true }));
    expect(await createApi(fetchImpl).get('/api/health')).toEqual({ ok: true });
    expect(calls).toEqual([['/api/health', { method: 'GET', credentials: 'same-origin' }]]);
  });

  it('POSTs JSON bodies', async () => {
    const { calls, fetchImpl } = recordingFetch(() => json(200, { user: { id: 1 } }));
    await createApi(fetchImpl).post('/api/auth/login', { username: 'brett', password: 'pw' });
    expect(calls[0]![1]).toEqual({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{"username":"brett","password":"pw"}',
    });
  });

  it('always sends a JSON content type, even for bodyless actions like logout', async () => {
    // Cookie-authenticated POSTs without Content-Type: application/json get 415 from the server.
    const { calls, fetchImpl } = recordingFetch(() => json(200, { ok: true }));
    await createApi(fetchImpl).post('/api/auth/logout', {});
    expect(calls[0]![1]).toMatchObject({ headers: { 'content-type': 'application/json' }, body: '{}' });
  });

  it('maps { error, message } bodies to ApiError', async () => {
    const { fetchImpl } = recordingFetch(() => json(401, { error: 'unauthorized', message: 'Sign in required' }));
    const error = await createApi(fetchImpl).get('/api/auth/me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'unauthorized', message: 'Sign in required' });
  });

  it('uses http_error for non-JSON error pages', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(createApi(fetchImpl).get('/api/sync/pull')).rejects.toMatchObject({
      status: 502,
      code: 'http_error',
      message: 'HTTP 502',
    });
  });

  it('wraps fetch failures in NetworkError', async () => {
    const fetchImpl: Fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const error = await createApi(fetchImpl).get('/api/bg').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toBe('Failed to fetch');
  });

  it('reads binary bodies', async () => {
    const { fetchImpl } = recordingFetch(() => new Response(new Uint8Array([31, 139, 8])));
    const bytes = await createApi(fetchImpl).getBytes('/api/usda/files/usda-fdc-1.json.gz');
    expect(Array.from(new Uint8Array(bytes))).toEqual([31, 139, 8]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/ids.test.ts test/api.test.ts`
Expected: FAIL — `Error: Failed to resolve import "../src/lib/ids" from "test/ids.test.ts". Does the file exist?` and the same for `../src/lib/api`.

- [ ] **Step 3: Implement ids**

`web/src/lib/ids.ts`:
```ts
/** UUIDv7 (RFC 9562): 48-bit ms timestamp, version 7, variant 10, random rest. Sorts by creation time. */
export function uuidv7(
  now: number = Date.now(),
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (bytes) => crypto.getRandomValues(bytes),
): string {
  const bytes = random(new Uint8Array(16));
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A USDA food copied into the synced `food` table gets a deterministic id, so two devices that
 * copy the same FDC food offline converge on one row (last-write-wins) instead of duplicates.
 */
export const usdaFoodId = (fdcId: number): string => `usda-${fdcId}`;
export const usdaPortionId = (usdaPortionRowId: number): string => `usda-portion-${usdaPortionRowId}`;

export function parseUsdaFoodId(id: string): number | null {
  const match = /^usda-(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
}
```

- [ ] **Step 4: Implement the API client**

`web/src/lib/api.ts`:
```ts
/** A non-2xx response from carbs-server, carrying its `{ error, message }` body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The request never got a response (offline, DNS failure, tunnel down). */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  getBytes(path: string): Promise<ArrayBuffer>;
}

/** Same-origin JSON client; the session cookie travels automatically. */
export function createApi(fetchImpl: Fetch = (input, init) => fetch(input, init)): Api {
  async function send(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(path, { credentials: 'same-origin', ...init });
    } catch (error) {
      throw new NetworkError(error instanceof Error ? error.message : String(error));
    }
    if (response.ok) return response;
    let code = 'http_error';
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: unknown; message?: unknown };
      if (typeof body.error === 'string') code = body.error;
      if (typeof body.message === 'string') message = body.message;
    } catch {
      // Not JSON (e.g. a Cloudflare error page): keep the generic code and message.
    }
    throw new ApiError(response.status, code, message);
  }

  return {
    async get<T>(path: string): Promise<T> {
      return (await (await send(path, { method: 'GET' })).json()) as T;
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      const response = await send(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return (await response.json()) as T;
    },
    async getBytes(path: string): Promise<ArrayBuffer> {
      return (await send(path, { method: 'GET' })).arrayBuffer();
    },
  };
}
```

- [ ] **Step 5: Add the wire types**

`web/src/lib/wire.ts`:
```ts
import type { FoodData, PortionData, Synced } from '@carbbook/core';

/** Shapes of carbs-server responses (server-foundation and server-data plans, "Wire formats"). */

export type Role = 'owner' | 'viewer';

export interface User {
  id: number;
  username: string;
  role: Role;
}

export type PushResult =
  | { table: string; id: string; status: 'accepted'; server_seq: number }
  | { table: string; id: string; status: 'ignored'; server_seq: number }
  | {
      table: string;
      id: string | null;
      status: 'rejected';
      reason: 'unknown_table' | 'invalid' | 'forbidden' | 'cycle' | 'append_only';
      message: string;
    };

export interface PushResponse {
  results: PushResult[];
  server_seq: number;
}

export interface PullChange {
  table: string;
  /** Always carries server_seq on the wire; optional here so core `Synced<T>` records fit. */
  record: { id: string; updated_at: number; updated_by: string; deleted: 0 | 1; server_seq?: number };
}

export interface PullPage {
  changes: PullChange[];
  next_since: number;
  has_more: boolean;
}

export interface UsdaManifest {
  version: string;
  created_at: number;
  food_count: number;
  portion_count: number;
  json_file: string;
  json_sha256: string;
  json_url: string;
  sqlite_file: string;
  sqlite_sha256: string;
  sqlite_url: string;
}

/** gzip JSON bundle, format 1. */
export interface UsdaJsonBundle {
  format: 1;
  /** [fdc_id, name, carbs_per_100g, fiber_per_100g] */
  foods: [number, string, number | null, number | null][];
  /** [id, fdc_id, label, kind, quantity, grams, description] */
  portions: [number, number, string, string, number, number, string][];
}

export interface BgReading {
  mgdl: number;
  trend: string | null;
  arrow: string | null;
  delta_mgdl: number | null;
  read_at: number;
  age_ms: number;
  fresh: boolean;
}

export interface FoodDraft {
  food: {
    name: string;
    brand: string | null;
    source: 'off';
    source_ref: string;
    carbs_per_100g: number | null;
    fiber_per_100g: number | null;
  };
  portions: { label: string; kind: 'serving'; quantity: number; grams: number }[];
  barcode: string;
  serving_size: string | null;
}

export type BarcodeResponse =
  | { status: 'known'; food: Synced<FoodData>; portions: Synced<PortionData>[] }
  | { status: 'draft'; draft: FoodDraft }
  | { status: 'not_found'; code: string }
  | { status: 'unavailable'; code: string; message: string };
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/ids.test.ts test/api.test.ts && pnpm typecheck`
Expected: `Test Files  2 passed (2)`, `Tests  10 passed (10)`, then `tsc` exits 0.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/lib web/test/ids.test.ts web/test/api.test.ts
git commit -m "feat(web): uuidv7, same-origin JSON API client and wire types"
```

---

### Task 3: Dexie schema, device id and the outbox store

**Files:**
- Create: `web/src/db/db.ts`, `web/src/db/meta.ts`, `web/src/db/store.ts`, `web/test/helpers.ts`
- Test: `web/test/store.test.ts`

- [ ] **Step 1: Write the test helpers**

`web/test/helpers.ts`:
```ts
import type { FoodData, MealData, MealItemData, PortionData, Synced, SyncMeta } from '@carbbook/core';
import { CarbBookDb } from '../src/db/db';
import { type Api, ApiError } from '../src/lib/api';

let dbCounter = 0;

/** A fresh, uniquely named IndexedDB (fake-indexeddb in tests). Call `db.delete()` when done. */
export function openTestDb(): CarbBookDb {
  dbCounter += 1;
  return new CarbBookDb(`carbbook-test-${dbCounter}-${Math.random().toString(36).slice(2)}`);
}

export const foodData = (fields: Partial<FoodData> = {}): FoodData => ({
  id: 'food-1',
  name: 'Tortilla',
  brand: null,
  source: 'custom',
  source_ref: null,
  derived_from: null,
  carbs_per_100g: 48,
  fiber_per_100g: null,
  density_g_per_ml: null,
  notes: null,
  ...fields,
});

export const portionData = (fields: Partial<PortionData> = {}): PortionData => ({
  id: 'portion-1',
  food_id: 'food-1',
  label: 'slice',
  kind: 'count',
  quantity: 1,
  grams: 30,
  ...fields,
});

export const mealData = (fields: Partial<MealData> = {}): MealData => ({
  id: 'meal-1',
  name: 'Tacos',
  yield_servings: 1,
  total_weight_g: null,
  notes: null,
  ...fields,
});

export const mealItemData = (fields: Partial<MealItemData> = {}): MealItemData => ({
  id: 'item-1',
  meal_id: 'meal-1',
  ref_type: 'food',
  ref_id: 'food-1',
  amount: 100,
  unit: 'g',
  position: 0,
  ...fields,
});

export function synced<T>(data: T, meta: Partial<SyncMeta> = {}): Synced<T> {
  return { ...data, updated_at: 1000, updated_by: 'server', deleted: 0, ...meta };
}

type Handler = (body: unknown, path: string) => unknown;

/** In-memory Api: register handlers per `METHOD /path` (query string ignored when matching). */
export class FakeApi implements Api {
  readonly calls: { method: 'GET' | 'POST'; path: string; body?: unknown }[] = [];
  private readonly handlers = new Map<string, Handler>();

  on(method: 'GET' | 'POST', path: string, handler: Handler): this {
    this.handlers.set(`${method} ${path}`, handler);
    return this;
  }

  private async handle(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    this.calls.push(body === undefined ? { method, path } : { method, path, body });
    const handler = this.handlers.get(`${method} ${path.split('?')[0]}`);
    if (!handler) throw new ApiError(404, 'not_found', `No fake route for ${method} ${path}`);
    return handler(body, path);
  }

  async get<T>(path: string): Promise<T> {
    return (await this.handle('GET', path)) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.handle('POST', path, body)) as T;
  }

  async getBytes(path: string): Promise<ArrayBuffer> {
    return (await this.handle('GET', path)) as ArrayBuffer;
  }
}

/** Lets pending promise callbacks run. */
export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
```

- [ ] **Step 2: Write the failing test**

`web/test/store.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { CarbBookDb } from '../src/db/db';
import { getDeviceId } from '../src/db/meta';
import { createStore } from '../src/db/store';
import { foodData, mealData, mealItemData, openTestDb, synced } from './helpers';

let db: CarbBookDb;
afterEach(async () => {
  await db.delete();
});

describe('createStore', () => {
  it('stamps sync metadata, queues the record and reports the write', async () => {
    db = openTestDb();
    let writes = 0;
    const store = createStore(db, 'device-a', { now: () => 5000, onWrite: () => writes++ });
    const saved = await store.save('food', foodData({ id: 'f1' }));
    expect(saved).toEqual({ ...foodData({ id: 'f1' }), updated_at: 5000, updated_by: 'device-a', deleted: 0 });
    expect(await db.food.get('f1')).toEqual(saved);
    expect(await db.outbox.toArray()).toEqual([{ key: 'food:f1', table: 'food', id: 'f1', updated_at: 5000 }]);
    expect(writes).toBe(1);
  });

  it('bumps updated_at past the stored version when the clock is behind, keeping server_seq', async () => {
    db = openTestDb();
    await db.food.put(synced(foodData({ id: 'f1' }), { updated_at: 9000, server_seq: 7 }));
    const store = createStore(db, 'device-a', { now: () => 5000 });
    const saved = await store.save('food', foodData({ id: 'f1', name: 'Wrap' }));
    expect(saved).toMatchObject({ name: 'Wrap', updated_at: 9001, updated_by: 'device-a', server_seq: 7 });
  });

  it('saves several records in one transaction and reports one write', async () => {
    db = openTestDb();
    let writes = 0;
    const store = createStore(db, 'device-a', { now: () => 10, onWrite: () => writes++ });
    await store.saveMany([
      { table: 'meal', data: mealData({ id: 'm1' }) },
      { table: 'meal_item', data: mealItemData({ id: 'i1', meal_id: 'm1' }) },
    ]);
    expect(await db.meal.get('m1')).toMatchObject({ name: 'Tacos', updated_at: 10 });
    expect(await db.meal_item.get('i1')).toMatchObject({ meal_id: 'm1', updated_at: 10 });
    expect((await db.outbox.toArray()).map((row) => row.key)).toEqual(['meal:m1', 'meal_item:i1']);
    expect(writes).toBe(1);
  });

  it('soft-deletes and ignores unknown ids', async () => {
    db = openTestDb();
    let clock = 100;
    const store = createStore(db, 'device-a', { now: () => clock });
    await store.save('food', foodData({ id: 'f1' }));
    clock = 200;
    await store.remove('food', 'f1');
    await store.remove('food', 'missing');
    expect(await db.food.get('f1')).toMatchObject({ name: 'Tortilla', deleted: 1, updated_at: 200 });
    expect(await db.food.get('missing')).toBeUndefined();
    expect(await db.outbox.toArray()).toEqual([{ key: 'food:f1', table: 'food', id: 'f1', updated_at: 200 }]);
  });
});

describe('getDeviceId', () => {
  it('creates the id once and reuses it', async () => {
    db = openTestDb();
    expect(await getDeviceId(db, () => 'dev-1')).toBe('dev-1');
    expect(await getDeviceId(db, () => 'dev-2')).toBe('dev-1');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/store.test.ts`
Expected: FAIL — `Error: Failed to resolve import "../src/db/db" from "test/store.test.ts". Does the file exist?`

- [ ] **Step 4: Implement the schema**

`web/src/db/db.ts`:
```ts
import type {
  BarcodeData,
  DoseSettingsData,
  FoodData,
  LogEntryData,
  LogItemData,
  MealData,
  MealItemData,
  PortionData,
  PortionKind,
  Synced,
} from '@carbbook/core';
import Dexie, { type Table } from 'dexie';

/** Tables synced with carbs-server (spec §3), in the server's order. */
export const SYNC_TABLES = [
  'food',
  'portion',
  'barcode',
  'meal',
  'meal_item',
  'log_entry',
  'log_item',
  'dose_settings',
] as const;

export type SyncTable = (typeof SYNC_TABLES)[number];

export interface SyncRecords {
  food: Synced<FoodData>;
  portion: Synced<PortionData>;
  barcode: Synced<BarcodeData>;
  meal: Synced<MealData>;
  meal_item: Synced<MealItemData>;
  log_entry: Synced<LogEntryData>;
  log_item: Synced<LogItemData>;
  dose_settings: Synced<DoseSettingsData>;
}

export type AnySyncRecord = SyncRecords[SyncTable];

/** One pending local change per record; survives reloads because it lives in IndexedDB. */
export interface OutboxRow {
  key: string;
  table: SyncTable;
  id: string;
  /** updated_at of the local write that queued it. */
  updated_at: number;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

/** A record the server rejected on push (spec §9: shown in Settings → Sync). */
export interface SyncErrorRow {
  key: string;
  table: string;
  id: string;
  reason: string;
  message: string;
  at: number;
}

export interface UsdaFoodRow {
  fdc_id: number;
  name: string;
  carbs_per_100g: number | null;
  fiber_per_100g: number | null;
}

export interface UsdaPortionRow {
  id: number;
  fdc_id: number;
  label: string;
  kind: PortionKind;
  quantity: number;
  grams: number;
  description: string;
}

/** A barcode scanned while offline and not known locally (spec §6). */
export interface PendingBarcodeRow {
  code: string;
  created_at: number;
}

export const outboxKey = (table: SyncTable, id: string): string => `${table}:${id}`;

export function isSyncTable(name: unknown): name is SyncTable {
  return typeof name === 'string' && (SYNC_TABLES as readonly string[]).includes(name);
}

export const isLive = (row: { deleted: 0 | 1 }): boolean => row.deleted === 0;

export class CarbBookDb extends Dexie {
  declare food: Table<SyncRecords['food'], string>;
  declare portion: Table<SyncRecords['portion'], string>;
  declare barcode: Table<SyncRecords['barcode'], string>;
  declare meal: Table<SyncRecords['meal'], string>;
  declare meal_item: Table<SyncRecords['meal_item'], string>;
  declare log_entry: Table<SyncRecords['log_entry'], string>;
  declare log_item: Table<SyncRecords['log_item'], string>;
  declare dose_settings: Table<SyncRecords['dose_settings'], string>;
  declare outbox: Table<OutboxRow, string>;
  declare meta: Table<MetaRow, string>;
  declare sync_error: Table<SyncErrorRow, string>;
  declare usda_food: Table<UsdaFoodRow, number>;
  declare usda_portion: Table<UsdaPortionRow, number>;
  declare pending_barcode: Table<PendingBarcodeRow, string>;

  constructor(name = 'carbbook') {
    super(name);
    this.version(1).stores({
      food: 'id, source_ref',
      portion: 'id, food_id',
      barcode: 'id, code, food_id',
      meal: 'id',
      meal_item: 'id, meal_id, ref_id',
      log_entry: 'id, eaten_at',
      log_item: 'id, log_entry_id, ref_id',
      dose_settings: 'id, effective_from',
      outbox: 'key',
      meta: 'key',
      sync_error: 'key, at',
      usda_food: 'fdc_id',
      usda_portion: 'id, fdc_id',
      pending_barcode: 'code',
    });
  }

  /** Every synced table, for read-write transactions that touch records and the outbox. */
  syncTables(): Table[] {
    return SYNC_TABLES.map((name) => this.table(name));
  }
}
```

- [ ] **Step 5: Implement meta and the device id**

`web/src/db/meta.ts`:
```ts
import { uuidv7 } from '../lib/ids';
import type { User } from '../lib/wire';
import type { CarbBookDb } from './db';

export interface MetaValues {
  device_id: string;
  /** `next_since` from the last applied pull page. */
  last_pull_seq: number;
  last_synced_at: number;
  usda_version: string;
  /** Last signed-in user, so the app opens offline. */
  user: User;
}

export type MetaKey = keyof MetaValues;

export async function getMeta<K extends MetaKey>(db: CarbBookDb, key: K): Promise<MetaValues[K] | undefined> {
  const row = await db.meta.get(key);
  return row?.value as MetaValues[K] | undefined;
}

export async function setMeta<K extends MetaKey>(db: CarbBookDb, key: K, value: MetaValues[K]): Promise<void> {
  await db.meta.put({ key, value });
}

export async function deleteMeta(db: CarbBookDb, key: MetaKey): Promise<void> {
  await db.meta.delete(key);
}

/** This browser's `updated_by`, created once and kept in IndexedDB. */
export function getDeviceId(db: CarbBookDb, makeId: () => string = () => uuidv7()): Promise<string> {
  return db.transaction('rw', db.meta, async () => {
    const existing = await getMeta(db, 'device_id');
    if (existing) return existing;
    const id = makeId();
    await setMeta(db, 'device_id', id);
    return id;
  });
}
```

- [ ] **Step 6: Implement the store**

`web/src/db/store.ts`:
```ts
import type { AnySyncRecord, CarbBookDb, SyncRecords, SyncTable } from './db';
import { outboxKey } from './db';

type MetaField = 'updated_at' | 'updated_by' | 'deleted' | 'server_seq';

/** A record's own fields; the store adds sync metadata. Pass the complete record. */
export type RecordData<T extends SyncTable> = Omit<SyncRecords[T], MetaField>;

export type Change = { [T in SyncTable]: { table: T; data: RecordData<T> } }[SyncTable];

/** A stored record without its sync metadata, ready to edit and save again. */
export function dataOf<T extends SyncTable>(record: SyncRecords[T]): RecordData<T> {
  const { updated_at: _updatedAt, updated_by: _updatedBy, deleted: _deleted, server_seq: _serverSeq, ...data } =
    record as AnySyncRecord;
  return data as unknown as RecordData<T>;
}

export interface Store {
  readonly db: CarbBookDb;
  readonly deviceId: string;
  save<T extends SyncTable>(table: T, data: RecordData<T>): Promise<SyncRecords[T]>;
  /** Saves several records in one transaction (e.g. a meal and its items). */
  saveMany(changes: Change[]): Promise<void>;
  /** Soft delete (spec §5). Unknown ids are ignored. */
  remove(table: SyncTable, id: string): Promise<void>;
}

export interface StoreOptions {
  now?: () => number;
  /** Called after every committed write; the sync engine debounces a push from it. */
  onWrite?: () => void;
}

export function createStore(db: CarbBookDb, deviceId: string, options: StoreOptions = {}): Store {
  const now = options.now ?? Date.now;
  const tables = () => [...db.syncTables(), db.outbox];

  async function stamp(table: SyncTable, id: string, fields: object, deleted: 0 | 1): Promise<AnySyncRecord> {
    const existing = (await db.table(table).get(id)) as AnySyncRecord | undefined;
    // Never go backwards: a local edit must beat the version it replaces even if this clock is behind.
    const updatedAt = Math.max(now(), existing ? existing.updated_at + 1 : 0);
    const record = { ...existing, ...fields, id, updated_at: updatedAt, updated_by: deviceId, deleted } as AnySyncRecord;
    await db.table(table).put(record);
    await db.outbox.put({ key: outboxKey(table, id), table, id, updated_at: updatedAt });
    return record;
  }

  return {
    db,
    deviceId,
    async save<T extends SyncTable>(table: T, data: RecordData<T>): Promise<SyncRecords[T]> {
      const id = (data as { id: string }).id;
      const record = await db.transaction('rw', tables(), () => stamp(table, id, data, 0));
      options.onWrite?.();
      return record as SyncRecords[T];
    },
    async saveMany(changes: Change[]): Promise<void> {
      if (changes.length === 0) return;
      await db.transaction('rw', tables(), async () => {
        for (const change of changes) await stamp(change.table, change.data.id, change.data, 0);
      });
      options.onWrite?.();
    },
    async remove(table: SyncTable, id: string): Promise<void> {
      const removed = await db.transaction('rw', tables(), async () => {
        if (!(await db.table(table).get(id))) return false;
        await stamp(table, id, {}, 1);
        return true;
      });
      if (removed) options.onWrite?.();
    },
  };
}
```

- [ ] **Step 7: Run the test and typecheck**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/store.test.ts && pnpm typecheck`
Expected: `Tests  5 passed (5)`, then `tsc` exits 0.

- [ ] **Step 8: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/db web/test/helpers.ts web/test/store.test.ts
git commit -m "feat(web): IndexedDB schema with a persistent sync outbox"
```

---

### Task 4: Core catalog from IndexedDB and USDA copies

**Files:**
- Create: `web/src/db/catalog.ts`, `web/src/usda/materialize.ts`
- Test: `web/test/catalog.test.ts`

- [ ] **Step 1: Write the failing test**

`web/test/catalog.test.ts`:
```ts
import { foodUnits, itemCarbs } from '@carbbook/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCatalog, loadCatalogData, loadUsdaFood } from '../src/db/catalog';
import type { CarbBookDb } from '../src/db/db';
import { createStore } from '../src/db/store';
import { saveUsdaFood, saveUsdaFoodsFor } from '../src/usda/materialize';
import { foodData, mealData, mealItemData, openTestDb, synced } from './helpers';

let db: CarbBookDb;
afterEach(async () => {
  await db.delete();
});

async function seedPeanutButter(target: CarbBookDb) {
  await target.usda_food.put({ fdc_id: 324860, name: 'Peanut butter, smooth style, with salt', carbs_per_100g: 22.3, fiber_per_100g: 4.8 });
  await target.usda_portion.put({ id: 119207, fdc_id: 324860, label: 'tbsp', kind: 'volume', quantity: 2, grams: 32, description: 'tablespoon' });
}

describe('catalog', () => {
  it('skips deleted rows and feeds core carb math', async () => {
    db = openTestDb();
    await db.food.bulkPut([
      synced(foodData({ id: 'f1', carbs_per_100g: 48 })),
      synced(foodData({ id: 'f2', name: 'Gone' }), { deleted: 1 }),
    ]);
    await db.meal.put(synced(mealData({ id: 'm1', yield_servings: 2 })));
    await db.meal_item.put(synced(mealItemData({ id: 'i1', meal_id: 'm1', ref_id: 'f1', amount: 100, unit: 'g' })));
    const data = await loadCatalogData(db);
    expect(data.foods.map((f) => f.id)).toEqual(['f1']);
    expect(itemCarbs(buildCatalog(data), 'meal', 'm1', 1, 'serving')).toEqual({ carbs_g: 24, complete: true });
  });

  it('resolves an unsaved USDA food with its volume portion', async () => {
    db = openTestDb();
    await seedPeanutButter(db);
    const usda = await loadUsdaFood(db, 324860);
    expect(usda?.food).toMatchObject({ id: 'usda-324860', source: 'usda', source_ref: '324860' });
    const catalog = buildCatalog(await loadCatalogData(db), [usda!]);
    expect(foodUnits(usda!.food, usda!.portions)).toContain('tbsp');
    const carbs = itemCarbs(catalog, 'food', 'usda-324860', 2, 'tbsp');
    expect(carbs.complete).toBe(true);
    expect(carbs.carbs_g).toBeCloseTo(7.136, 3);
    expect(await loadUsdaFood(db, 1)).toBeNull();
  });
});

describe('saveUsdaFood', () => {
  it('copies the food and portions once, and restores a deleted copy', async () => {
    db = openTestDb();
    await seedPeanutButter(db);
    const store = createStore(db, 'device-a', { now: () => 1000 });

    expect(await saveUsdaFood(store, 324860)).toBe('usda-324860');
    expect(await db.food.get('usda-324860')).toMatchObject({ source: 'usda', source_ref: '324860', carbs_per_100g: 22.3, deleted: 0 });
    expect(await db.portion.where('food_id').equals('usda-324860').toArray()).toEqual([
      { id: 'usda-portion-119207', food_id: 'usda-324860', label: 'tbsp', kind: 'volume', quantity: 2, grams: 32, updated_at: 1000, updated_by: 'device-a', deleted: 0 },
    ]);
    expect(await db.outbox.count()).toBe(2);

    await db.outbox.clear();
    await saveUsdaFood(store, 324860);
    expect(await db.outbox.count()).toBe(0);

    await store.remove('food', 'usda-324860');
    await saveUsdaFoodsFor(store, [
      { ref_type: 'food', ref_id: 'usda-324860' },
      { ref_type: 'meal', ref_id: 'usda-324860' },
      { ref_type: 'food', ref_id: 'f1' },
    ]);
    expect((await db.food.get('usda-324860'))?.deleted).toBe(0);
  });

  it('fails clearly when the library does not have the food', async () => {
    db = openTestDb();
    const store = createStore(db, 'device-a');
    await expect(saveUsdaFood(store, 999)).rejects.toThrow('USDA food 999 is not in the downloaded library');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/catalog.test.ts`
Expected: FAIL — `Error: Failed to resolve import "../src/db/catalog" from "test/catalog.test.ts". Does the file exist?`

- [ ] **Step 3: Implement the catalog loader**

`web/src/db/catalog.ts`:
```ts
import {
  type Catalog,
  createCatalog,
  type FoodData,
  type MealData,
  type MealItemData,
  type PortionData,
  type Synced,
} from '@carbbook/core';
import { usdaFoodId, usdaPortionId } from '../lib/ids';
import type { CarbBookDb, UsdaFoodRow, UsdaPortionRow } from './db';
import { isLive } from './db';

export interface CatalogData {
  foods: Synced<FoodData>[];
  portions: Synced<PortionData>[];
  meals: Synced<MealData>[];
  meal_items: Synced<MealItemData>[];
}

/** A USDA library food shaped like a saved food, before (or without) copying it into `food`. */
export interface UsdaFoodEntry {
  food: FoodData;
  portions: PortionData[];
}

/** Non-deleted foods, portions, meals and meal items, read consistently. */
export function loadCatalogData(db: CarbBookDb): Promise<CatalogData> {
  return db.transaction('r', [db.food, db.portion, db.meal, db.meal_item], async () => {
    const [foods, portions, meals, mealItems] = await Promise.all([
      db.food.filter(isLive).toArray(),
      db.portion.filter(isLive).toArray(),
      db.meal.filter(isLive).toArray(),
      db.meal_item.filter(isLive).toArray(),
    ]);
    return { foods, portions, meals, meal_items: mealItems };
  });
}

export function usdaAsFood(food: UsdaFoodRow, portions: UsdaPortionRow[]): UsdaFoodEntry {
  const id = usdaFoodId(food.fdc_id);
  return {
    food: {
      id,
      name: food.name,
      brand: null,
      source: 'usda',
      source_ref: String(food.fdc_id),
      derived_from: null,
      carbs_per_100g: food.carbs_per_100g,
      fiber_per_100g: food.fiber_per_100g,
      density_g_per_ml: null,
      notes: null,
    },
    portions: portions.map((p) => ({
      id: usdaPortionId(p.id),
      food_id: id,
      label: p.label,
      kind: p.kind,
      quantity: p.quantity,
      grams: p.grams,
    })),
  };
}

export async function loadUsdaFood(db: CarbBookDb, fdcId: number): Promise<UsdaFoodEntry | null> {
  const food = await db.usda_food.get(fdcId);
  if (!food) return null;
  return usdaAsFood(food, await db.usda_portion.where('fdc_id').equals(fdcId).toArray());
}

/**
 * Core catalog over saved data plus USDA foods that are not saved yet. A saved copy (same
 * deterministic id) always wins over the library entry.
 */
export function buildCatalog(data: CatalogData, usda: UsdaFoodEntry[] = []): Catalog {
  const saved = new Set(data.foods.map((f) => f.id));
  const extra = usda.filter((entry) => !saved.has(entry.food.id));
  return createCatalog({
    foods: [...data.foods, ...extra.map((entry) => entry.food)],
    portions: [...data.portions, ...extra.flatMap((entry) => entry.portions)],
    meals: data.meals,
    meal_items: data.meal_items,
  });
}
```

- [ ] **Step 4: Implement USDA copies**

`web/src/usda/materialize.ts`:
```ts
import type { RefType } from '@carbbook/core';
import { loadUsdaFood } from '../db/catalog';
import type { Change, Store } from '../db/store';
import { parseUsdaFoodId, usdaFoodId } from '../lib/ids';

/**
 * Copies a USDA library food and its portions into the synced `food`/`portion` tables
 * (`source: 'usda'`, `source_ref: <fdc_id>`) so references resolve on every device.
 * A live copy is left untouched; a deleted copy is restored.
 */
export async function saveUsdaFood(store: Store, fdcId: number): Promise<string> {
  const id = usdaFoodId(fdcId);
  const existing = await store.db.food.get(id);
  if (existing && existing.deleted === 0) return id;
  const entry = await loadUsdaFood(store.db, fdcId);
  if (!entry) throw new Error(`USDA food ${fdcId} is not in the downloaded library`);
  const changes: Change[] = [
    { table: 'food', data: entry.food },
    ...entry.portions.map((portion): Change => ({ table: 'portion', data: portion })),
  ];
  await store.saveMany(changes);
  return id;
}

/** Saves every not-yet-saved USDA food referenced by these meal or log items. */
export async function saveUsdaFoodsFor(store: Store, refs: { ref_type: RefType; ref_id: string }[]): Promise<void> {
  const fdcIds = new Set<number>();
  for (const ref of refs) {
    const fdcId = ref.ref_type === 'food' ? parseUsdaFoodId(ref.ref_id) : null;
    if (fdcId !== null) fdcIds.add(fdcId);
  }
  for (const fdcId of fdcIds) await saveUsdaFood(store, fdcId);
}
```

- [ ] **Step 5: Run the test and typecheck**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/catalog.test.ts && pnpm typecheck`
Expected: `Tests  4 passed (4)`, then `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/db/catalog.ts web/src/usda/materialize.ts web/test/catalog.test.ts
git commit -m "feat(web): core catalog over IndexedDB and synced USDA food copies"
```

---

### Task 5: Push the outbox

**Files:**
- Create: `web/src/sync/push.ts`
- Test: `web/test/push.test.ts`

- [ ] **Step 1: Write the failing test**

`web/test/push.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { CarbBookDb } from '../src/db/db';
import { createStore } from '../src/db/store';
import { NetworkError } from '../src/lib/api';
import type { PushResponse } from '../src/lib/wire';
import { pushOutbox } from '../src/sync/push';
import { FakeApi, foodData, mealData, openTestDb } from './helpers';

type PushBody = { changes: { table: string; record: { id: string } }[] };

let db: CarbBookDb;
afterEach(async () => {
  await db.delete();
});

const acceptAll =
  (firstSeq: number) =>
  (body: unknown): PushResponse => ({
    results: (body as PushBody).changes.map((c, i) => ({ table: c.table, id: c.record.id, status: 'accepted', server_seq: firstSeq + i })),
    server_seq: firstSeq + (body as PushBody).changes.length - 1,
  });

describe('pushOutbox', () => {
  it('pushes queued records, stores server_seq and clears the outbox', async () => {
    db = openTestDb();
    const store = createStore(db, 'device-a', { now: () => 1000 });
    await store.save('food', foodData({ id: 'f1' }));
    await store.save('meal', mealData({ id: 'm1' }));
    const api = new FakeApi().on('POST', '/api/sync/push', acceptAll(10));

    expect(await pushOutbox(db, api)).toEqual({ sent: 2, accepted: 2, ignored: 0, rejected: 0 });
    expect(api.calls[0]!.body).toEqual({
      changes: [
        { table: 'food', record: { ...foodData({ id: 'f1' }), updated_at: 1000, updated_by: 'device-a', deleted: 0 } },
        { table: 'meal', record: { ...mealData({ id: 'm1' }), updated_at: 1000, updated_by: 'device-a', deleted: 0 } },
      ],
    });
    expect((await db.food.get('f1'))?.server_seq).toBe(10);
    expect((await db.meal.get('m1'))?.server_seq).toBe(11);
    expect(await db.outbox.count()).toBe(0);
  });

  it('keeps the outbox entry when the record is edited during the push', async () => {
    db = openTestDb();
    let clock = 1000;
    const store = createStore(db, 'device-a', { now: () => clock });
    await store.save('food', foodData({ id: 'f1' }));
    const api = new FakeApi().on('POST', '/api/sync/push', async (body) => {
      clock = 2000;
      await store.save('food', foodData({ id: 'f1', name: 'Edited' }));
      return acceptAll(4)(body);
    });

    await pushOutbox(db, api);
    expect(await db.outbox.toArray()).toEqual([{ key: 'food:f1', table: 'food', id: 'f1', updated_at: 2000 }]);
    expect(await db.food.get('f1')).toMatchObject({ name: 'Edited', updated_at: 2000 });
    expect((await db.food.get('f1'))?.server_seq).toBeUndefined();
  });

  it('records rejections as sync errors without retrying, and clears them once accepted', async () => {
    db = openTestDb();
    let clock = 1000;
    const store = createStore(db, 'device-a', { now: () => clock });
    await store.save('food', foodData({ id: 'f1', carbs_per_100g: 48 }));
    const api = new FakeApi().on('POST', '/api/sync/push', () => ({
      results: [{ table: 'food', id: 'f1', status: 'rejected', reason: 'invalid', message: 'carbs_per_100g must be >= 0' }],
      server_seq: 3,
    }));

    expect(await pushOutbox(db, api, () => 7000)).toEqual({ sent: 1, accepted: 0, ignored: 0, rejected: 1 });
    expect(await db.sync_error.toArray()).toEqual([
      { key: 'food:f1', table: 'food', id: 'f1', reason: 'invalid', message: 'carbs_per_100g must be >= 0', at: 7000 },
    ]);
    expect(await db.outbox.count()).toBe(0);

    clock = 8000;
    await store.save('food', foodData({ id: 'f1', carbs_per_100g: 50 }));
    api.on('POST', '/api/sync/push', acceptAll(4));
    await pushOutbox(db, api);
    expect(await db.sync_error.count()).toBe(0);
  });

  it('drops ignored records from the outbox (the pull brings the winner)', async () => {
    db = openTestDb();
    const store = createStore(db, 'device-a', { now: () => 1000 });
    await store.save('food', foodData({ id: 'f1' }));
    const api = new FakeApi().on('POST', '/api/sync/push', () => ({
      results: [{ table: 'food', id: 'f1', status: 'ignored', server_seq: 9 }],
      server_seq: 9,
    }));
    expect(await pushOutbox(db, api)).toEqual({ sent: 1, accepted: 0, ignored: 1, rejected: 0 });
    expect(await db.outbox.count()).toBe(0);
    expect((await db.food.get('f1'))?.server_seq).toBeUndefined();
  });

  it('sends nothing when the outbox is empty', async () => {
    db = openTestDb();
    const api = new FakeApi();
    expect(await pushOutbox(db, api)).toEqual({ sent: 0, accepted: 0, ignored: 0, rejected: 0 });
    expect(api.calls).toEqual([]);
  });

  it('keeps pending changes when the network fails', async () => {
    db = openTestDb();
    const store = createStore(db, 'device-a');
    await store.save('food', foodData({ id: 'f1' }));
    const api = new FakeApi().on('POST', '/api/sync/push', () => {
      throw new NetworkError('Failed to fetch');
    });
    await expect(pushOutbox(db, api)).rejects.toThrow(NetworkError);
    expect(await db.outbox.count()).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/push.test.ts`
Expected: FAIL — `Error: Failed to resolve import "../src/sync/push" from "test/push.test.ts". Does the file exist?`

- [ ] **Step 3: Implement**

`web/src/sync/push.ts`:
```ts
import type { AnySyncRecord, CarbBookDb, OutboxRow } from '../db/db';
import type { Api } from '../lib/api';
import type { PushResponse } from '../lib/wire';

/** Server limit per request (server-data plan: MAX_PUSH_CHANGES). */
export const PUSH_BATCH_SIZE = 500;

export interface PushSummary {
  sent: number;
  accepted: number;
  ignored: number;
  rejected: number;
}

/**
 * Pushes one batch of pending changes. The outbox entry is removed only if the record was not
 * edited again while the request was in flight. Rejected records are stored as sync errors and
 * not retried until edited again.
 */
export async function pushOutbox(db: CarbBookDb, api: Api, now: () => number = Date.now): Promise<PushSummary> {
  const summary: PushSummary = { sent: 0, accepted: 0, ignored: 0, rejected: 0 };
  const batch: { entry: OutboxRow; record: AnySyncRecord }[] = [];
  for (const entry of await db.outbox.limit(PUSH_BATCH_SIZE).toArray()) {
    const record = (await db.table(entry.table).get(entry.id)) as AnySyncRecord | undefined;
    if (record) batch.push({ entry, record });
    else await db.outbox.delete(entry.key);
  }
  if (batch.length === 0) return summary;

  const response = await api.post<PushResponse>('/api/sync/push', {
    changes: batch.map(({ entry, record }) => ({ table: entry.table, record })),
  });

  await db.transaction('rw', [db.outbox, db.sync_error, ...db.syncTables()], async () => {
    for (const [index, { entry, record }] of batch.entries()) {
      const result = response.results[index];
      if (!result) continue;
      summary.sent++;
      const pending = await db.outbox.get(entry.key);
      const unchanged = pending !== undefined && pending.updated_at === record.updated_at;
      if (result.status === 'rejected') {
        summary.rejected++;
        await db.sync_error.put({
          key: entry.key,
          table: entry.table,
          id: entry.id,
          reason: result.reason,
          message: result.message,
          at: now(),
        });
      } else {
        await db.sync_error.delete(entry.key);
        if (result.status === 'accepted') {
          summary.accepted++;
          if (unchanged) await db.table(entry.table).update(entry.id, { server_seq: result.server_seq });
        } else {
          summary.ignored++;
        }
      }
      if (unchanged) await db.outbox.delete(entry.key);
    }
  });
  return summary;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/push.test.ts`
Expected: `Tests  6 passed (6)`

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/sync/push.ts web/test/push.test.ts
git commit -m "feat(web): push outbox with per-record results and sync errors"
```

---

### Task 6: Pull pages and one full sync pass

**Files:**
- Create: `web/src/sync/pull.ts`, `web/src/sync/sync.ts`
- Test: `web/test/pull.test.ts`

- [ ] **Step 1: Write the failing test**

`web/test/pull.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { CarbBookDb } from '../src/db/db';
import { getMeta } from '../src/db/meta';
import { createStore } from '../src/db/store';
import { NetworkError } from '../src/lib/api';
import type { PullPage, PushResponse } from '../src/lib/wire';
import { pullAll } from '../src/sync/pull';
import { syncOnce } from '../src/sync/sync';
import { FakeApi, foodData, mealData, openTestDb, synced } from './helpers';

let db: CarbBookDb;
afterEach(async () => {
  await db.delete();
});

const sinceOf = (path: string) => Number(new URL(path, 'http://x').searchParams.get('since'));

describe('pullAll', () => {
  it('applies pages until drained and stores the cursor', async () => {
    db = openTestDb();
    const pages: Record<number, PullPage> = {
      0: {
        changes: [
          { table: 'food', record: synced(foodData({ id: 'f1' }), { server_seq: 4 }) },
          { table: 'meal', record: synced(mealData({ id: 'm1' }), { server_seq: 5 }) },
        ],
        next_since: 5,
        has_more: true,
      },
      5: {
        changes: [{ table: 'food', record: synced(foodData({ id: 'f1' }), { updated_at: 2000, deleted: 1, server_seq: 6 }) }],
        next_since: 6,
        has_more: false,
      },
    };
    const api = new FakeApi().on('GET', '/api/sync/pull', (_body, path) => pages[sinceOf(path)]);

    expect(await pullAll(db, api, 2)).toEqual({ applied: 3, pages: 2 });
    expect(api.calls.map((c) => c.path)).toEqual(['/api/sync/pull?since=0&limit=2', '/api/sync/pull?since=5&limit=2']);
    expect(await db.food.get('f1')).toMatchObject({ deleted: 1, server_seq: 6 });
    expect(await db.meal.get('m1')).toMatchObject({ name: 'Tacos' });
    expect(await getMeta(db, 'last_pull_seq')).toBe(6);
  });

  it('keeps a pending local edit that is newer than the pulled record', async () => {
    db = openTestDb();
    await createStore(db, 'device-a', { now: () => 5000 }).save('food', foodData({ id: 'f1', name: 'Local' }));
    const api = new FakeApi().on('GET', '/api/sync/pull', () => ({
      changes: [{ table: 'food', record: synced(foodData({ id: 'f1', name: 'Server' }), { updated_at: 4000, server_seq: 4 }) }],
      next_since: 4,
      has_more: false,
    }));
    await pullAll(db, api);
    expect((await db.food.get('f1'))?.name).toBe('Local');
    expect(await db.outbox.count()).toBe(1);
  });

  it('lets a newer server record replace an older pending edit', async () => {
    db = openTestDb();
    await createStore(db, 'device-a', { now: () => 5000 }).save('food', foodData({ id: 'f1', name: 'Local' }));
    const api = new FakeApi().on('GET', '/api/sync/pull', () => ({
      changes: [{ table: 'food', record: synced(foodData({ id: 'f1', name: 'Server' }), { updated_at: 6000, server_seq: 4 }) }],
      next_since: 4,
      has_more: false,
    }));
    await pullAll(db, api);
    expect((await db.food.get('f1'))?.name).toBe('Server');
    expect(await db.outbox.count()).toBe(0);
  });

  it('skips unknown tables but still advances the cursor', async () => {
    db = openTestDb();
    const api = new FakeApi().on('GET', '/api/sync/pull', () => ({
      changes: [{ table: 'user', record: { id: 'u1', updated_at: 1, updated_by: 'x', deleted: 0, server_seq: 9 } }],
      next_since: 9,
      has_more: false,
    }));
    expect(await pullAll(db, api)).toEqual({ applied: 0, pages: 1 });
    expect(await getMeta(db, 'last_pull_seq')).toBe(9);
  });

  it('keeps applied pages when a later page fails, and resumes from there', async () => {
    db = openTestDb();
    const api = new FakeApi().on('GET', '/api/sync/pull', (_body, path) => {
      if (sinceOf(path) === 0) {
        return { changes: [{ table: 'food', record: synced(foodData({ id: 'f1' }), { server_seq: 5 }) }], next_since: 5, has_more: true };
      }
      throw new NetworkError('Failed to fetch');
    });
    await expect(pullAll(db, api)).rejects.toThrow(NetworkError);
    expect(await db.food.get('f1')).toBeDefined();
    expect(await getMeta(db, 'last_pull_seq')).toBe(5);
  });
});

describe('syncOnce', () => {
  it('pushes before pulling and records the sync time', async () => {
    db = openTestDb();
    await createStore(db, 'device-a', { now: () => 1000 }).save('food', foodData({ id: 'f1' }));
    const api = new FakeApi()
      .on('POST', '/api/sync/push', (): PushResponse => ({ results: [{ table: 'food', id: 'f1', status: 'accepted', server_seq: 4 }], server_seq: 4 }))
      .on('GET', '/api/sync/pull', (): PullPage => ({
        changes: [{ table: 'food', record: synced(foodData({ id: 'f1' }), { updated_at: 1000, updated_by: 'device-a', server_seq: 4 }) }],
        next_since: 4,
        has_more: false,
      }));

    await syncOnce(db, api, () => 9999);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/sync/push', 'GET /api/sync/pull?since=0&limit=500']);
    expect(await getMeta(db, 'last_synced_at')).toBe(9999);
    expect(await db.outbox.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/pull.test.ts`
Expected: FAIL — `Error: Failed to resolve import "../src/sync/pull" from "test/pull.test.ts". Does the file exist?`

- [ ] **Step 3: Implement pull**

`web/src/sync/pull.ts`:
```ts
import { isNewer } from '@carbbook/core';
import type { AnySyncRecord, CarbBookDb } from '../db/db';
import { isSyncTable, outboxKey } from '../db/db';
import { getMeta, setMeta } from '../db/meta';
import type { Api } from '../lib/api';
import type { PullPage } from '../lib/wire';

export const PULL_PAGE_SIZE = 500;

/**
 * Pulls pages until drained. Each page and its cursor commit together, so an interrupted pull
 * resumes where it stopped. A pending local edit that is newer than the pulled record is kept
 * (it will be pushed); otherwise the server record wins and the pending entry is dropped.
 */
export async function pullAll(
  db: CarbBookDb,
  api: Api,
  pageSize: number = PULL_PAGE_SIZE,
): Promise<{ applied: number; pages: number }> {
  let applied = 0;
  let pages = 0;
  for (;;) {
    const since = (await getMeta(db, 'last_pull_seq')) ?? 0;
    const page = await api.get<PullPage>(`/api/sync/pull?since=${since}&limit=${pageSize}`);
    pages++;
    await db.transaction('rw', [db.outbox, db.meta, ...db.syncTables()], async () => {
      for (const change of page.changes) {
        if (!isSyncTable(change.table)) continue;
        const incoming = change.record;
        const key = outboxKey(change.table, incoming.id);
        const pending = await db.outbox.get(key);
        if (pending) {
          const local = (await db.table(change.table).get(incoming.id)) as AnySyncRecord | undefined;
          if (local && !isNewer(incoming, local)) continue;
          await db.outbox.delete(key);
        }
        await db.table(change.table).put(incoming);
        applied++;
      }
      await setMeta(db, 'last_pull_seq', page.next_since);
    });
    if (!page.has_more) return { applied, pages };
  }
}
```

- [ ] **Step 4: Implement the sync pass**

`web/src/sync/sync.ts`:
```ts
import type { CarbBookDb } from '../db/db';
import { setMeta } from '../db/meta';
import type { Api } from '../lib/api';
import { pullAll } from './pull';
import { pushOutbox } from './push';

/** One sync pass (spec §5): push until the outbox is drained, then pull until drained. */
export async function syncOnce(db: CarbBookDb, api: Api, now: () => number = Date.now): Promise<void> {
  for (;;) {
    const summary = await pushOutbox(db, api, now);
    if (summary.sent === 0 || (await db.outbox.count()) === 0) break;
  }
  await pullAll(db, api);
  await setMeta(db, 'last_synced_at', now());
}
```

- [ ] **Step 5: Run the test and typecheck**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/pull.test.ts && pnpm typecheck`
Expected: `Tests  6 passed (6)`, then `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/sync/pull.ts web/src/sync/sync.ts web/test/pull.test.ts
git commit -m "feat(web): paged pull with LWW against pending edits; push-then-pull pass"
```

---

### Task 7: Sync engine (triggers, backoff, auth expiry)

**Files:**
- Create: `web/src/sync/engine.ts`, `web/test/timers.ts`
- Test: `web/test/engine.test.ts`

- [ ] **Step 1: Write the timer and connectivity fakes**

`web/test/timers.ts`:
```ts
import type { ConnectivityEvents, Timers } from '../src/sync/engine';
import { flush } from './helpers';

/** Deterministic timers for the sync engine (real timers stay free for fake-indexeddb). */
export class ManualTimers implements Timers {
  now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; fn: () => void; every: number | null }>();

  setTimeout = (fn: () => void, ms: number): unknown => this.add(fn, ms, null);
  setInterval = (fn: () => void, ms: number): unknown => this.add(fn, ms, ms);
  clearTimeout = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };
  clearInterval = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  private add(fn: () => void, ms: number, every: number | null): number {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + ms, fn, every });
    return id;
  }

  /** Runs every task due within `ms`, in time order, flushing promises after each. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, task] = due;
      this.now = task.at;
      if (task.every === null) this.tasks.delete(id);
      else task.at += task.every;
      task.fn();
      await flush();
    }
    this.now = end;
  }
}

export class FakeEvents implements ConnectivityEvents {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: 'online' | 'offline', listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: 'online' | 'offline', listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: 'online' | 'offline'): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}
```

- [ ] **Step 2: Write the failing test**

`web/test/engine.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api';
import { SIGNED_OUT_MESSAGE, SyncEngine, type SyncPhase } from '../src/sync/engine';
import { flush } from './helpers';
import { FakeEvents, ManualTimers } from './timers';

function setup(run: () => Promise<void> = async () => {}) {
  const timers = new ManualTimers();
  const events = new FakeEvents();
  const state = { online: true, runs: 0, authExpired: 0 };
  const engine = new SyncEngine({
    run: async () => {
      state.runs++;
      await run();
    },
    isOnline: () => state.online,
    events,
    timers,
    now: () => timers.now,
    onAuthExpired: () => state.authExpired++,
  });
  return { engine, timers, events, state };
}

describe('SyncEngine', () => {
  it('syncs on start and every 60 s while online', async () => {
    const { engine, timers, state } = setup();
    engine.start();
    await flush();
    expect(state.runs).toBe(1);
    expect(engine.getStatus().phase).toBe('idle');
    await timers.advance(60_000);
    expect(state.runs).toBe(2);
    await timers.advance(60_000);
    expect(state.runs).toBe(3);
  });

  it('debounces local writes by 2 s', async () => {
    const { engine, timers, state } = setup();
    engine.start();
    await flush();
    engine.requestSync();
    await timers.advance(500);
    engine.requestSync();
    await timers.advance(1_999);
    expect(state.runs).toBe(1);
    await timers.advance(1);
    expect(state.runs).toBe(2);
  });

  it('waits while offline and syncs on reconnect', async () => {
    const { engine, events, state } = setup();
    state.online = false;
    engine.start();
    await flush();
    expect(state.runs).toBe(0);
    expect(engine.getStatus().phase).toBe('offline');
    state.online = true;
    events.emit('online');
    await flush();
    expect(state.runs).toBe(1);
    expect(engine.getStatus().phase).toBe('idle');
  });

  it('retries failures with exponential backoff', async () => {
    let failuresLeft = 2;
    const { engine, timers, state } = setup(async () => {
      if (failuresLeft-- > 0) throw new ApiError(502, 'http_error', 'HTTP 502');
    });
    engine.start();
    await flush();
    expect(engine.getStatus()).toEqual({ phase: 'error', error: 'HTTP 502', retryAt: 2_000 });
    await timers.advance(2_000);
    expect(state.runs).toBe(2);
    expect(engine.getStatus()).toEqual({ phase: 'error', error: 'HTTP 502', retryAt: 6_000 });
    await timers.advance(4_000);
    expect(state.runs).toBe(3);
    expect(engine.getStatus().phase).toBe('idle');
  });

  it('stops on 401 until resumed after sign-in', async () => {
    let expired = true;
    const { engine, timers, state } = setup(async () => {
      if (expired) throw new ApiError(401, 'unauthorized', 'Session expired or revoked');
    });
    engine.start();
    await flush();
    expect(engine.getStatus()).toEqual({ phase: 'signed_out', error: SIGNED_OUT_MESSAGE, retryAt: null });
    expect(state.authExpired).toBe(1);
    engine.requestSync();
    await timers.advance(60_000);
    expect(state.runs).toBe(1);
    expired = false;
    engine.resume();
    await flush();
    expect(state.runs).toBe(2);
    expect(engine.getStatus().phase).toBe('idle');
  });

  it('runs once more when a sync is requested during a sync', async () => {
    let release: () => void = () => {};
    let first = true;
    const { engine, state } = setup(async () => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });
    engine.start();
    await flush();
    void engine.syncNow();
    expect(state.runs).toBe(1);
    release();
    await flush();
    expect(state.runs).toBe(2);
  });

  it('notifies subscribers and stops cleanly', async () => {
    const { engine, timers, state } = setup();
    const phases: SyncPhase[] = [];
    const unsubscribe = engine.subscribe(() => phases.push(engine.getStatus().phase));
    engine.start();
    await flush();
    expect(phases).toEqual(['syncing', 'idle']);
    unsubscribe();
    engine.stop();
    await timers.advance(120_000);
    expect(state.runs).toBe(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/engine.test.ts`
Expected: FAIL — `Error: Failed to resolve import "../src/sync/engine" from "test/engine.test.ts". Does the file exist?`

- [ ] **Step 4: Implement**

`web/src/sync/engine.ts`:
```ts
import { ApiError } from '../lib/api';

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'error' | 'signed_out';

export interface SyncStatus {
  phase: SyncPhase;
  error: string | null;
  /** When the next automatic retry runs (phase `error`). */
  retryAt: number | null;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ConnectivityEvents {
  addEventListener(type: 'online' | 'offline', listener: () => void): void;
  removeEventListener(type: 'online' | 'offline', listener: () => void): void;
}

export interface SyncEngineOptions {
  /** One full sync pass, normally `() => syncOnce(db, api)`. */
  run: () => Promise<void>;
  isOnline?: () => boolean;
  events?: ConnectivityEvents;
  timers?: Timers;
  now?: () => number;
  /** Called when the server answers 401; pending changes stay in IndexedDB. */
  onAuthExpired?: () => void;
}

export const WRITE_DEBOUNCE_MS = 2_000;
export const SYNC_INTERVAL_MS = 60_000;
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 5 * 60_000;

export const SIGNED_OUT_MESSAGE = 'Signed out. Sign in again to sync; unsynced changes are kept on this device.';

const browserTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Schedules sync passes (spec §5): on start, on reconnect, 2 s after local writes, every 60 s
 * while online; retries failures with exponential backoff; stops on 401 until `resume()`.
 */
export class SyncEngine {
  private status: SyncStatus = { phase: 'idle', error: null, retryAt: null };
  private readonly listeners = new Set<() => void>();
  private readonly timers: Timers;
  private readonly isOnline: () => boolean;
  private readonly events: ConnectivityEvents;
  private readonly now: () => number;
  private running: Promise<void> | null = null;
  private rerun = false;
  private failures = 0;
  private debounceHandle: unknown = null;
  private retryHandle: unknown = null;
  private intervalHandle: unknown = null;
  private started = false;

  constructor(private readonly options: SyncEngineOptions) {
    this.timers = options.timers ?? browserTimers;
    this.isOnline = options.isOnline ?? (() => navigator.onLine);
    this.events = options.events ?? window;
    this.now = options.now ?? Date.now;
  }

  getStatus = (): SyncStatus => this.status;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  start(): void {
    if (this.started) return;
    this.started = true;
    this.events.addEventListener('online', this.handleOnline);
    this.events.addEventListener('offline', this.handleOffline);
    this.intervalHandle = this.timers.setInterval(() => {
      if (this.status.phase !== 'error') void this.syncNow();
    }, SYNC_INTERVAL_MS);
    void this.syncNow();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.events.removeEventListener('online', this.handleOnline);
    this.events.removeEventListener('offline', this.handleOffline);
    this.timers.clearInterval(this.intervalHandle);
    this.clearDebounce();
    this.clearRetry();
  }

  /** Call after a local write; syncs once writes pause for 2 s. */
  requestSync = (): void => {
    this.clearDebounce();
    this.debounceHandle = this.timers.setTimeout(() => {
      this.debounceHandle = null;
      void this.syncNow();
    }, WRITE_DEBOUNCE_MS);
  };

  /** Re-enables syncing after the user signs in again (syncs right away if started). */
  resume(): void {
    this.failures = 0;
    this.setStatus({ phase: 'idle', error: null, retryAt: null });
    if (this.started) void this.syncNow();
  }

  syncNow(): Promise<void> {
    if (this.status.phase === 'signed_out') return Promise.resolve();
    if (!this.isOnline()) {
      this.setStatus({ phase: 'offline', error: null, retryAt: null });
      return Promise.resolve();
    }
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.clearRetry();
    this.running = this.loop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async loop(): Promise<void> {
    this.setStatus({ phase: 'syncing', error: null, retryAt: null });
    try {
      do {
        this.rerun = false;
        await this.options.run();
      } while (this.rerun);
      this.failures = 0;
      this.setStatus({ phase: 'idle', error: null, retryAt: null });
    } catch (error) {
      this.handleFailure(error);
    }
  }

  private handleFailure(error: unknown): void {
    if (error instanceof ApiError && error.status === 401) {
      this.setStatus({ phase: 'signed_out', error: SIGNED_OUT_MESSAGE, retryAt: null });
      this.options.onAuthExpired?.();
      return;
    }
    if (!this.isOnline()) {
      this.setStatus({ phase: 'offline', error: null, retryAt: null });
      return;
    }
    this.failures++;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (this.failures - 1), RETRY_MAX_MS);
    this.retryHandle = this.timers.setTimeout(() => {
      this.retryHandle = null;
      void this.syncNow();
    }, delay);
    this.setStatus({
      phase: 'error',
      error: error instanceof Error ? error.message : String(error),
      retryAt: this.now() + delay,
    });
  }

  private readonly handleOnline = (): void => {
    void this.syncNow();
  };

  private readonly handleOffline = (): void => {
    if (this.status.phase !== 'signed_out') this.setStatus({ phase: 'offline', error: null, retryAt: null });
  };

  private clearDebounce(): void {
    if (this.debounceHandle !== null) this.timers.clearTimeout(this.debounceHandle);
    this.debounceHandle = null;
  }

  private clearRetry(): void {
    if (this.retryHandle !== null) this.timers.clearTimeout(this.retryHandle);
    this.retryHandle = null;
  }

  private setStatus(status: SyncStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener();
  }
}
```

- [ ] **Step 5: Run the test and typecheck**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/engine.test.ts && pnpm typecheck`
Expected: `Tests  7 passed (7)`, then `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/sync/engine.ts web/test/timers.ts web/test/engine.test.ts
git commit -m "feat(web): sync engine with debounce, interval, reconnect, backoff and 401 stop"
```

---

### Task 8: Web session auth

**Files:**
- Create: `web/src/auth/session.ts`
- Test: `web/test/session.test.ts`

- [ ] **Step 1: Write the failing test**

`web/test/session.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { login, loginErrorMessage, logout, restoreSession } from '../src/auth/session';
import type { CarbBookDb } from '../src/db/db';
import { getMeta, setMeta } from '../src/db/meta';
import { ApiError, NetworkError } from '../src/lib/api';
import { FakeApi, openTestDb } from './helpers';

const brett = { id: 1, username: 'brett', role: 'owner' as const };

let db: CarbBookDb;
afterEach(async () => {
  await db.delete();
});

describe('restoreSession', () => {
  it('signs in from /api/auth/me and caches the user', async () => {
    db = openTestDb();
    const api = new FakeApi().on('GET', '/api/auth/me', () => ({ user: brett }));
    expect(await restoreSession(db, api)).toEqual({ status: 'signed_in', user: brett, offline: false });
    expect(await getMeta(db, 'user')).toEqual(brett);
  });

  it('signs out on 401 and forgets the cached user', async () => {
    db = openTestDb();
    await setMeta(db, 'user', brett);
    const api = new FakeApi().on('GET', '/api/auth/me', () => {
      throw new ApiError(401, 'unauthorized', 'Session expired or revoked');
    });
    expect(await restoreSession(db, api)).toEqual({ status: 'signed_out' });
    expect(await getMeta(db, 'user')).toBeUndefined();
  });

  it('uses the cached user when the server is unreachable', async () => {
    db = openTestDb();
    const api = new FakeApi().on('GET', '/api/auth/me', () => {
      throw new NetworkError('Failed to fetch');
    });
    expect(await restoreSession(db, api)).toEqual({ status: 'signed_out' });
    await setMeta(db, 'user', brett);
    expect(await restoreSession(db, api)).toEqual({ status: 'signed_in', user: brett, offline: true });
  });
});

describe('login and logout', () => {
  it('logs in and caches the user', async () => {
    db = openTestDb();
    const api = new FakeApi().on('POST', '/api/auth/login', () => ({ user: brett }));
    expect(await login(db, api, 'brett', 'pw')).toEqual(brett);
    expect(api.calls[0]!.body).toEqual({ username: 'brett', password: 'pw' });
    expect(await getMeta(db, 'user')).toEqual(brett);
  });

  it('describes login failures', () => {
    expect(loginErrorMessage(new ApiError(401, 'invalid_credentials', 'Wrong username or password'))).toBe('Wrong username or password');
    expect(loginErrorMessage(new ApiError(429, 'rate_limited', 'Too many login attempts, retry in 15 minutes'))).toBe(
      'Too many login attempts, retry in 15 minutes',
    );
    expect(loginErrorMessage(new NetworkError('Failed to fetch'))).toBe("Can't reach the server. Check your connection and try again.");
  });

  it('logs out with a JSON body, and still signs out locally when offline', async () => {
    db = openTestDb();
    await setMeta(db, 'user', brett);
    const api = new FakeApi().on('POST', '/api/auth/logout', () => ({ ok: true }));
    expect(await logout(db, api)).toBe(true);
    expect(api.calls[0]!.body).toEqual({});
    expect(await getMeta(db, 'user')).toBeUndefined();

    await setMeta(db, 'user', brett);
    api.on('POST', '/api/auth/logout', () => {
      throw new NetworkError('Failed to fetch');
    });
    expect(await logout(db, api)).toBe(false);
    expect(await getMeta(db, 'user')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/session.test.ts`
Expected: FAIL — `Error: Failed to resolve import "../src/auth/session" from "test/session.test.ts". Does the file exist?`

- [ ] **Step 3: Implement**

`web/src/auth/session.ts`:
```ts
import type { CarbBookDb } from '../db/db';
import { deleteMeta, getMeta, setMeta } from '../db/meta';
import { type Api, ApiError, NetworkError } from '../lib/api';
import type { User } from '../lib/wire';

export type Session =
  | { status: 'signed_in'; user: User; /** true when the server could not be reached */ offline: boolean }
  | { status: 'signed_out' };

/**
 * Checks the session cookie with `/api/auth/me`. When the server is unreachable the last
 * signed-in user is used so the app works offline; a 401 signs out (local data is kept).
 */
export async function restoreSession(db: CarbBookDb, api: Api): Promise<Session> {
  try {
    const { user } = await api.get<{ user: User }>('/api/auth/me');
    await setMeta(db, 'user', user);
    return { status: 'signed_in', user, offline: false };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      await deleteMeta(db, 'user');
      return { status: 'signed_out' };
    }
    const cached = await getMeta(db, 'user');
    return cached ? { status: 'signed_in', user: cached, offline: true } : { status: 'signed_out' };
  }
}

export async function login(db: CarbBookDb, api: Api, username: string, password: string): Promise<User> {
  const { user } = await api.post<{ user: User }>('/api/auth/login', { username, password });
  await setMeta(db, 'user', user);
  return user;
}

/** Signs out locally even if the server is unreachable; returns whether the server session was revoked. */
export async function logout(db: CarbBookDb, api: Api): Promise<boolean> {
  let revoked = true;
  try {
    // Body `{}`: cookie-authenticated POSTs must be application/json (415 otherwise).
    await api.post('/api/auth/logout', {});
  } catch (error) {
    if (!(error instanceof NetworkError || (error instanceof ApiError && error.status === 401))) throw error;
    revoked = error instanceof ApiError;
  }
  await deleteMeta(db, 'user');
  return revoked;
}

export function loginErrorMessage(error: unknown): string {
  if (error instanceof NetworkError) return "Can't reach the server. Check your connection and try again.";
  if (error instanceof ApiError) {
    if (error.code === 'invalid_credentials') return 'Wrong username or password';
    return error.message;
  }
  return 'Sign-in failed';
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/session.test.ts`
Expected: `Tests  6 passed (6)`

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/auth/session.ts web/test/session.test.ts
git commit -m "feat(web): cookie session restore, login and logout with offline fallback"
```

---

### Task 9: USDA library download

**Files:**
- Create: `web/src/usda/bundle.ts`
- Test: `web/test/usda-bundle.test.ts`

- [ ] **Step 1: Write the failing test**

`web/test/usda-bundle.test.ts`:
```ts
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { CarbBookDb } from '../src/db/db';
import { getMeta } from '../src/db/meta';
import { ApiError } from '../src/lib/api';
import type { UsdaJsonBundle, UsdaManifest } from '../src/lib/wire';
import { CHECKSUM_MESSAGE, syncUsdaLibrary } from '../src/usda/bundle';
import { FakeApi, openTestDb } from './helpers';

const PB_AND_KALE: UsdaJsonBundle = {
  format: 1,
  foods: [
    [324860, 'Peanut butter, smooth style, with salt', 22.3, 4.8],
    [323505, 'Kale, raw', 4.42, 4.1],
  ],
  portions: [[119207, 324860, 'tbsp', 'volume', 2, 32, 'tablespoon']],
};

function serve(api: FakeApi, bundle: UsdaJsonBundle, version: string, sha?: string): UsdaManifest {
  const gz = gzipSync(JSON.stringify(bundle));
  const bytes = gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength);
  const manifest: UsdaManifest = {
    version,
    created_at: 1,
    food_count: bundle.foods.length,
    portion_count: bundle.portions.length,
    json_file: `usda-${version}.json.gz`,
    json_sha256: sha ?? createHash('sha256').update(gz).digest('hex'),
    json_url: `/api/usda/files/usda-${version}.json.gz`,
    sqlite_file: `usda-${version}.sqlite`,
    sqlite_sha256: 'not-used-by-web',
    sqlite_url: `/api/usda/files/usda-${version}.sqlite`,
  };
  api.on('GET', '/api/usda/manifest', () => manifest).on('GET', manifest.json_url, () => bytes);
  return manifest;
}

let db: CarbBookDb;
afterEach(async () => {
  await db.delete();
});

describe('syncUsdaLibrary', () => {
  it('downloads, verifies and stores the library', async () => {
    db = openTestDb();
    const api = new FakeApi();
    serve(api, PB_AND_KALE, 'fdc-aaaaaaaaaaaa');
    expect(await syncUsdaLibrary(db, api)).toEqual({ status: 'updated', version: 'fdc-aaaaaaaaaaaa', food_count: 2 });
    expect(await db.usda_food.get(323505)).toEqual({ fdc_id: 323505, name: 'Kale, raw', carbs_per_100g: 4.42, fiber_per_100g: 4.1 });
    expect(await db.usda_portion.get(119207)).toEqual({
      id: 119207, fdc_id: 324860, label: 'tbsp', kind: 'volume', quantity: 2, grams: 32, description: 'tablespoon',
    });
    expect(await getMeta(db, 'usda_version')).toBe('fdc-aaaaaaaaaaaa');
  });

  it('skips the download when the version is unchanged', async () => {
    db = openTestDb();
    const api = new FakeApi();
    const manifest = serve(api, PB_AND_KALE, 'fdc-aaaaaaaaaaaa');
    await syncUsdaLibrary(db, api);
    expect(await syncUsdaLibrary(db, api)).toEqual({ status: 'up_to_date', version: 'fdc-aaaaaaaaaaaa', food_count: 2 });
    expect(api.calls.filter((c) => c.path === manifest.json_url)).toHaveLength(1);
  });

  it('replaces the library when the version changes', async () => {
    db = openTestDb();
    const api = new FakeApi();
    serve(api, PB_AND_KALE, 'fdc-aaaaaaaaaaaa');
    await syncUsdaLibrary(db, api);
    serve(api, { format: 1, foods: [[323505, 'Kale, raw', 4.42, 4.1]], portions: [] }, 'fdc-bbbbbbbbbbbb');
    expect(await syncUsdaLibrary(db, api)).toMatchObject({ status: 'updated', version: 'fdc-bbbbbbbbbbbb' });
    expect(await db.usda_food.get(324860)).toBeUndefined();
    expect(await db.usda_portion.count()).toBe(0);
  });

  it('rejects a corrupted download and keeps the current library', async () => {
    db = openTestDb();
    const api = new FakeApi();
    serve(api, PB_AND_KALE, 'fdc-aaaaaaaaaaaa');
    await syncUsdaLibrary(db, api);
    serve(api, { format: 1, foods: [], portions: [] }, 'fdc-cccccccccccc', '0'.repeat(64));
    await expect(syncUsdaLibrary(db, api)).rejects.toThrow(CHECKSUM_MESSAGE);
    expect(await db.usda_food.count()).toBe(2);
    expect(await getMeta(db, 'usda_version')).toBe('fdc-aaaaaaaaaaaa');
  });

  it('reports when the server has no library yet', async () => {
    db = openTestDb();
    const api = new FakeApi().on('GET', '/api/usda/manifest', () => {
      throw new ApiError(404, 'usda_not_imported', 'Run `carbbook import-usda` on the server first');
    });
    expect(await syncUsdaLibrary(db, api)).toEqual({ status: 'not_imported' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/usda-bundle.test.ts`
Expected: FAIL — `Error: Failed to resolve import "../src/usda/bundle" from "test/usda-bundle.test.ts". Does the file exist?`

- [ ] **Step 3: Implement**

`web/src/usda/bundle.ts`:
```ts
import type { PortionKind } from '@carbbook/core';
import type { CarbBookDb } from '../db/db';
import { getMeta, setMeta } from '../db/meta';
import { type Api, ApiError } from '../lib/api';
import type { UsdaJsonBundle, UsdaManifest } from '../lib/wire';

export type UsdaSyncResult =
  | { status: 'up_to_date' | 'updated'; version: string; food_count: number }
  | { status: 'not_imported' };

export interface BundleCodec {
  sha256Hex(bytes: ArrayBuffer): Promise<string>;
  gunzipText(bytes: ArrayBuffer): Promise<string>;
}

export const browserCodec: BundleCodec = {
  async sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  },
  async gunzipText(bytes) {
    const body = new Response(bytes).body;
    if (!body) throw new Error('USDA library download was empty');
    return new Response(body.pipeThrough(new DecompressionStream('gzip'))).text();
  },
};

export const CHECKSUM_MESSAGE = 'USDA library download was corrupted (checksum mismatch). Try again.';

/**
 * Downloads the versioned USDA bundle (spec §5/§6) when the server has a version this browser
 * does not; verifies its sha256, then replaces the local library in one transaction.
 */
export async function syncUsdaLibrary(db: CarbBookDb, api: Api, codec: BundleCodec = browserCodec): Promise<UsdaSyncResult> {
  let manifest: UsdaManifest;
  try {
    manifest = await api.get<UsdaManifest>('/api/usda/manifest');
  } catch (error) {
    if (error instanceof ApiError && error.code === 'usda_not_imported') return { status: 'not_imported' };
    throw error;
  }
  const current = await getMeta(db, 'usda_version');
  if (current === manifest.version && (await db.usda_food.count()) > 0) {
    return { status: 'up_to_date', version: manifest.version, food_count: manifest.food_count };
  }

  const bytes = await api.getBytes(manifest.json_url);
  if ((await codec.sha256Hex(bytes)) !== manifest.json_sha256) throw new Error(CHECKSUM_MESSAGE);
  const bundle = JSON.parse(await codec.gunzipText(bytes)) as UsdaJsonBundle;
  if (bundle.format !== 1) throw new Error(`Unsupported USDA bundle format ${String(bundle.format)}`);

  await db.transaction('rw', [db.usda_food, db.usda_portion, db.meta], async () => {
    await db.usda_food.clear();
    await db.usda_portion.clear();
    await db.usda_food.bulkPut(
      bundle.foods.map(([fdc_id, name, carbs_per_100g, fiber_per_100g]) => ({ fdc_id, name, carbs_per_100g, fiber_per_100g })),
    );
    await db.usda_portion.bulkPut(
      bundle.portions.map(([id, fdc_id, label, kind, quantity, grams, description]) => ({
        id,
        fdc_id,
        label,
        kind: kind as PortionKind,
        quantity,
        grams,
        description,
      })),
    );
    await setMeta(db, 'usda_version', manifest.version);
  });
  return { status: 'updated', version: manifest.version, food_count: bundle.foods.length };
}
```

- [ ] **Step 4: Run the test and typecheck**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/usda-bundle.test.ts && pnpm typecheck`
Expected: `Tests  5 passed (5)`, then `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/usda/bundle.ts web/test/usda-bundle.test.ts
git commit -m "feat(web): verified USDA bundle download into IndexedDB"
```

---

### Task 10: Local search ranking

**Files:**
- Create: `web/src/search/search.ts`
- Test: `web/test/search.test.ts`

- [ ] **Step 1: Write the failing test**

`web/test/search.test.ts`:
```ts
import type { LogEntryData, LogItemData } from '@carbbook/core';
import { describe, expect, it } from 'vitest';
import { buildSearchIndex, lastLoggedByRef, tokenize } from '../src/search/search';
import { foodData, mealData, synced } from './helpers';

const entry = (id: string, eatenAt: number, deleted: 0 | 1 = 0) =>
  synced<LogEntryData>(
    { id, eaten_at: eatenAt, window_name: 'Lunch', bg_mgdl: null, bg_source: 'none', total_carbs_g: 20, suggested_units: null, taken_units: null, settings_version_id: null },
    { deleted },
  );
const item = (id: string, entryId: string, refId: string) =>
  synced<LogItemData>({ id, log_entry_id: entryId, ref_type: 'food', ref_id: refId, display_name: 'x', amount: 1, unit: 'g', carbs_g: 1 });

function index() {
  return buildSearchIndex({
    foods: [
      synced(foodData({ id: 'off-old', name: 'Peanut butter crunchy', source: 'off', brand: 'Jif' })),
      synced(foodData({ id: 'off-recent', name: 'Peanut butter cups', source: 'off', brand: "Reese's" })),
      synced(foodData({ id: 'custom-pb', name: 'Peanut butter cookies', source: 'custom' })),
      synced(foodData({ id: 'gone', name: 'Peanut brittle', source: 'custom' }), { deleted: 1 }),
      synced(foodData({ id: 'creme', name: 'Crème fraîche', source: 'custom' })),
    ],
    meals: [synced(mealData({ id: 'meal-pb', name: 'PB toast with peanut butter' }))],
    usdaFoods: [
      { fdc_id: 324860, name: 'Peanut butter, smooth style, with salt', carbs_per_100g: 22.3, fiber_per_100g: 4.8 },
      { fdc_id: 2706093, name: 'Chicken nuggets, from fast food', carbs_per_100g: 14.93, fiber_per_100g: 0.9 },
    ],
    lastLogged: lastLoggedByRef([entry('e1', 5000)], [item('i1', 'e1', 'off-recent')]),
  });
}

describe('tokenize', () => {
  it('lower-cases, strips accents and punctuation', () => {
    expect(tokenize('Crème  Fraîche, 2%')).toEqual(['creme', 'fraiche', '2']);
    expect(tokenize('  !! ')).toEqual([]);
  });
});

describe('local search', () => {
  it('ranks meals and custom foods, then recently logged saved foods, then other saved foods, then USDA', () => {
    const hits = index().search('peanut butter');
    expect(hits.map((h) => h.id)).toEqual(['custom-pb', 'meal-pb', 'off-recent', 'off-old', 'usda-324860']);
    expect(hits[4]).toEqual({ kind: 'usda', id: 'usda-324860', name: 'Peanut butter, smooth style, with salt', brand: null, source: 'usda', carbs_per_100g: 22.3 });
    expect(hits.find((h) => h.id === 'off-old')).toMatchObject({ kind: 'food', brand: 'Jif', source: 'off' });
  });

  it('excludes deleted records, matches prefixes and brands, ignores accents', () => {
    const search = index();
    expect(search.search('brittle')).toEqual([]);
    expect(search.search('creme fra').map((h) => h.id)).toEqual(['creme']);
    expect(search.search('nugg').map((h) => h.id)).toEqual(['usda-2706093']);
    expect(search.search('jif').map((h) => h.id)).toEqual(['off-old']);
    expect(search.search('peanut', 3)).toHaveLength(3);
  });

  it('shows a saved USDA copy once, as a saved food', () => {
    const search = buildSearchIndex({
      foods: [synced(foodData({ id: 'usda-324860', name: 'Peanut butter, smooth style, with salt', source: 'usda', source_ref: '324860' }))],
      meals: [],
      usdaFoods: [{ fdc_id: 324860, name: 'Peanut butter, smooth style, with salt', carbs_per_100g: 22.3, fiber_per_100g: 4.8 }],
      lastLogged: new Map(),
    });
    expect(search.search('peanut')).toEqual([expect.objectContaining({ id: 'usda-324860', kind: 'food' })]);
  });

  it('lists recently logged items newest first, ignoring deleted log rows', () => {
    const lastLogged = lastLoggedByRef(
      [entry('e1', 1000), entry('e2', 3000), entry('e3', 9000, 1)],
      [item('i1', 'e1', 'creme'), item('i2', 'e2', 'meal-pb'), item('i3', 'e3', 'off-old')],
    );
    expect([...lastLogged.entries()]).toEqual([['creme', 1000], ['meal-pb', 3000]]);
    const search = buildSearchIndex({
      foods: [synced(foodData({ id: 'creme', name: 'Crème fraîche' }))],
      meals: [synced(mealData({ id: 'meal-pb', name: 'PB toast' }))],
      usdaFoods: [],
      lastLogged,
    });
    expect(search.recent().map((h) => h.id)).toEqual(['meal-pb', 'creme']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/search.test.ts`
Expected: FAIL — `Error: Failed to resolve import "../src/search/search" from "test/search.test.ts". Does the file exist?`

- [ ] **Step 3: Implement**

`web/src/search/search.ts`:
```ts
import type { FoodData, FoodSource, LogEntryData, LogItemData, MealData, Synced } from '@carbbook/core';
import type { UsdaFoodRow } from '../db/db';
import { usdaFoodId } from '../lib/ids';

export interface SearchResult {
  kind: 'meal' | 'food' | 'usda';
  /** meal/food id; USDA library entries use the deterministic saved-food id `usda-<fdc_id>`. */
  id: string;
  name: string;
  brand: string | null;
  source: FoodSource | null;
  carbs_per_100g: number | null;
}

export interface SearchInput {
  foods: Synced<FoodData>[];
  meals: Synced<MealData>[];
  usdaFoods: UsdaFoodRow[];
  /** ref_id → most recent eaten_at, from `lastLoggedByRef`. */
  lastLogged: Map<string, number>;
}

export interface SearchIndex {
  search(query: string, limit?: number): SearchResult[];
  /** Recently logged meals and foods, newest first (shown before typing). */
  recent(limit?: number): SearchResult[];
}

/** Lower-case, accents removed, split on anything that is not a letter or digit. */
export function tokenize(text: string): string[] {
  return (
    text
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

export function lastLoggedByRef(entries: Synced<LogEntryData>[], items: Synced<LogItemData>[]): Map<string, number> {
  const eatenAt = new Map(entries.filter((e) => e.deleted === 0).map((e) => [e.id, e.eaten_at]));
  const last = new Map<string, number>();
  for (const item of items) {
    if (item.deleted !== 0) continue;
    const at = eatenAt.get(item.log_entry_id);
    if (at !== undefined && at > (last.get(item.ref_id) ?? -Infinity)) last.set(item.ref_id, at);
  }
  return last;
}

interface Entry {
  result: SearchResult;
  tokens: string[];
  /** 0 meals + custom foods, 1 other saved foods, 2 USDA library (spec §6). */
  tier: 0 | 1 | 2;
  lastLogged: number | null;
}

/**
 * Local search index. Every query word must prefix-match a word of the name (or brand).
 * Order: tier, then most recently logged, then more exact word matches, then shorter names.
 */
export function buildSearchIndex(input: SearchInput): SearchIndex {
  const entries: Entry[] = [];
  const savedIds = new Set<string>();
  for (const meal of input.meals) {
    if (meal.deleted !== 0) continue;
    entries.push({
      result: { kind: 'meal', id: meal.id, name: meal.name, brand: null, source: null, carbs_per_100g: null },
      tokens: tokenize(meal.name),
      tier: 0,
      lastLogged: input.lastLogged.get(meal.id) ?? null,
    });
  }
  for (const food of input.foods) {
    if (food.deleted !== 0) continue;
    savedIds.add(food.id);
    const source = food.source ?? 'custom';
    entries.push({
      result: { kind: 'food', id: food.id, name: food.name, brand: food.brand ?? null, source, carbs_per_100g: food.carbs_per_100g },
      tokens: tokenize(`${food.name} ${food.brand ?? ''}`),
      tier: source === 'custom' ? 0 : 1,
      lastLogged: input.lastLogged.get(food.id) ?? null,
    });
  }
  for (const usda of input.usdaFoods) {
    const id = usdaFoodId(usda.fdc_id);
    if (savedIds.has(id)) continue;
    entries.push({
      result: { kind: 'usda', id, name: usda.name, brand: null, source: 'usda', carbs_per_100g: usda.carbs_per_100g },
      tokens: tokenize(usda.name),
      tier: 2,
      lastLogged: null,
    });
  }

  return {
    search(query, limit = 20) {
      const terms = tokenize(query).slice(0, 8);
      if (terms.length === 0) return [];
      const exact = (entry: Entry) => terms.filter((t) => entry.tokens.includes(t)).length;
      return entries
        .filter((entry) => terms.every((term) => entry.tokens.some((token) => token.startsWith(term))))
        .sort(
          (a, b) =>
            a.tier - b.tier ||
            (b.lastLogged ?? -Infinity) - (a.lastLogged ?? -Infinity) ||
            exact(b) - exact(a) ||
            a.result.name.length - b.result.name.length ||
            a.result.name.localeCompare(b.result.name),
        )
        .slice(0, limit)
        .map((entry) => entry.result);
    },
    recent(limit = 8) {
      return entries
        .filter((entry) => entry.lastLogged !== null)
        .sort((a, b) => b.lastLogged! - a.lastLogged!)
        .slice(0, limit)
        .map((entry) => entry.result);
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/search.test.ts`
Expected: `Tests  5 passed (5)`

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/search/search.ts web/test/search.test.ts
git commit -m "feat(web): local search with meals/custom, recents, USDA ranking"
```

---

### Task 11: BG fetch and prefill rule

**Files:**
- Create: `web/src/bg/bg.ts`
- Test: `web/test/bg.test.ts`

- [ ] **Step 1: Write the failing test**

`web/test/bg.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { bgPrefill, fetchBg } from '../src/bg/bg';
import { ApiError, NetworkError } from '../src/lib/api';
import type { BgReading } from '../src/lib/wire';
import { FakeApi } from './helpers';

const MIN = 60_000;
const reading = (fields: Partial<BgReading> = {}): BgReading => ({
  mgdl: 263, trend: 'FortyFiveUp', arrow: '↗', delta_mgdl: 6, read_at: 0, age_ms: 5 * MIN, fresh: true, ...fields,
});

describe('BG', () => {
  it('prefills a fresh reading and keeps ageing it after the fetch', async () => {
    const api = new FakeApi().on('GET', '/api/bg', () => reading());
    const result = await fetchBg(api, () => 1000);
    expect(result).toEqual({ kind: 'reading', reading: reading(), fetched_at: 1000 });
    expect(bgPrefill(result, 1000 + MIN)).toEqual({ mgdl: 263, trend: 'FortyFiveUp', arrow: '↗', age_ms: 6 * MIN });
    expect(bgPrefill(result, 1000 + 10 * MIN)).toEqual(expect.objectContaining({ age_ms: 15 * MIN }));
    expect(bgPrefill(result, 1000 + 10 * MIN + 1)).toBeNull();
  });

  it('never prefills a reading the server marks stale', async () => {
    const api = new FakeApi().on('GET', '/api/bg', () => reading({ age_ms: 0, fresh: false }));
    expect(bgPrefill(await fetchBg(api, () => 0), 0)).toBeNull();
  });

  it('reports an unavailable dexcom-api and offline separately', async () => {
    const down = new FakeApi().on('GET', '/api/bg', () => {
      throw new ApiError(503, 'bg_unavailable', 'dexcom-api responded 500');
    });
    expect(await fetchBg(down)).toEqual({ kind: 'unavailable', message: 'dexcom-api responded 500' });
    const offline = new FakeApi().on('GET', '/api/bg', () => {
      throw new NetworkError('Failed to fetch');
    });
    const result = await fetchBg(offline);
    expect(result).toEqual({ kind: 'offline' });
    expect(bgPrefill(result, 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/bg.test.ts`
Expected: FAIL — `Error: Failed to resolve import "../src/bg/bg" from "test/bg.test.ts". Does the file exist?`

- [ ] **Step 3: Implement**

`web/src/bg/bg.ts`:
```ts
import { type Api, ApiError, NetworkError } from '../lib/api';
import type { BgReading } from '../lib/wire';

/** Prefill BG only when the reading is at most this old (spec §4.4). */
export const BG_FRESH_MS = 15 * 60 * 1000;

export type BgResult =
  | { kind: 'reading'; reading: BgReading; fetched_at: number }
  | { kind: 'unavailable'; message: string }
  | { kind: 'offline' };

export interface BgPrefill {
  mgdl: number;
  trend: string | null;
  arrow: string | null;
  age_ms: number;
}

export async function fetchBg(api: Api, now: () => number = Date.now): Promise<BgResult> {
  try {
    const reading = await api.get<BgReading>('/api/bg');
    return { kind: 'reading', reading, fetched_at: now() };
  } catch (error) {
    if (error instanceof NetworkError) return { kind: 'offline' };
    if (error instanceof ApiError && error.status === 401) return { kind: 'unavailable', message: 'Sign in again to load BG' };
    return { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The reading to prefill, or null when the user must enter BG by hand. The server's `fresh`
 * flag is authoritative (it also marks readings more than 2 minutes in the future as stale);
 * the age keeps growing while the screen stays open.
 */
export function bgPrefill(result: BgResult, now: number): BgPrefill | null {
  if (result.kind !== 'reading' || !result.reading.fresh) return null;
  const ageMs = result.reading.age_ms + Math.max(0, now - result.fetched_at);
  if (ageMs > BG_FRESH_MS) return null;
  return { mgdl: result.reading.mgdl, trend: result.reading.trend, arrow: result.reading.arrow, age_ms: ageMs };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/bg.test.ts`
Expected: `Tests  3 passed (3)`

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/bg/bg.ts web/test/bg.test.ts
git commit -m "feat(web): BG fetch with 15-minute prefill rule"
```

---

### Task 12: Barcode resolution and data-layer verification

**Files:**
- Create: `web/src/barcode/resolve.ts`
- Test: `web/test/barcode-resolve.test.ts`

- [ ] **Step 1: Write the failing test**

`web/test/barcode-resolve.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { barcodeCandidates, resolveBarcode } from '../src/barcode/resolve';
import type { CarbBookDb } from '../src/db/db';
import { NetworkError } from '../src/lib/api';
import { FakeApi, foodData, openTestDb, portionData, synced } from './helpers';

const noServer = () => new FakeApi();

let db: CarbBookDb | undefined;
afterEach(async () => {
  await db?.delete();
  db = undefined;
});

describe('barcodeCandidates', () => {
  it('matches UPC-A and EAN-13 spellings', () => {
    expect(barcodeCandidates('737628064502')).toEqual(['737628064502', '0737628064502']);
    expect(barcodeCandidates('0737628064502')).toEqual(['0737628064502', '737628064502']);
  });
});

describe('resolveBarcode', () => {
  it('finds a saved barcode locally without calling the server', async () => {
    db = openTestDb();
    await db.food.put(synced(foodData({ id: 'f1', name: 'Noodle kit' })));
    await db.barcode.bulkPut([
      synced({ id: 'b0', code: '737628064502', food_id: 'f1' }, { deleted: 1 }),
      synced({ id: 'b1', code: '0737628064502', food_id: 'f1' }),
    ]);
    const api = noServer();
    expect(await resolveBarcode(db, api, '737628064502')).toMatchObject({ kind: 'local', food: { id: 'f1' } });
    expect(api.calls).toEqual([]);
  });

  it('saves a food the server already knows', async () => {
    db = openTestDb();
    const food = synced(foodData({ id: 'f9', name: 'Noodle kit', source: 'off' }), { server_seq: 12 });
    const portion = synced(portionData({ id: 'p9', food_id: 'f9', label: 'label serving', kind: 'serving', grams: 52 }), { server_seq: 13 });
    const api = new FakeApi().on('GET', '/api/barcode/0737628064502', () => ({ status: 'known', food, portions: [portion] }));
    expect(await resolveBarcode(db, api, '0737628064502')).toEqual({ kind: 'known', food, portions: [portion] });
    expect(await db.food.get('f9')).toEqual(food);
    expect(await db.portion.get('p9')).toEqual(portion);
  });

  it('returns Open Food Facts drafts', async () => {
    db = openTestDb();
    const draft = {
      food: { name: 'Noodle kit', brand: 'Thai Kitchen', source: 'off', source_ref: '0737628064502', carbs_per_100g: 71.15, fiber_per_100g: null },
      portions: [{ label: 'label serving', kind: 'serving', quantity: 1, grams: 52 }],
      barcode: '0737628064502',
      serving_size: null,
    };
    const api = new FakeApi().on('GET', '/api/barcode/737628064502', () => ({ status: 'draft', draft }));
    expect(await resolveBarcode(db, api, '737628064502')).toEqual({ kind: 'draft', draft });
  });

  it('falls back to manual entry when the product is unknown or OFF is down', async () => {
    db = openTestDb();
    const api = new FakeApi().on('GET', '/api/barcode/3017624010070', () => ({ status: 'not_found', code: '3017624010070' }));
    expect(await resolveBarcode(db, api, '3017624010070')).toEqual({
      kind: 'manual',
      code: '3017624010070',
      message: 'No product found for barcode 3017624010070. Enter the food from its label.',
    });
    api.on('GET', '/api/barcode/3017624010070', () => ({ status: 'unavailable', code: '3017624010070', message: 'Open Food Facts responded 503' }));
    expect(await resolveBarcode(db, api, '3017624010070')).toEqual({
      kind: 'manual',
      code: '3017624010070',
      message: 'Open Food Facts is unavailable (Open Food Facts responded 503). Enter the food from its label.',
    });
  });

  it('queues unknown codes while offline and clears them once resolved', async () => {
    db = openTestDb();
    const api = new FakeApi().on('GET', '/api/barcode/3017624010070', () => {
      throw new NetworkError('Failed to fetch');
    });
    expect(await resolveBarcode(db, api, '3017624010070', () => 42)).toEqual({ kind: 'queued', code: '3017624010070' });
    expect(await db.pending_barcode.toArray()).toEqual([{ code: '3017624010070', created_at: 42 }]);
    api.on('GET', '/api/barcode/3017624010070', () => ({ status: 'not_found', code: '3017624010070' }));
    await resolveBarcode(db, api, '3017624010070');
    expect(await db.pending_barcode.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/barcode-resolve.test.ts`
Expected: FAIL — `Error: Failed to resolve import "../src/barcode/resolve" from "test/barcode-resolve.test.ts". Does the file exist?`

- [ ] **Step 3: Implement**

`web/src/barcode/resolve.ts`:
```ts
import { type FoodData, isNewer, type PortionData, type Synced } from '@carbbook/core';
import type { Table } from 'dexie';
import type { AnySyncRecord, CarbBookDb } from '../db/db';
import { type Api, NetworkError } from '../lib/api';
import type { BarcodeResponse, FoodDraft } from '../lib/wire';

export type BarcodeResolution =
  | { kind: 'local'; food: Synced<FoodData> }
  | { kind: 'known'; food: Synced<FoodData>; portions: Synced<PortionData>[] }
  | { kind: 'draft'; draft: FoodDraft }
  /** Open Food Facts had nothing or failed: enter the food by hand, prefilled with the code. */
  | { kind: 'manual'; code: string; message: string }
  /** Offline and not known locally: kept to look up later (spec §6). */
  | { kind: 'queued'; code: string };

/** UPC-A/EAN-13 spellings, matching the server: "737628064502" ⇄ "0737628064502". */
export function barcodeCandidates(code: string): string[] {
  const stripped = code.replace(/^0+/, '') || '0';
  return [...new Set([code, stripped, stripped.padStart(12, '0'), stripped.padStart(13, '0')])];
}

async function putIfNewer<T extends AnySyncRecord>(table: Table<T, string>, record: T): Promise<void> {
  const local = await table.get(record.id);
  if (!local || isNewer(record, local)) await table.put(record);
}

export async function resolveBarcode(
  db: CarbBookDb,
  api: Api,
  code: string,
  now: () => number = Date.now,
): Promise<BarcodeResolution> {
  const rows = await db.barcode.where('code').anyOf(barcodeCandidates(code)).toArray();
  for (const row of rows.filter((r) => r.deleted === 0).sort((a, b) => b.updated_at - a.updated_at)) {
    const food = await db.food.get(row.food_id);
    if (food && food.deleted === 0) {
      await db.pending_barcode.delete(code);
      return { kind: 'local', food };
    }
  }

  let response: BarcodeResponse;
  try {
    response = await api.get<BarcodeResponse>(`/api/barcode/${encodeURIComponent(code)}`);
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
    await db.pending_barcode.put({ code, created_at: now() });
    return { kind: 'queued', code };
  }
  await db.pending_barcode.delete(code);

  switch (response.status) {
    case 'known':
      await db.transaction('rw', [db.food, db.portion], async () => {
        await putIfNewer(db.food, response.food);
        for (const portion of response.portions) await putIfNewer(db.portion, portion);
      });
      return { kind: 'known', food: response.food, portions: response.portions };
    case 'draft':
      return { kind: 'draft', draft: response.draft };
    case 'not_found':
      return { kind: 'manual', code, message: `No product found for barcode ${code}. Enter the food from its label.` };
    case 'unavailable':
      return {
        kind: 'manual',
        code,
        message: `Open Food Facts is unavailable (${response.message}). Enter the food from its label.`,
      };
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/barcode-resolve.test.ts`
Expected: `Tests  6 passed (6)`

- [ ] **Step 5: Full web suite, typecheck, workspace**

Run: `cd ~/Projects/CarbBook/web && pnpm test && pnpm typecheck && cd .. && pnpm test && pnpm typecheck`
Expected: web reports `Test Files  13 passed (13)` and `Tests  64 passed (64)`; `tsc` exits 0; the workspace run shows core, server and web all passing with no type errors.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/barcode/resolve.ts web/test/barcode-resolve.test.ts
git commit -m "feat(web): barcode resolution (local, server, offline queue)"
```

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| §5 local store, per-record sync metadata, soft deletes | 3 |
| §5 push changed records, per-record accepted/ignored/rejected | 5 |
| §5 pull `since` paged until drained, soft deletes applied | 6 |
| §5 order push then pull | 6 (`syncOnce`) |
| §5 triggers: launch, reconnect, 2 s after writes, every 60 s | 7 |
| §5 pending changes survive restarts (IndexedDB outbox) | 3, 5 |
| §5 "last synced" and pending count (data) | 6 (`last_synced_at`), 3 (`outbox`) — shown in UI plan Task 9 |
| §5 LWW via core `isNewer`, pending local edits kept when newer | 6 |
| §5/§6 USDA versioned bundle downloaded once and on version change | 9 |
| §6 local search ranking (meals/custom, recents, USDA) | 10 |
| Decision: USDA food copied into `food` + portions when used | 4 (`saveUsdaFood`, `saveUsdaFoodsFor`) |
| §4.4 BG prefill ≤ 15 min, else/offline manual | 11 |
| §6 barcode: local first, server draft, offline queue | 12 |
| §7 web session cookie auth, re-login keeps pending changes | 8, 7 (401 stop) |
| §9 sync retry with backoff; auth expiry; per-record rejections recorded | 7, 5 |
| §9 OFF failure → manual entry prefilled with code | 12 (`manual` result) |
| Core math never re-implemented (itemCarbs, isNewer, createCatalog) | 4, 6 |
| Screens, camera scanning, PWA, e2e | `2026-09-14-carbbook-web-ui.md` |
