# Food and Meal Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give any food or meal one optional image, chosen from free no-key provider searches, an Open Food Facts product photo, or the user's own camera roll, with bytes stored server-side and cached on every client.

**Architecture:** A new synced `image` table carries metadata only (hash, mime, dimensions, licence, attribution); `food.image_id` and `meal.image_id` reference it. Bytes live in a content-addressed store at `/data/images/<ab>/<hash>.jpg`, normalised to <=800px JPEG by `sharp`, and are served by a hash-validated stream route modelled on the existing USDA bundle route. Search fans out to Openverse, Wikimedia Commons and TheMealDB through a one-function provider interface injected via `deps`, exactly like the existing OFF and BG clients. Adoption downloads only from provider-owned hosts behind an SSRF guard.

**Tech Stack:** TypeScript on Node 22, Fastify 5, better-sqlite3, vitest 5, `sharp` (new), Dexie 4 in the web PWA, Swift 6 + GRDB on iOS.

**Spec:** `docs/superpowers/specs/2026-09-18-food-images-design.md`

**Branch:** `feat/food-images` (already created; the spec commit `a3863d8` is its first commit)

---

## Deviation from the spec, recorded up front

The spec's testing section says `ImageData` validation goes "via the existing shared JSON vectors in `testdata/`". That is wrong and this plan does not do it. Those vectors exist so the TS and Swift **dose and carb maths** agree; images have no maths and core gains only type declarations. Validation lives in one place — `server/src/sync/tables.ts` — and is tested in `server/test/`. No new vector files.

Everything else follows the spec as written.

## File structure

**Create — core**
- `packages/core/src/images.ts` — `ImageData`, `ImageSource`, `IMAGE_*` limits. Types and constants only, no logic.

**Create — server**
- `server/migrations/006_images.sql` — `image` table, `food.image_id`, `meal.image_id`, indexes.
- `server/src/images/store.ts` — normalise, hash, write, resolve path, read. The only module that touches image bytes on disk.
- `server/src/images/sniff.ts` — magic-byte image type detection. Standalone so it can be tested without the filesystem.
- `server/src/images/urlguard.ts` — the SSRF boundary: protocol, host allowlist, port, credentials, DNS address-range checks.
- `server/src/images/providers/types.ts` — `ImageCandidate`, `ImageSearchProvider`.
- `server/src/images/providers/openverse.ts`
- `server/src/images/providers/wikimedia.ts`
- `server/src/images/providers/themealdb.ts`
- `server/src/images/search.ts` — fan-out, dedup, `providers_failed`.
- `server/src/routes/images.ts` — `GET /api/images/:hash`, `GET /api/images/search`, `POST /api/images/adopt`, `POST /api/images/upload`.
- `server/src/images/gc.ts` — unreferenced-hash reporting and deletion for the CLI.

**Modify — server**
- `server/src/config.ts` — `imageDir`.
- `server/src/sync/tables.ts` — `image` in `SYNC_TABLES` and `TABLE_SPECS`; `image_id` on `food` and `meal`.
- `server/src/app.ts` — register `imageRoutes`, add providers and an image-fetch client to `defaultDeps`.
- `server/src/off/client.ts` — request and carry image fields.
- `server/src/off/normalize.ts` — expose the OFF photo as a candidate.
- `server/src/routes/barcode.ts` — return that candidate.
- `server/src/cli.ts` — `images gc` subcommand.
- `server/package.json` — `sharp`.

**Modify — web**
- `web/src/db/db.ts` — `image` in `SYNC_TABLES`, `SyncRecords`, Dexie `version(4)`.
- `web/src/lib/images.ts` (create) — client for the four routes, plus canvas downscale before upload.
- `web/src/ui/ImagePicker.tsx` (create) — candidate grid, upload, remove.
- `web/src/ui/ImageThumb.tsx` (create) — one `<img>` with the empty state, reused everywhere.
- `web/src/ui/FoodEditor.tsx`, `web/src/ui/MealEditor.tsx` — thumbnail slot. (Exact filenames confirmed in Task 13 Step 1; the editors are the components that render a food/meal form.)
- `web/vite.config.ts` — Workbox runtime caching for `/api/images/`.

**Modify — iOS**
- `ios/CarbBookKit/Sources/CarbBookKit/Schema.swift` — `v5Images` migration.
- `ios/CarbBookKit/Sources/CarbBookKit/TableCodec.swift` — `image` columns, `image_id` as a legacy column on `food`/`meal`.
- `ios/CarbBookCore/Sources/CarbBookCore/Sync.swift` — `SyncTables.all`: add `image`, and fix the missing `plan_entry`/`plan_item`.
- `ios/CarbBookKit/Sources/CarbBookKit/ImageCache.swift` (create) — hash-keyed Caches-directory cache.
- iOS editor and list views — thumbnail slot and picker.

---

## Task 1: Core image types

**Files:**
- Create: `packages/core/src/images.ts`
- Modify: `packages/core/src/types.ts:15-28` (`FoodData`), `packages/core/src/types.ts:51-57` (`MealData`)
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/images.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/images.test.ts
import { describe, expect, it } from 'vitest';
import { IMAGE_HASH_PATTERN, IMAGE_MAX_EDGE_PX, IMAGE_SOURCES, isImageHash } from '../src/images';

describe('image constants', () => {
  it('accepts a lowercase 64-char hex hash', () => {
    expect(isImageHash('a'.repeat(64))).toBe(true);
  });

  it('rejects uppercase, wrong length and non-hex', () => {
    expect(isImageHash('A'.repeat(64))).toBe(false);
    expect(isImageHash('a'.repeat(63))).toBe(false);
    expect(isImageHash('a'.repeat(63) + 'z')).toBe(false);
    expect(isImageHash('')).toBe(false);
  });

  it('pins the shared limits', () => {
    expect(IMAGE_MAX_EDGE_PX).toBe(800);
    expect(IMAGE_SOURCES).toEqual(['off', 'openverse', 'wikimedia', 'themealdb', 'upload']);
    expect(IMAGE_HASH_PATTERN.source).toBe('^[0-9a-f]{64}$');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run test/images.test.ts`
Expected: FAIL — `Cannot find module '../src/images'`

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/images.ts
/** One image per food or meal (images spec 2026-09-18). Metadata syncs; bytes never do. */

/** Where an image came from. `upload` is the user's own photo. */
export const IMAGE_SOURCES = ['off', 'openverse', 'wikimedia', 'themealdb', 'upload'] as const;
export type ImageSource = (typeof IMAGE_SOURCES)[number];

/** Only JPEG is stored in this version; every adopt and upload is re-encoded to it. */
export const IMAGE_MIME_TYPES = ['image/jpeg'] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

/** Longest edge after normalisation. Smaller images are never upscaled. */
export const IMAGE_MAX_EDGE_PX = 800;
/** JPEG quality used on the way in. */
export const IMAGE_JPEG_QUALITY = 80;
/** Hard ceiling on stored bytes; at 800px/q80 this is generous and should not be reached. */
export const IMAGE_MAX_STORED_BYTES = 400 * 1024;
/** Ceiling on a download before normalisation, so a hostile URL cannot stream forever. */
export const IMAGE_MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
/** Attribution is displayed verbatim, so it stays short enough to render. */
export const IMAGE_ATTRIBUTION_MAX = 300;

/** id is the SHA-256 of the *normalised* bytes, so the same image dedups to one row. */
export const IMAGE_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function isImageHash(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_HASH_PATTERN.test(value);
}

export interface ImageData {
  id: string;
  mime: ImageMime;
  width: number;
  height: number;
  source: ImageSource;
  source_url?: string | null;
  license?: string | null;
  attribution?: string | null;
}
```

- [ ] **Step 4: Add `image_id` to the food and meal types**

In `packages/core/src/types.ts`, add to `FoodData` (after `notes`) and to `MealData` (after `notes`):

```ts
  /** Optional image, referencing image.id (images spec 2026-09-18). Dangling ids render as no image. */
  image_id?: string | null;
```

- [ ] **Step 5: Export from the core barrel**

Add to `packages/core/src/index.ts`, next to the other `export *` lines:

```ts
export * from './images';
```

- [ ] **Step 6: Run the core suite and typecheck**

Run: `cd packages/core && pnpm test && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/images.ts packages/core/src/types.ts packages/core/src/index.ts packages/core/test/images.test.ts
git commit -m "core: image types and shared limits"
```

---

## Task 2: Migration 006 and sync registration

The migration runner applies files in `server/migrations/` by `PRAGMA user_version`, one transaction per file (`server/src/db.ts:19-35`). This is a pure-addition migration: a new table plus two `ALTER TABLE ... ADD COLUMN`, so unlike 003 and 005 it needs no table rebuild.

**Files:**
- Create: `server/migrations/006_images.sql`
- Modify: `server/src/sync/tables.ts:14-25` (`SYNC_TABLES`), `server/src/sync/tables.ts:170-186` (`food` spec), `server/src/sync/tables.ts:211-219` (`meal` spec), and `TABLE_SPECS` (new `image` entry)
- Test: `server/test/images-sync.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/test/images-sync.test.ts
import { describe, expect, it } from 'vitest';
import { openTestDb, pushAs } from './helpers';
import { SYNC_TABLES, TABLE_SPECS, columnsOf } from '../src/sync/tables';

const HASH = 'b'.repeat(64);
const meta = { updated_at: 1_700_000_000_000, updated_by: 'test', deleted: 0 };
const imageRow = {
  id: HASH,
  mime: 'image/jpeg',
  width: 800,
  height: 600,
  source: 'openverse',
  source_url: 'https://api.openverse.org/v1/images/x/thumb/',
  license: 'CC-BY-4.0',
  attribution: 'Someone, CC BY 4.0',
  ...meta,
};

describe('image sync table', () => {
  it('is registered in the pull order', () => {
    expect(SYNC_TABLES).toContain('image');
    expect(columnsOf(TABLE_SPECS.image)).toEqual([
      'id', 'mime', 'width', 'height', 'source', 'source_url', 'license', 'attribution',
      'updated_at', 'updated_by', 'deleted', 'server_seq',
    ]);
  });

  it('accepts a valid image row', () => {
    const db = openTestDb();
    expect(pushAs(db, 'owner', [{ table: 'image', record: imageRow }])[0]!.status).toBe('accepted');
  });

  it('rejects a non-hash id, an unknown source, a bad mime and a zero dimension', () => {
    const db = openTestDb();
    const bad = [
      { ...imageRow, id: 'not-a-hash' },
      { ...imageRow, source: 'pinterest' },
      { ...imageRow, mime: 'image/png' },
      { ...imageRow, width: 0 },
    ];
    for (const record of bad) {
      const [result] = pushAs(db, 'owner', [{ table: 'image', record }]);
      expect(result!.status, JSON.stringify(record)).toBe('rejected');
      expect(result!.reason).toBe('invalid');
    }
  });

  it('accepts image_id on food and meal, and tolerates a dangling one', () => {
    const db = openTestDb();
    const results = pushAs(db, 'owner', [
      { table: 'food', record: { id: 'f1', name: 'Soup', source: 'custom', carbs_per_100g: 10, image_id: HASH, ...meta } },
      { table: 'meal', record: { id: 'm1', name: 'Pot', yield_servings: 10, image_id: 'c'.repeat(64), ...meta } },
    ]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
  });

  it('rejects an image_id that is not a hash', () => {
    const db = openTestDb();
    const [result] = pushAs(db, 'owner', [
      { table: 'food', record: { id: 'f2', name: 'Soup', source: 'custom', carbs_per_100g: 10, image_id: 'nope', ...meta } },
    ]);
    expect(result!.status).toBe('rejected');
  });
});
```

- [ ] **Step 2: Check the test helpers exist under those names**

Run: `ls server/test/ && grep -rn "export function openTestDb\|export function pushAs" server/test/`
If `server/test/helpers.ts` does not export both, use whatever the existing sync tests use (look at `server/test/sync-push.test.ts`) and adjust the imports in Step 1 to match. Do not create a second helper module.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && pnpm vitest run test/images-sync.test.ts`
Expected: FAIL — `SYNC_TABLES` has no `image`, and `TABLE_SPECS.image` is undefined.

- [ ] **Step 4: Write the migration**

```sql
-- server/migrations/006_images.sql
-- Food and meal images (docs/superpowers/specs/2026-09-18-food-images-design.md).
-- Pure additions: a new synced metadata table plus a nullable image_id on food and meal.
-- No table rebuild is needed (unlike 003 and 005) because no CHECK constraint changes.
-- The runner (server/src/db.ts) wraps this file in one transaction.

-- Deploy guard: refuse to run twice or over a hand-added column.
CREATE TEMP TABLE migration_006_guard (problems INTEGER NOT NULL);
CREATE TEMP TRIGGER migration_006_guard_check BEFORE INSERT ON migration_006_guard
  WHEN NEW.problems > 0
  BEGIN
    SELECT RAISE(ABORT, 'migration 006: image table or an image_id column already exists; inspect the database before upgrading');
  END;
INSERT INTO migration_006_guard (problems) SELECT
    (SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'image')
  + (SELECT count(*) FROM pragma_table_info('food') WHERE name = 'image_id')
  + (SELECT count(*) FROM pragma_table_info('meal') WHERE name = 'image_id');
DROP TRIGGER migration_006_guard_check;
DROP TABLE migration_006_guard;

-- id = sha256 of the normalised bytes, lowercase hex. Bytes live on disk under IMAGE_DIR,
-- never in this database and never in sync payloads. Licence and attribution travel with the
-- row because a CC-BY image displayed without its credit line is a licence violation.
CREATE TABLE image (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg')),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  source TEXT NOT NULL CHECK (source IN ('off', 'openverse', 'wikimedia', 'themealdb', 'upload')),
  source_url TEXT,
  license TEXT,
  attribution TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX image_server_seq ON image (server_seq);

-- Not a foreign key: offline clients may push a food before its image row arrives, and a
-- dangling id must render as no image rather than fail the push (tables.ts:129-135).
ALTER TABLE food ADD COLUMN image_id TEXT;
ALTER TABLE meal ADD COLUMN image_id TEXT;
CREATE INDEX food_image ON food (image_id);
CREATE INDEX meal_image ON meal (image_id);
```

- [ ] **Step 5: Register the table and the two columns**

In `server/src/sync/tables.ts`:

Add `'image',` to `SYNC_TABLES` — put it **last**, after `'plan_item'`. The array is the pull order, and appending means existing clients' cursors are unaffected.

Import the hash check at the top, alongside the other `@carbbook/core` imports:

```ts
  IMAGE_ATTRIBUTION_MAX,
  IMAGE_MIME_TYPES,
  IMAGE_SOURCES,
  isImageHash,
```

Add the spec to `TABLE_SPECS`, after `plan_item`:

```ts
  image: {
    name: 'image',
    fields: {
      mime: { type: 'enum', values: IMAGE_MIME_TYPES },
      width: { type: 'number', integer: true, positive: true },
      height: { type: 'number', integer: true, positive: true },
      source: { type: 'enum', values: IMAGE_SOURCES },
      source_url: optionalText(2048),
      license: optionalText(120),
      attribution: optionalText(IMAGE_ATTRIBUTION_MAX),
    },
    // id is the content hash, so it is validated as a field would be, not as a free-form id.
    check: (r) => (isImageHash(r.id) ? null : 'image id must be a lowercase sha256 hex digest'),
  },
```

Add to the `food` and `meal` field maps, after `notes`:

```ts
      image_id: imageId,
```

and define the shared helper next to `text`/`optionalText` at `tables.ts:127`:

```ts
/** Nullable reference to image.id. Not a foreign key; a dangling id renders as no image. */
const imageId: FieldSpec = { type: 'text', nullable: true, max: 64 };
```

- [ ] **Step 6: Add the `image_id` hash check to the food and meal cross-field checks**

`food` currently has no `check`. Add one; `meal` gets the same rule. Define it once above `TABLE_SPECS`:

```ts
const checkImageId = (r: Record<string, unknown>): string | null =>
  r.image_id == null || isImageHash(r.image_id) ? null : 'image_id must be a lowercase sha256 hex digest';
```

Then on `food`: `check: checkImageId,` and on `meal`: `check: checkImageId,`.

- [ ] **Step 7: Run the tests**

Run: `cd server && pnpm vitest run test/images-sync.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 8: Run the whole server suite — the migration is new, so nothing else may break**

Run: `cd server && pnpm test && pnpm typecheck`
Expected: PASS. If a test asserts the exact `SYNC_TABLES` length or contents, update it to include `image`.

- [ ] **Step 9: Commit**

```bash
git add server/migrations/006_images.sql server/src/sync/tables.ts server/test/images-sync.test.ts
git commit -m "server: image sync table and food/meal image_id"
```

---

## Task 3: Magic-byte image sniffing

Trusting a remote `content-type` is how you end up storing an HTML error page as a JPEG. This module is the one that decides whether a buffer is an image, and it is deliberately separate from the store so it needs no filesystem.

**Files:**
- Create: `server/src/images/sniff.ts`
- Test: `server/test/images-sniff.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/test/images-sniff.test.ts
import { describe, expect, it } from 'vitest';
import { sniffImageMime } from '../src/images/sniff';

const bytes = (...values: number[]) => Buffer.from(values);

describe('sniffImageMime', () => {
  it('detects the formats sharp can decode', () => {
    expect(sniffImageMime(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toBe('image/jpeg');
    expect(sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(sniffImageMime(Buffer.from('GIF89a       '))).toBe('image/gif');
    expect(sniffImageMime(Buffer.concat([Buffer.from('RIFF'), bytes(0, 0, 0, 0), Buffer.from('WEBP')]))).toBe('image/webp');
    expect(sniffImageMime(Buffer.concat([bytes(0, 0, 0, 0x18), Buffer.from('ftypheic')]))).toBe('image/heic');
    expect(sniffImageMime(Buffer.concat([bytes(0, 0, 0, 0x18), Buffer.from('ftypavif')]))).toBe('image/avif');
  });

  it('returns null for things that are not images', () => {
    expect(sniffImageMime(Buffer.from('<!doctype html><html>oops'))).toBeNull();
    expect(sniffImageMime(Buffer.from('{"error":"not found"}'))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
    expect(sniffImageMime(bytes(0xff, 0xd8))).toBeNull(); // truncated JPEG signature
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm vitest run test/images-sniff.test.ts`
Expected: FAIL — `Cannot find module '../src/images/sniff'`

- [ ] **Step 3: Write the implementation**

```ts
// server/src/images/sniff.ts
/**
 * Decide what a buffer actually is from its leading bytes. A remote content-type header is
 * attacker- or bug-controlled; this is not. Only formats sharp can decode are recognised, so
 * anything returning non-null is safe to hand to normalisation.
 */
export type SniffedMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/heic' | 'image/avif';

const startsWith = (buffer: Buffer, ...signature: number[]): boolean =>
  buffer.length >= signature.length && signature.every((byte, index) => buffer[index] === byte);

export function sniffImageMime(buffer: Buffer): SniffedMime | null {
  if (startsWith(buffer, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(buffer, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('latin1') === 'GIF87a' || buffer.subarray(0, 6).toString('latin1') === 'GIF89a')) {
    return 'image/gif';
  }
  // RIFF....WEBP
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  // ISO-BMFF: 4-byte box size, 'ftyp', then the brand.
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1');
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif';
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('hevc') || brand.startsWith('mif1')) {
      return 'image/heic';
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && pnpm vitest run test/images-sniff.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/images/sniff.ts server/test/images-sniff.test.ts
git commit -m "server: magic-byte image sniffing"
```

---

## Task 4: Byte store (install sharp, normalise, hash, write, read)

**Files:**
- Modify: `server/package.json`
- Modify: `server/src/config.ts:56-71`
- Create: `server/src/images/store.ts`
- Test: `server/test/images-store.test.ts`

- [ ] **Step 1: Install sharp and verify the arm64 prebuilt resolves**

```bash
cd server && pnpm add sharp
node -e "const s=require('sharp'); console.log(s.versions)"
```
Expected: version object printed, no build output, no compiler invoked. `pnpm` pins dependencies exactly in this repo (`server/package.json` has no `^`), so keep the exact version it wrote.

**Stop condition:** if this triggers a source build or fails to resolve a prebuilt binary for linux-arm64, **stop and report**. Per the spec's risk 1, do not add a build toolchain to the Dockerfile. Falling back to storing unresized bytes is an acceptable alternative, but it is a decision for the user, not this task.

Then confirm it works in the deployment image, not just on the desktop:

```bash
ssh pi "docker run --rm --entrypoint node node:22-bookworm-slim -e \"console.log(process.arch)\""
```
Expected: `arm64`. The real check happens in Task 19's deploy step; this is the early smoke.

- [ ] **Step 2: Add the config key**

In `server/src/config.ts`, inside `loadConfig`, after the `usdaDir` line:

```ts
    imageDir: text(env, 'IMAGE_DIR', '/data/images'),
```

Add `imageDir: string;` to the `Config` interface next to `usdaDir`.

- [ ] **Step 3: Write the failing test**

```ts
// server/test/images-store.test.ts
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { IMAGE_MAX_EDGE_PX } from '@carbbook/core';
import { createImageStore, ImageRejectedError } from '../src/images/store';

let dir: string;
let store: ReturnType<typeof createImageStore>;
let tall: Buffer;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'carbbook-images-'));
  store = createImageStore({ imageDir: dir });
  // 1600x1200 red PNG carrying EXIF-ish metadata, to prove re-encoding and stripping.
  tall = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#c00' } }).png().toBuffer();
});

describe('image store', () => {
  it('normalises to a capped JPEG and returns metadata', async () => {
    const stored = await store.put(tall);
    expect(stored.mime).toBe('image/jpeg');
    expect(Math.max(stored.width, stored.height)).toBe(IMAGE_MAX_EDGE_PX);
    expect(stored.width).toBe(800);
    expect(stored.height).toBe(600);
    expect(stored.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes the bytes at a sharded path and reads them back', async () => {
    const stored = await store.put(tall);
    const path = store.pathFor(stored.id);
    expect(path).toBe(join(dir, stored.id.slice(0, 2), `${stored.id}.jpg`));
    expect(existsSync(path)).toBe(true);
    const sniffed = readFileSync(path);
    expect(sniffed.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(await store.has(stored.id)).toBe(true);
  });

  it('is content-addressed: the same input dedups to one id and one file', async () => {
    const first = await store.put(tall);
    const second = await store.put(tall);
    expect(second.id).toBe(first.id);
  });

  it('does not upscale a small image', async () => {
    const small = await sharp({ create: { width: 120, height: 90, channels: 3, background: '#0c0' } }).png().toBuffer();
    const stored = await store.put(small);
    expect(stored.width).toBe(120);
    expect(stored.height).toBe(90);
  });

  it('strips metadata', async () => {
    const withExif = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#00c' } })
      .withMetadata({ exif: { IFD0: { Copyright: 'someone' } } })
      .jpeg()
      .toBuffer();
    const stored = await store.put(withExif);
    const meta = await sharp(readFileSync(store.pathFor(stored.id))).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it('rejects a buffer that is not an image', async () => {
    await expect(store.put(Buffer.from('<!doctype html>not an image'))).rejects.toBeInstanceOf(ImageRejectedError);
  });

  it('reports a missing hash as absent rather than throwing', async () => {
    expect(await store.has('f'.repeat(64))).toBe(false);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd server && pnpm vitest run test/images-store.test.ts`
Expected: FAIL — `Cannot find module '../src/images/store'`

- [ ] **Step 5: Write the implementation**

```ts
// server/src/images/store.ts
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import {
  IMAGE_HASH_PATTERN,
  IMAGE_JPEG_QUALITY,
  IMAGE_MAX_EDGE_PX,
  IMAGE_MAX_STORED_BYTES,
} from '@carbbook/core';
import { sniffImageMime } from './sniff';

/** Bad input, not a server fault: routes map this to a 4xx. */
export class ImageRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageRejectedError';
  }
}

export interface StoredImage {
  /** sha256 of the normalised bytes, lowercase hex. */
  id: string;
  mime: 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
}

export interface ImageStore {
  /** Normalise, hash, and write. Idempotent: the same input yields the same id and rewrites nothing. */
  put(input: Buffer): Promise<StoredImage>;
  pathFor(hash: string): string;
  has(hash: string): Promise<boolean>;
  /** Stream for the serving route; the caller has already validated the hash shape. */
  read(hash: string): ReturnType<typeof createReadStream>;
  remove(hash: string): Promise<void>;
}

export interface ImageStoreOptions {
  imageDir: string;
}

export function createImageStore(options: ImageStoreOptions): ImageStore {
  const pathFor = (hash: string): string => {
    if (!IMAGE_HASH_PATTERN.test(hash)) throw new ImageRejectedError('not an image hash');
    return join(options.imageDir, hash.slice(0, 2), `${hash}.jpg`);
  };

  return {
    pathFor,

    async put(input) {
      if (sniffImageMime(input) === null) throw new ImageRejectedError('not a recognised image format');

      let normalised: { data: Buffer; info: sharp.OutputInfo };
      try {
        normalised = await sharp(input, { failOn: 'error' })
          // rotate() applies the EXIF orientation, and since we never call withMetadata()
          // the output carries no EXIF at all — including any GPS tag from a phone photo.
          .rotate()
          .resize({ width: IMAGE_MAX_EDGE_PX, height: IMAGE_MAX_EDGE_PX, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: IMAGE_JPEG_QUALITY })
          .toBuffer({ resolveWithObject: true });
      } catch (error) {
        throw new ImageRejectedError(`could not decode image: ${(error as Error).message}`);
      }

      if (normalised.data.byteLength > IMAGE_MAX_STORED_BYTES) {
        throw new ImageRejectedError(
          `image is ${normalised.data.byteLength} bytes after resizing, over the ${IMAGE_MAX_STORED_BYTES} limit`,
        );
      }

      const id = createHash('sha256').update(normalised.data).digest('hex');
      const target = pathFor(id);
      await mkdir(dirname(target), { recursive: true });
      // Write to a unique temp name then rename: concurrent puts of the same image cannot
      // leave a half-written file visible at the content-addressed path.
      const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, normalised.data);
      await rename(temp, target);

      return {
        id,
        mime: 'image/jpeg',
        width: normalised.info.width,
        height: normalised.info.height,
        bytes: normalised.data.byteLength,
      };
    },

    async has(hash) {
      if (!IMAGE_HASH_PATTERN.test(hash)) return false;
      try {
        const stats = await stat(pathFor(hash));
        return stats.isFile();
      } catch {
        return false;
      }
    },

    read(hash) {
      return createReadStream(pathFor(hash));
    },

    async remove(hash) {
      try {
        await unlink(pathFor(hash));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd server && pnpm vitest run test/images-store.test.ts`
Expected: PASS (7 tests). If the EXIF assertion fails because sharp reports an empty buffer rather than `undefined`, assert `meta.exif ?? undefined` is `undefined` — the behaviour under test is "no copyright tag survives", so also assert the round-tripped buffer does not contain `someone`.

- [ ] **Step 7: Commit**

```bash
git add server/package.json pnpm-lock.yaml server/src/config.ts server/src/images/store.ts server/test/images-store.test.ts
git commit -m "server: content-addressed image byte store"
```

---

## Task 5: URL guard (the SSRF boundary)

`POST /api/images/adopt` makes the server fetch a URL a client chose. This module is the only reason that is safe. Per spec risk 2, its tests are the most important in the suite — write them first and make them exhaustive.

Adoption only ever targets **provider-owned hosts**, never the arbitrary origin an Openverse result points at. That is what keeps the allowlist short.

**Files:**
- Create: `server/src/images/urlguard.ts`
- Test: `server/test/images-urlguard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/test/images-urlguard.test.ts
import { describe, expect, it } from 'vitest';
import { assertAdoptableUrl, isPublicAddress, PROVIDER_HOSTS, UrlRejectedError } from '../src/images/urlguard';

/** Resolver stub: the guard never does real DNS in tests. */
const resolvesTo = (address: string) => async () => [{ address, family: address.includes(':') ? 6 : 4 }];
const publicResolver = resolvesTo('93.184.216.34');

describe('PROVIDER_HOSTS', () => {
  it('lists exactly the hosts each provider serves bytes from', () => {
    expect(PROVIDER_HOSTS).toEqual({
      openverse: ['api.openverse.org'],
      wikimedia: ['upload.wikimedia.org'],
      themealdb: ['www.themealdb.com'],
      off: ['images.openfoodfacts.org', 'static.openfoodfacts.org'],
    });
  });
});

describe('isPublicAddress', () => {
  it('rejects loopback, private, link-local, CGNAT and metadata addresses', () => {
    for (const address of [
      '127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.210',
      '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '::1', 'fe80::1', 'fc00::1', 'fd7a:115c:a1e0::8a37:bd0e', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('accepts ordinary public addresses', () => {
    for (const address of ['93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });
});

describe('assertAdoptableUrl', () => {
  const ok = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/b/soup.jpg/800px-soup.jpg';

  it('accepts a provider URL that resolves publicly', async () => {
    await expect(assertAdoptableUrl(ok, 'wikimedia', { lookup: publicResolver })).resolves.toBeUndefined();
  });

  it('rejects http, credentials, a non-default port and a query-smuggled host', async () => {
    const bad = [
      'http://upload.wikimedia.org/x.jpg',
      'https://user:pass@upload.wikimedia.org/x.jpg',
      'https://upload.wikimedia.org:8080/x.jpg',
      'ftp://upload.wikimedia.org/x.jpg',
      'file:///etc/passwd',
      'https://upload.wikimedia.org.evil.test/x.jpg',
      'https://evil.test/x.jpg?host=upload.wikimedia.org',
      'not a url',
    ];
    for (const url of bad) {
      await expect(assertAdoptableUrl(url, 'wikimedia', { lookup: publicResolver }), url).rejects.toBeInstanceOf(UrlRejectedError);
    }
  });

  it('rejects a host belonging to a different provider', async () => {
    await expect(assertAdoptableUrl(ok, 'openverse', { lookup: publicResolver })).rejects.toBeInstanceOf(UrlRejectedError);
  });

  it('rejects an allowlisted host that resolves into a private range (DNS rebinding)', async () => {
    await expect(assertAdoptableUrl(ok, 'wikimedia', { lookup: resolvesTo('169.254.169.254') })).rejects.toBeInstanceOf(UrlRejectedError);
    await expect(assertAdoptableUrl(ok, 'wikimedia', { lookup: resolvesTo('::1') })).rejects.toBeInstanceOf(UrlRejectedError);
  });

  it('rejects when any resolved address is private, not just the first', async () => {
    const mixed = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ];
    await expect(assertAdoptableUrl(ok, 'wikimedia', { lookup: mixed })).rejects.toBeInstanceOf(UrlRejectedError);
  });

  it('rejects when DNS fails', async () => {
    const fails = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(assertAdoptableUrl(ok, 'wikimedia', { lookup: fails })).rejects.toBeInstanceOf(UrlRejectedError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm vitest run test/images-urlguard.test.ts`
Expected: FAIL — `Cannot find module '../src/images/urlguard'`

- [ ] **Step 3: Write the implementation**

```ts
// server/src/images/urlguard.ts
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';

/**
 * The SSRF boundary for POST /api/images/adopt, which fetches a URL a client supplied.
 *
 * Two independent gates, both required:
 *   1. The host must be one the named provider itself serves bytes from. We never adopt from the
 *      arbitrary origin an Openverse or Commons result points at — only from the provider's own
 *      host — which is what keeps this list short enough to be auditable.
 *   2. Every address that host resolves to must be public, which blocks a DNS entry (hostile or
 *      compromised) pointing an allowlisted name at the Pi's LAN, the loopback interface, the
 *      Tailscale range, or a cloud metadata endpoint.
 */
export class UrlRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlRejectedError';
  }
}

export type AdoptProvider = 'openverse' | 'wikimedia' | 'themealdb' | 'off';

/** Exact hostnames, never suffix matches: "upload.wikimedia.org.evil.test" must not pass. */
export const PROVIDER_HOSTS: Record<AdoptProvider, string[]> = {
  openverse: ['api.openverse.org'],
  wikimedia: ['upload.wikimedia.org'],
  themealdb: ['www.themealdb.com'],
  off: ['images.openfoodfacts.org', 'static.openfoodfacts.org'],
};

type LookupResult = { address: string; family: number };
export interface UrlGuardOptions {
  /** Injected so tests never touch real DNS. */
  lookup?: (hostname: string) => Promise<LookupResult[]>;
}

const defaultLookup = (hostname: string): Promise<LookupResult[]> => dnsLookup(hostname, { all: true, verbatim: true });

function ipv4IsPublic(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;                    // this-network, private, loopback
  if (a === 169 && b === 254) return false;                              // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return false;                     // private
  if (a === 192 && b === 168) return false;                              // private
  if (a === 100 && b >= 64 && b <= 127) return false;                    // CGNAT, which Tailscale uses
  if (a === 192 && b === 0) return false;                                // IETF protocol assignments
  if (a >= 224) return false;                                            // multicast, reserved, broadcast
  return true;
}

export function isPublicAddress(address: string): boolean {
  if (isIPv4(address)) return ipv4IsPublic(address);
  const lower = address.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) must be judged by its IPv4 half.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return ipv4IsPublic(mapped[1]!);
  if (lower === '::' || lower === '::1') return false;                   // unspecified, loopback
  if (lower.startsWith('fe80')) return false;                            // link-local
  if (/^f[cd]/.test(lower)) return false;                                // unique-local, incl. Tailscale's fd7a::/48
  if (lower.startsWith('ff')) return false;                              // multicast
  return true;
}

export async function assertAdoptableUrl(
  raw: string,
  provider: AdoptProvider,
  options: UrlGuardOptions = {},
): Promise<void> {
  if (!URL.canParse(raw)) throw new UrlRejectedError('not a URL');
  const url = new URL(raw);

  if (url.protocol !== 'https:') throw new UrlRejectedError('only https URLs can be adopted');
  if (url.username !== '' || url.password !== '') throw new UrlRejectedError('URL must not carry credentials');
  if (url.port !== '') throw new UrlRejectedError('URL must use the default https port');

  const allowed = PROVIDER_HOSTS[provider];
  if (!allowed) throw new UrlRejectedError(`unknown provider ${provider}`);
  if (!allowed.includes(url.hostname.toLowerCase())) {
    throw new UrlRejectedError(`${url.hostname} is not a host ${provider} serves images from`);
  }

  let addresses: LookupResult[];
  try {
    addresses = await (options.lookup ?? defaultLookup)(url.hostname);
  } catch (error) {
    throw new UrlRejectedError(`could not resolve ${url.hostname}: ${(error as Error).message}`);
  }
  if (addresses.length === 0) throw new UrlRejectedError(`${url.hostname} resolved to nothing`);
  for (const { address } of addresses) {
    if (!isPublicAddress(address)) {
      throw new UrlRejectedError(`${url.hostname} resolves to a non-public address`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && pnpm vitest run test/images-urlguard.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/images/urlguard.ts server/test/images-urlguard.test.ts
git commit -m "server: SSRF guard for image adoption"
```

---

## Task 6: Provider interface and the Openverse provider

**Files:**
- Create: `server/src/images/providers/types.ts`, `server/src/images/providers/openverse.ts`
- Test: `server/test/images-openverse.test.ts`

- [ ] **Step 1: Write the types**

```ts
// server/src/images/providers/types.ts
/** One search hit. Nothing is downloaded to produce these; thumb_url is loaded by the client. */
export interface ImageCandidate {
  provider: 'openverse' | 'wikimedia' | 'themealdb' | 'off';
  /** Small image for the picker grid. */
  thumb_url: string;
  /** What POST /api/images/adopt will fetch. Must be on the provider's own host (urlguard.ts). */
  full_url: string;
  width: number | null;
  height: number | null;
  license: string | null;
  attribution: string | null;
  title: string | null;
}

export interface ImageSearchProvider {
  readonly name: ImageCandidate['provider'];
  /** Resolves candidates, or rejects; the aggregator turns a rejection into `providers_failed`. */
  search(query: string, limit: number): Promise<ImageCandidate[]>;
}

export interface ProviderOptions {
  baseUrl: string;
  timeoutMs: number;
  fetch: typeof globalThis.fetch;
  userAgent: string;
}

/** Shared by every provider: one JSON GET with a timeout, failures thrown as this. */
export class ProviderUnavailableError extends Error {
  constructor(provider: string, message: string) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderUnavailableError';
  }
}

export async function getJson<T>(provider: string, url: string, options: ProviderOptions): Promise<T> {
  try {
    const response = await options.fetch(url, {
      headers: { accept: 'application/json', 'user-agent': options.userAgent },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    // 429 is normal for anonymous Openverse use; it is unavailability, not a bug.
    if (!response.ok) throw new ProviderUnavailableError(provider, `responded ${response.status}`);
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ProviderUnavailableError) throw error;
    throw new ProviderUnavailableError(provider, (error as Error).message);
  }
}
```

- [ ] **Step 2: Write the failing test**

```ts
// server/test/images-openverse.test.ts
import { describe, expect, it } from 'vitest';
import { createOpenverseProvider } from '../src/images/providers/openverse';
import { ProviderUnavailableError } from '../src/images/providers/types';

/** Trimmed from a live api.openverse.org/v1/images/?q=tomato+soup response. */
const RESPONSE = {
  result_count: 2,
  results: [
    {
      id: '11111111-1111-1111-1111-111111111111',
      title: 'Tomato soup',
      creator: 'A Cook',
      license: 'by',
      license_version: '4.0',
      width: 2400,
      height: 1600,
      thumbnail: 'https://api.openverse.org/v1/images/11111111-1111-1111-1111-111111111111/thumb/',
      url: 'https://live.staticflickr.com/1/2_3_b.jpg',
      foreign_landing_url: 'https://www.flickr.com/photos/x/2',
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      title: null,
      creator: null,
      license: 'cc0',
      license_version: '1.0',
      width: null,
      height: null,
      thumbnail: 'https://api.openverse.org/v1/images/22222222-2222-2222-2222-222222222222/thumb/',
      url: 'https://example.test/2.jpg',
      foreign_landing_url: null,
    },
  ],
};

function stubFetch(handler: (url: string) => Response) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return handler(String(input));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const options = (fetch: typeof globalThis.fetch) => ({
  baseUrl: 'https://api.openverse.org',
  timeoutMs: 1000,
  userAgent: 'CarbBook/test',
  fetch,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('openverse provider', () => {
  it('maps results and adopts from the Openverse-hosted thumbnail, not the foreign origin', async () => {
    const { fetch, calls } = stubFetch(() => json(RESPONSE));
    const candidates = await createOpenverseProvider(options(fetch)).search('tomato soup', 10);

    expect(calls[0]).toContain('/v1/images/?');
    expect(calls[0]).toContain('q=tomato+soup');
    expect(calls[0]).toContain('page_size=10');

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual({
      provider: 'openverse',
      thumb_url: 'https://api.openverse.org/v1/images/11111111-1111-1111-1111-111111111111/thumb/',
      // Deliberately the same Openverse-proxied URL: urlguard only allows api.openverse.org,
      // and that proxy serves an image large enough for our 800px cap.
      full_url: 'https://api.openverse.org/v1/images/11111111-1111-1111-1111-111111111111/thumb/',
      width: 2400,
      height: 1600,
      license: 'CC-BY-4.0',
      attribution: 'Tomato soup by A Cook (CC-BY-4.0)',
      title: 'Tomato soup',
    });
  });

  it('handles a missing creator, title and dimensions', async () => {
    const { fetch } = stubFetch(() => json(RESPONSE));
    const candidates = await createOpenverseProvider(options(fetch)).search('x', 10);
    expect(candidates[1]!.license).toBe('CC0-1.0');
    expect(candidates[1]!.attribution).toBe('CC0-1.0');
    expect(candidates[1]!.width).toBeNull();
    expect(candidates[1]!.title).toBeNull();
  });

  it('drops a result with no Openverse thumbnail rather than adopting a foreign host', async () => {
    const { fetch } = stubFetch(() =>
      json({ results: [{ ...RESPONSE.results[0], thumbnail: 'https://live.staticflickr.com/1/2_3_b.jpg' }] }),
    );
    expect(await createOpenverseProvider(options(fetch)).search('x', 10)).toEqual([]);
  });

  it('throws ProviderUnavailableError on 429 and on a non-JSON body', async () => {
    const rateLimited = stubFetch(() => new Response('slow down', { status: 429 }));
    await expect(createOpenverseProvider(options(rateLimited.fetch)).search('x', 10)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    const garbage = stubFetch(() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(createOpenverseProvider(options(garbage.fetch)).search('x', 10)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it('returns an empty list when the response has no results array', async () => {
    const { fetch } = stubFetch(() => json({ result_count: 0 }));
    expect(await createOpenverseProvider(options(fetch)).search('x', 10)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && pnpm vitest run test/images-openverse.test.ts`
Expected: FAIL — `Cannot find module '../src/images/providers/openverse'`

- [ ] **Step 4: Write the implementation**

```ts
// server/src/images/providers/openverse.ts
import { PROVIDER_HOSTS } from '../urlguard';
import { getJson, type ImageCandidate, type ImageSearchProvider, type ProviderOptions } from './types';

/**
 * Openverse: ~700M CC-licensed images, no API key (anonymous calls are rate-limited, which
 * arrives as 429 and is treated as unavailability).
 *
 * We deliberately adopt the Openverse-proxied `thumbnail` URL rather than `url`, the original
 * on an arbitrary third-party host. That keeps every adoptable URL on api.openverse.org, which
 * is what makes the urlguard allowlist short. The proxy image is large enough for our 800px cap.
 */
interface OpenverseResult {
  id?: string;
  title?: string | null;
  creator?: string | null;
  license?: string | null;
  license_version?: string | null;
  width?: number | null;
  height?: number | null;
  thumbnail?: string | null;
}

/** Openverse reports licences as a slug plus a version: "by" + "4.0" -> CC-BY-4.0. */
function licenseOf(result: OpenverseResult): string | null {
  const slug = result.license?.trim().toLowerCase();
  if (!slug) return null;
  const version = result.license_version?.trim();
  if (slug === 'cc0') return version ? `CC0-${version}` : 'CC0-1.0';
  if (slug === 'pdm') return 'Public-Domain-Mark';
  return version ? `CC-${slug.toUpperCase()}-${version}` : `CC-${slug.toUpperCase()}`;
}

function attributionOf(result: OpenverseResult, license: string | null): string | null {
  const parts: string[] = [];
  if (result.title) parts.push(result.title);
  if (result.creator) parts.push(`by ${result.creator}`);
  const credit = parts.join(' ');
  if (credit && license) return `${credit} (${license})`;
  return credit || license || null;
}

export function createOpenverseProvider(options: ProviderOptions): ImageSearchProvider {
  const allowedHost = PROVIDER_HOSTS.openverse[0]!;
  return {
    name: 'openverse',
    async search(query, limit) {
      const url = `${options.baseUrl}/v1/images/?${new URLSearchParams({
        q: query,
        page_size: String(limit),
        // Only licences that permit reuse with attribution; excludes ND/NC edge cases we would
        // otherwise have to reason about per image.
        license: 'cc0,pdm,by,by-sa',
        mature: 'false',
      })}`;
      const body = await getJson<{ results?: OpenverseResult[] }>('openverse', url, options);
      const results = Array.isArray(body.results) ? body.results : [];

      return results.flatMap((result) => {
        const thumb = result.thumbnail?.trim();
        // Defence in depth: urlguard would reject a foreign host at adopt time anyway, but a
        // candidate we know is unadoptable should never reach the picker.
        if (!thumb || !URL.canParse(thumb) || new URL(thumb).hostname.toLowerCase() !== allowedHost) return [];
        const license = licenseOf(result);
        const candidate: ImageCandidate = {
          provider: 'openverse',
          thumb_url: thumb,
          full_url: thumb,
          width: result.width ?? null,
          height: result.height ?? null,
          license,
          attribution: attributionOf(result, license),
          title: result.title ?? null,
        };
        return [candidate];
      });
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && pnpm vitest run test/images-openverse.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/images/providers/types.ts server/src/images/providers/openverse.ts server/test/images-openverse.test.ts
git commit -m "server: Openverse image search provider"
```

---

## Task 7: Wikimedia Commons provider

**Files:**
- Create: `server/src/images/providers/wikimedia.ts`
- Test: `server/test/images-wikimedia.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/test/images-wikimedia.test.ts
import { describe, expect, it } from 'vitest';
import { createWikimediaProvider } from '../src/images/providers/wikimedia';
import { ProviderUnavailableError } from '../src/images/providers/types';

/** Trimmed from a live commons.wikimedia.org action=query response. */
const RESPONSE = {
  query: {
    pages: {
      '123': {
        pageid: 123,
        title: 'File:Tomato soup.jpg',
        imageinfo: [
          {
            thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/b/Tomato_soup.jpg/800px-Tomato_soup.jpg',
            thumbwidth: 800,
            thumbheight: 533,
            url: 'https://upload.wikimedia.org/wikipedia/commons/a/b/Tomato_soup.jpg',
            width: 3000,
            height: 2000,
            extmetadata: {
              LicenseShortName: { value: 'CC BY-SA 4.0' },
              Artist: { value: '<a href="/wiki/User:Someone">Someone</a>' },
            },
          },
        ],
      },
    },
  },
};

function stubFetch(handler: (url: string) => Response) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return handler(String(input));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const options = (fetch: typeof globalThis.fetch) => ({
  baseUrl: 'https://commons.wikimedia.org',
  timeoutMs: 1000,
  userAgent: 'CarbBook/test',
  fetch,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('wikimedia provider', () => {
  it('searches file namespace bitmaps and maps imageinfo', async () => {
    const { fetch, calls } = stubFetch(() => json(RESPONSE));
    const candidates = await createWikimediaProvider(options(fetch)).search('tomato soup', 8);

    expect(calls[0]).toContain('action=query');
    expect(calls[0]).toContain('gsrnamespace=6');
    expect(calls[0]).toContain('gsrlimit=8');
    expect(calls[0]).toContain('iiurlwidth=800');

    expect(candidates).toEqual([
      {
        provider: 'wikimedia',
        thumb_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/b/Tomato_soup.jpg/800px-Tomato_soup.jpg',
        full_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/b/Tomato_soup.jpg/800px-Tomato_soup.jpg',
        width: 800,
        height: 533,
        license: 'CC BY-SA 4.0',
        // HTML stripped: attribution is rendered as plain text on every client.
        attribution: 'Someone (CC BY-SA 4.0)',
        title: 'Tomato soup.jpg',
      },
    ]);
  });

  it('falls back to the full url when no thumburl is offered', async () => {
    const info = { ...RESPONSE.query.pages['123']!.imageinfo[0]! };
    delete (info as Record<string, unknown>).thumburl;
    const { fetch } = stubFetch(() => json({ query: { pages: { '123': { title: 'File:X.jpg', imageinfo: [info] } } } }));
    const candidates = await createWikimediaProvider(options(fetch)).search('x', 8);
    expect(candidates[0]!.full_url).toBe('https://upload.wikimedia.org/wikipedia/commons/a/b/Tomato_soup.jpg');
    expect(candidates[0]!.width).toBe(3000);
  });

  it('returns an empty list when the search matches nothing', async () => {
    const { fetch } = stubFetch(() => json({ batchcomplete: '' }));
    expect(await createWikimediaProvider(options(fetch)).search('zzzz', 8)).toEqual([]);
  });

  it('throws ProviderUnavailableError on a 500', async () => {
    const { fetch } = stubFetch(() => new Response('boom', { status: 500 }));
    await expect(createWikimediaProvider(options(fetch)).search('x', 8)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm vitest run test/images-wikimedia.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// server/src/images/providers/wikimedia.ts
import { IMAGE_MAX_EDGE_PX } from '@carbbook/core';
import { PROVIDER_HOSTS } from '../urlguard';
import { getJson, type ImageCandidate, type ImageSearchProvider, type ProviderOptions } from './types';

/**
 * Wikimedia Commons via action=query with a search generator. No API key. Licence and
 * attribution are reliable here, which is why it is worth having alongside Openverse.
 * Bytes always come from upload.wikimedia.org, the only host in the allowlist for this provider.
 */
interface CommonsImageInfo {
  thumburl?: string;
  thumbwidth?: number;
  thumbheight?: number;
  url?: string;
  width?: number;
  height?: number;
  extmetadata?: Record<string, { value?: unknown } | undefined>;
}

interface CommonsPage {
  title?: string;
  imageinfo?: CommonsImageInfo[];
}

/** extmetadata values are HTML fragments; every client renders attribution as plain text. */
function plainText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? null : text;
}

export function createWikimediaProvider(options: ProviderOptions): ImageSearchProvider {
  const allowedHost = PROVIDER_HOSTS.wikimedia[0]!;
  return {
    name: 'wikimedia',
    async search(query, limit) {
      const url = `${options.baseUrl}/w/api.php?${new URLSearchParams({
        action: 'query',
        format: 'json',
        formatversion: '1',
        generator: 'search',
        // filetype:bitmap keeps SVGs and PDFs out; namespace 6 is File:.
        gsrsearch: `filetype:bitmap ${query}`,
        gsrnamespace: '6',
        gsrlimit: String(limit),
        prop: 'imageinfo',
        iiprop: 'url|size|extmetadata',
        iiurlwidth: String(IMAGE_MAX_EDGE_PX),
      })}`;
      const body = await getJson<{ query?: { pages?: Record<string, CommonsPage> } }>('wikimedia', url, options);
      const pages = body.query?.pages ? Object.values(body.query.pages) : [];

      return pages.flatMap((page) => {
        const info = page.imageinfo?.[0];
        if (!info) return [];
        const chosen = info.thumburl ?? info.url;
        if (!chosen || !URL.canParse(chosen) || new URL(chosen).hostname.toLowerCase() !== allowedHost) return [];
        const license = plainText(info.extmetadata?.LicenseShortName?.value);
        const artist = plainText(info.extmetadata?.Artist?.value);
        const usingThumb = chosen === info.thumburl;
        const candidate: ImageCandidate = {
          provider: 'wikimedia',
          thumb_url: chosen,
          full_url: chosen,
          width: (usingThumb ? info.thumbwidth : info.width) ?? null,
          height: (usingThumb ? info.thumbheight : info.height) ?? null,
          license,
          attribution: artist && license ? `${artist} (${license})` : (artist ?? license),
          // Titles arrive as "File:Tomato soup.jpg".
          title: page.title?.replace(/^File:/, '') ?? null,
        };
        return [candidate];
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && pnpm vitest run test/images-wikimedia.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/images/providers/wikimedia.ts server/test/images-wikimedia.test.ts
git commit -m "server: Wikimedia Commons image search provider"
```

---

## Task 8: TheMealDB provider

**Files:**
- Create: `server/src/images/providers/themealdb.ts`
- Test: `server/test/images-themealdb.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/test/images-themealdb.test.ts
import { describe, expect, it } from 'vitest';
import { createMealDbProvider } from '../src/images/providers/themealdb';
import { ProviderUnavailableError } from '../src/images/providers/types';

/** Trimmed from a live themealdb.com/api/json/v1/1/search.php?s=soup response. */
const RESPONSE = {
  meals: [
    { idMeal: '52908', strMeal: 'Tomato Soup', strMealThumb: 'https://www.themealdb.com/images/media/meals/abc123.jpg' },
    { idMeal: '52909', strMeal: 'Noodle Soup', strMealThumb: 'https://www.themealdb.com/images/media/meals/def456.jpg' },
  ],
};

function stubFetch(handler: (url: string) => Response) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return handler(String(input));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const options = (fetch: typeof globalThis.fetch) => ({
  baseUrl: 'https://www.themealdb.com',
  timeoutMs: 1000,
  userAgent: 'CarbBook/test',
  fetch,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('themealdb provider', () => {
  it('maps meals, uses the /preview thumbnail, and honours the limit', async () => {
    const { fetch, calls } = stubFetch(() => json(RESPONSE));
    const candidates = await createMealDbProvider(options(fetch)).search('soup', 1);

    expect(calls[0]).toBe('https://www.themealdb.com/api/json/v1/1/search.php?s=soup');
    expect(candidates).toEqual([
      {
        provider: 'themealdb',
        thumb_url: 'https://www.themealdb.com/images/media/meals/abc123.jpg/preview',
        full_url: 'https://www.themealdb.com/images/media/meals/abc123.jpg',
        width: null,
        height: null,
        license: null,
        attribution: 'TheMealDB',
        title: 'Tomato Soup',
      },
    ]);
  });

  it('treats a null meals field as no results (how TheMealDB reports a miss)', async () => {
    const { fetch } = stubFetch(() => json({ meals: null }));
    expect(await createMealDbProvider(options(fetch)).search('zzzz', 10)).toEqual([]);
  });

  it('drops a meal with no thumbnail or an off-host one', async () => {
    const { fetch } = stubFetch(() =>
      json({
        meals: [
          { idMeal: '1', strMeal: 'A', strMealThumb: '' },
          { idMeal: '2', strMeal: 'B', strMealThumb: 'https://evil.test/x.jpg' },
        ],
      }),
    );
    expect(await createMealDbProvider(options(fetch)).search('x', 10)).toEqual([]);
  });

  it('throws ProviderUnavailableError on a 503', async () => {
    const { fetch } = stubFetch(() => new Response('down', { status: 503 }));
    await expect(createMealDbProvider(options(fetch)).search('x', 10)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm vitest run test/images-themealdb.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// server/src/images/providers/themealdb.ts
import { PROVIDER_HOSTS } from '../urlguard';
import { getJson, type ImageCandidate, type ImageSearchProvider, type ProviderOptions } from './types';

/**
 * TheMealDB: a small catalogue of prepared dishes with good photos, free on the public test
 * key `1`. High relevance when it hits, nothing when it misses — a miss is reported as
 * `{"meals": null}`, not an empty array. Appending /preview to a thumb yields a small version.
 *
 * The API has no licence field; images are the site's own, credited as "TheMealDB".
 */
interface MealDbMeal {
  idMeal?: string;
  strMeal?: string;
  strMealThumb?: string;
}

export function createMealDbProvider(options: ProviderOptions): ImageSearchProvider {
  const allowedHost = PROVIDER_HOSTS.themealdb[0]!;
  return {
    name: 'themealdb',
    async search(query, limit) {
      const url = `${options.baseUrl}/api/json/v1/1/search.php?s=${encodeURIComponent(query)}`;
      const body = await getJson<{ meals?: MealDbMeal[] | null }>('themealdb', url, options);
      const meals = Array.isArray(body.meals) ? body.meals : [];

      return meals
        .flatMap((meal) => {
          const thumb = meal.strMealThumb?.trim();
          if (!thumb || !URL.canParse(thumb) || new URL(thumb).hostname.toLowerCase() !== allowedHost) return [];
          const candidate: ImageCandidate = {
            provider: 'themealdb',
            thumb_url: `${thumb}/preview`,
            full_url: thumb,
            width: null,
            height: null,
            license: null,
            attribution: 'TheMealDB',
            title: meal.strMeal ?? null,
          };
          return [candidate];
        })
        // The API has no page_size, so the limit is applied here.
        .slice(0, limit);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && pnpm vitest run test/images-themealdb.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/images/providers/themealdb.ts server/test/images-themealdb.test.ts
git commit -m "server: TheMealDB image search provider"
```

---

## Task 9: Search aggregation

**Files:**
- Create: `server/src/images/search.ts`
- Test: `server/test/images-search.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/test/images-search.test.ts
import { describe, expect, it } from 'vitest';
import { searchImages } from '../src/images/search';
import { ProviderUnavailableError, type ImageCandidate, type ImageSearchProvider } from '../src/images/providers/types';

const candidate = (provider: ImageCandidate['provider'], n: number): ImageCandidate => ({
  provider,
  thumb_url: `https://example.test/${provider}/${n}/thumb`,
  full_url: `https://example.test/${provider}/${n}`,
  width: 800,
  height: 600,
  license: null,
  attribution: null,
  title: `${provider} ${n}`,
});

const working = (name: ImageCandidate['provider'], count: number): ImageSearchProvider => ({
  name,
  search: async (_query, limit) => Array.from({ length: Math.min(count, limit) }, (_, i) => candidate(name, i)),
});

const broken = (name: ImageCandidate['provider']): ImageSearchProvider => ({
  name,
  search: async () => {
    throw new ProviderUnavailableError(name, 'responded 429');
  },
});

describe('searchImages', () => {
  it('interleaves providers so one cannot crowd out the others', async () => {
    const result = await searchImages([working('openverse', 3), working('wikimedia', 3)], 'soup', 6);
    expect(result.candidates.map((c) => c.provider)).toEqual([
      'openverse', 'wikimedia', 'openverse', 'wikimedia', 'openverse', 'wikimedia',
    ]);
    expect(result.providers_failed).toEqual([]);
  });

  it('names failed providers and still returns what arrived', async () => {
    const result = await searchImages([working('openverse', 2), broken('wikimedia')], 'soup', 10);
    expect(result.candidates).toHaveLength(2);
    expect(result.providers_failed).toEqual(['wikimedia']);
  });

  it('returns an empty list, not an error, when every provider fails', async () => {
    const result = await searchImages([broken('openverse'), broken('wikimedia')], 'soup', 10);
    expect(result.candidates).toEqual([]);
    expect(result.providers_failed).toEqual(['openverse', 'wikimedia']);
  });

  it('dedups by full_url, keeping the first occurrence', async () => {
    const same: ImageSearchProvider = { name: 'themealdb', search: async () => [candidate('openverse', 0)] };
    const result = await searchImages([working('openverse', 1), same], 'soup', 10);
    expect(result.candidates).toHaveLength(1);
  });

  it('honours the overall limit and caps each provider to its fair share', async () => {
    const result = await searchImages([working('openverse', 50), working('wikimedia', 50)], 'soup', 4);
    expect(result.candidates).toHaveLength(4);
    expect(result.candidates.filter((c) => c.provider === 'openverse')).toHaveLength(2);
  });

  it('returns nothing for a blank query without calling any provider', async () => {
    let called = false;
    const spy: ImageSearchProvider = {
      name: 'openverse',
      search: async () => {
        called = true;
        return [];
      },
    };
    const result = await searchImages([spy], '   ', 10);
    expect(result.candidates).toEqual([]);
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm vitest run test/images-search.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// server/src/images/search.ts
import type { ImageCandidate, ImageSearchProvider } from './providers/types';

export interface ImageSearchResult {
  candidates: ImageCandidate[];
  /** Providers that timed out, errored or rate-limited. The UI says so instead of silently showing less. */
  providers_failed: string[];
}

/**
 * Fan out to every provider in parallel and interleave the results.
 *
 * Search is a convenience and must never block saving a food, so a provider failure is data
 * (`providers_failed`), not an error: every provider failing still resolves with an empty list.
 */
export async function searchImages(
  providers: ImageSearchProvider[],
  query: string,
  limit: number,
): Promise<ImageSearchResult> {
  const trimmed = query.trim();
  if (trimmed === '' || providers.length === 0 || limit <= 0) return { candidates: [], providers_failed: [] };

  // Fair share, rounded up, so a single provider cannot fill the grid on its own.
  const perProvider = Math.max(1, Math.ceil(limit / providers.length));
  const settled = await Promise.allSettled(providers.map((provider) => provider.search(trimmed, perProvider)));

  const lists: ImageCandidate[][] = [];
  const failed: string[] = [];
  settled.forEach((outcome, index) => {
    const provider = providers[index]!;
    if (outcome.status === 'fulfilled') lists.push(outcome.value.slice(0, perProvider));
    else failed.push(provider.name);
  });

  const candidates: ImageCandidate[] = [];
  const seen = new Set<string>();
  const deepest = Math.max(0, ...lists.map((list) => list.length));
  for (let round = 0; round < deepest && candidates.length < limit; round += 1) {
    for (const list of lists) {
      if (candidates.length >= limit) break;
      const candidate = list[round];
      if (!candidate || seen.has(candidate.full_url)) continue;
      seen.add(candidate.full_url);
      candidates.push(candidate);
    }
  }

  return { candidates, providers_failed: failed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && pnpm vitest run test/images-search.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/images/search.ts server/test/images-search.test.ts
git commit -m "server: image search fan-out with per-provider failure reporting"
```

---

## Task 10: Wire providers, the store and the fetch client into `deps`

Everything the routes need is injected, exactly like `off` and `bg`, so route tests never touch the network or the filesystem.

**Files:**
- Modify: `server/src/context.ts` (the `AppDeps` interface)
- Modify: `server/src/app.ts:27-43` (`defaultDeps`)
- Modify: `server/src/config.ts`
- Test: covered by Task 11-13 route tests; no separate test for wiring.

- [ ] **Step 1: Add the config keys**

In `server/src/config.ts`, inside `loadConfig`, after `offUserAgent`:

```ts
    openverseBaseUrl: absoluteUrl(env, 'OPENVERSE_BASE_URL', 'https://api.openverse.org'),
    wikimediaBaseUrl: absoluteUrl(env, 'WIKIMEDIA_BASE_URL', 'https://commons.wikimedia.org'),
    mealDbBaseUrl: absoluteUrl(env, 'MEALDB_BASE_URL', 'https://www.themealdb.com'),
```

Add the three as `string` to the `Config` interface.

- [ ] **Step 2: Extend `AppDeps`**

In `server/src/context.ts`, add to `AppDeps`:

```ts
  /** Image byte store; see src/images/store.ts. */
  images: ImageStore;
  /** Search providers, in the order they are offered. */
  imageProviders: ImageSearchProvider[];
  /** Fetches an already-guarded URL for adoption. Separate from provider search so tests can stub it. */
  fetchImage: (url: string) => Promise<Buffer>;
```

with the matching imports:

```ts
import type { ImageStore } from './images/store';
import type { ImageSearchProvider } from './images/providers/types';
```

- [ ] **Step 3: Build them in `defaultDeps`**

In `server/src/app.ts`, inside `defaultDeps`, after the `off:` entry:

```ts
    images: createImageStore({ imageDir: config.imageDir }),
    imageProviders: [
      createOpenverseProvider(providerOptions(config, config.openverseBaseUrl)),
      createWikimediaProvider(providerOptions(config, config.wikimediaBaseUrl)),
      createMealDbProvider(providerOptions(config, config.mealDbBaseUrl)),
    ],
    fetchImage: (url) => fetchImageBytes(url, config.httpTimeoutMs, config.offUserAgent),
```

and above `defaultDeps`:

```ts
/** Providers share the timeout and user-agent knobs with the existing OFF and BG clients. */
function providerOptions(config: Config, baseUrl: string): ProviderOptions {
  return { baseUrl, timeoutMs: config.httpTimeoutMs, userAgent: config.offUserAgent, fetch: globalThis.fetch };
}
```

- [ ] **Step 4: Write the download helper with its size cap**

```ts
// server/src/images/fetch.ts
import { IMAGE_MAX_DOWNLOAD_BYTES } from '@carbbook/core';
import { ImageRejectedError } from './store';

/**
 * Download bytes for adoption. The caller MUST have passed the URL through assertAdoptableUrl
 * first — this function does no validation of its own.
 *
 * Redirects are followed at most twice and re-validated by the caller on each hop, and the body
 * is read in chunks so a hostile or misconfigured host cannot stream forever: the cap is enforced
 * as bytes arrive, not from a content-length header the server may have lied about.
 */
export async function fetchImageBytes(url: string, timeoutMs: number, userAgent: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { accept: 'image/*', 'user-agent': userAgent },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  });
  if (response.status >= 300 && response.status < 400) {
    throw new ImageRejectedError('image URL redirected; adopt the final URL instead');
  }
  if (!response.ok) throw new ImageRejectedError(`image host responded ${response.status}`);
  if (!response.body) throw new ImageRejectedError('image response had no body');

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > IMAGE_MAX_DOWNLOAD_BYTES) throw new ImageRejectedError('image is too large to adopt');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
```

Note the deliberate simplification: `redirect: 'manual'` plus a rejection, rather than the spec's "follow at most twice, re-validating each hop". Following redirects safely means re-running the guard per hop, and none of the four allowlisted hosts needs it for the URLs we adopt (Wikimedia `thumburl`, Openverse `/thumb/`, TheMealDB thumbs, OFF images are all final URLs). Rejecting is the smaller, safer surface. **If a provider turns out to redirect in practice, revisit this rather than switching to `redirect: 'follow'`,** which would bypass the guard entirely.

- [ ] **Step 5: Typecheck**

Run: `cd server && pnpm typecheck`
Expected: PASS. Every existing test that calls `buildApp` with a partial `deps` still compiles because `deps` is `Partial<AppDeps>`.

- [ ] **Step 6: Commit**

```bash
git add server/src/config.ts server/src/context.ts server/src/app.ts server/src/images/fetch.ts
git commit -m "server: wire image store, providers and fetch into deps"
```

---

## Task 11: `GET /api/images/:hash` and `GET /api/images/search`

**Files:**
- Create: `server/src/routes/images.ts`
- Modify: `server/src/app.ts` (register the routes inside the authenticated scope)
- Test: `server/test/images-routes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/test/images-routes.test.ts
import { describe, expect, it } from 'vitest';
import { buildTestApp, login } from './helpers';
import type { ImageCandidate, ImageSearchProvider } from '../src/images/providers/types';
import { ProviderUnavailableError } from '../src/images/providers/types';
import type { ImageStore } from '../src/images/store';

const HASH = 'a'.repeat(64);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

const candidate: ImageCandidate = {
  provider: 'openverse',
  thumb_url: 'https://api.openverse.org/v1/images/x/thumb/',
  full_url: 'https://api.openverse.org/v1/images/x/thumb/',
  width: 800,
  height: 600,
  license: 'CC-BY-4.0',
  attribution: 'Someone (CC-BY-4.0)',
  title: 'Soup',
};

const provider = (name: ImageCandidate['provider'], results: ImageCandidate[]): ImageSearchProvider => ({
  name,
  search: async () => results,
});

/**
 * A complete ImageStore whose parts can be overridden one at a time. `read` returns a Buffer
 * rather than a stream because reply.send accepts either, and a Buffer keeps the test synchronous.
 */
function stubStore(overrides: Partial<ImageStore> = {}): ImageStore {
  return {
    has: async () => true,
    read: () => Buffer.from(JPEG) as unknown as ReturnType<ImageStore['read']>,
    pathFor: () => '/tmp/x.jpg',
    put: async () => {
      throw new Error('put is not exercised by these tests');
    },
    remove: async () => {},
    ...overrides,
  };
}

describe('GET /api/images/:hash', () => {
  it('streams stored bytes with an immutable cache header', async () => {
    const app = await buildTestApp({ deps: { images: stubStore({ has: async (hash) => hash === HASH }) } });
    const token = await login(app);
    const response = await app.inject({ method: 'GET', url: `/api/images/${HASH}`, headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(response.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it('404s an unknown hash and rejects a malformed one without touching the store', async () => {
    let touched = false;
    const app = await buildTestApp({
      deps: {
        images: stubStore({
          has: async () => {
            touched = true;
            return false;
          },
        }),
      },
    });
    const token = await login(app);
    const headers = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: 'GET', url: `/api/images/${'b'.repeat(64)}`, headers })).statusCode).toBe(404);
    expect(touched).toBe(true);

    touched = false;
    expect((await app.inject({ method: 'GET', url: '/api/images/../../etc/passwd', headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/images/${'A'.repeat(64)}`, headers })).statusCode).toBe(400);
    expect(touched).toBe(false);
  });

  it('requires authentication', async () => {
    const app = await buildTestApp();
    expect((await app.inject({ method: 'GET', url: `/api/images/${HASH}` })).statusCode).toBe(401);
  });
});

describe('GET /api/images/search', () => {
  it('returns interleaved candidates', async () => {
    const app = await buildTestApp({ deps: { imageProviders: [provider('openverse', [candidate])] } });
    const token = await login(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/images/search?q=tomato%20soup',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ candidates: [candidate], providers_failed: [] });
  });

  it('reports a failed provider with 200', async () => {
    const broken: ImageSearchProvider = {
      name: 'wikimedia',
      search: async () => {
        throw new ProviderUnavailableError('wikimedia', 'responded 429');
      },
    };
    const app = await buildTestApp({ deps: { imageProviders: [provider('openverse', [candidate]), broken] } });
    const token = await login(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/images/search?q=soup',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().providers_failed).toEqual(['wikimedia']);
  });

  it('rejects a missing or over-long query and clamps limit', async () => {
    const app = await buildTestApp({ deps: { imageProviders: [provider('openverse', [candidate])] } });
    const token = await login(app);
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'GET', url: '/api/images/search', headers })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/images/search?q=${'x'.repeat(201)}`, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/images/search?q=soup&limit=99', headers })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Check the app-test helper names**

Run: `grep -rn "export async function buildTestApp\|export async function login" server/test/`
If they differ, match whatever `server/test/barcode.test.ts` uses and adjust Step 1. Do not add a parallel helper.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && pnpm vitest run test/images-routes.test.ts`
Expected: FAIL — 404 on every route, because `imageRoutes` does not exist.

- [ ] **Step 4: Write the routes**

```ts
// server/src/routes/images.ts
import type { FastifyInstance } from 'fastify';
import { IMAGE_HASH_PATTERN } from '@carbbook/core';
import type { AppContext } from '../context';
import { ApiError } from '../errors';
import { searchImages } from '../images/search';

export async function imageRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Params: { hash: string } }>('/api/images/:hash', async (request, reply) => {
    const { hash } = request.params;
    // Validated before the store is asked anything: this is what keeps a path like
    // "../../etc/passwd" from ever reaching the filesystem.
    if (!IMAGE_HASH_PATTERN.test(hash)) throw new ApiError(400, 'invalid_hash', 'Not an image hash');
    if (!(await ctx.deps.images.has(hash))) throw new ApiError(404, 'not_found', 'No image with that hash');

    // The URL is the content hash, so the bytes can never change: cache forever.
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    reply.type('image/jpeg');
    return reply.send(ctx.deps.images.read(hash));
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/images/search',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['q'],
          additionalProperties: false,
          properties: {
            q: { type: 'string', minLength: 1, maxLength: 200 },
            limit: { type: 'integer', minimum: 1, maximum: 48 },
          },
        },
      },
    },
    async (request) => {
      const { q, limit } = request.query as { q: string; limit?: number };
      return searchImages(ctx.deps.imageProviders, q, limit ?? 24);
    },
  );
}
```

- [ ] **Step 5: Register inside the authenticated scope**

In `server/src/app.ts`, in the `app.register(async (api) => {...})` block, after `barcodeRoutes`:

```ts
    await api.register(imageRoutes, ctx);
```

Route order matters: Fastify's radix router distinguishes the static `/api/images/search` from the parametric `/api/images/:hash`, so `search` is never treated as a hash. The `q`-required schema means a bare `/api/images/search` is a 400, not a 404.

- [ ] **Step 6: Run the tests**

Run: `cd server && pnpm vitest run test/images-routes.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/images.ts server/src/app.ts server/test/images-routes.test.ts
git commit -m "server: serve and search image routes"
```

---

## Task 12: `POST /api/images/adopt`

The SSRF tests here are the ones that matter most. Write them before the route, and do not weaken them later to make an implementation detail pass.

**Files:**
- Modify: `server/src/routes/images.ts`
- Test: `server/test/images-adopt.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/test/images-adopt.test.ts
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { buildTestApp, login } from './helpers';

const OK_URL = 'https://api.openverse.org/v1/images/x/thumb/';

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 400, height: 300, channels: 3, background: '#c00' } }).jpeg().toBuffer();
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    url: OK_URL,
    source: 'openverse',
    source_url: OK_URL,
    license: 'CC-BY-4.0',
    attribution: 'Someone (CC-BY-4.0)',
    ...overrides,
  };
}

async function appWith(fetchImage: (url: string) => Promise<Buffer>) {
  return buildTestApp({ deps: { fetchImage } });
}

describe('POST /api/images/adopt', () => {
  it('stores the bytes and returns the image row, without writing any food', async () => {
    const bytes = await jpeg();
    const app = await appWith(async () => bytes);
    const token = await login(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/images/adopt',
      headers: { authorization: `Bearer ${token}` },
      payload: body(),
    });
    expect(response.statusCode).toBe(200);
    const image = response.json();
    expect(image.id).toMatch(/^[0-9a-f]{64}$/);
    expect(image).toMatchObject({ mime: 'image/jpeg', source: 'openverse', license: 'CC-BY-4.0', width: 400, height: 300 });
    expect(image.updated_by).toBeTypeOf('string');
  });

  it('is a no-op that returns the existing row when the hash already exists', async () => {
    const bytes = await jpeg();
    const app = await appWith(async () => bytes);
    const token = await login(app);
    const send = () =>
      app.inject({ method: 'POST', url: '/api/images/adopt', headers: { authorization: `Bearer ${token}` }, payload: body() });
    const first = await send();
    const second = await send();
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
  });

  it('rejects every unsafe URL shape', async () => {
    const bytes = await jpeg();
    const app = await appWith(async () => bytes);
    const token = await login(app);
    const headers = { authorization: `Bearer ${token}` };
    const unsafe = [
      { url: 'http://api.openverse.org/x.jpg' },
      { url: 'https://user:pass@api.openverse.org/x.jpg' },
      { url: 'https://api.openverse.org:8443/x.jpg' },
      { url: 'https://127.0.0.1/x.jpg' },
      { url: 'https://192.168.1.210/x.jpg' },
      { url: 'https://169.254.169.254/latest/meta-data/' },
      { url: 'https://api.openverse.org.evil.test/x.jpg' },
      { url: 'file:///etc/passwd' },
      // right shape, wrong provider for that host
      { url: 'https://upload.wikimedia.org/x.jpg', source: 'openverse' },
    ];
    for (const overrides of unsafe) {
      const response = await app.inject({ method: 'POST', url: '/api/images/adopt', headers, payload: body(overrides) });
      expect(response.statusCode, JSON.stringify(overrides)).toBe(400);
    }
  });

  it('rejects a non-image body even when the host claims image/jpeg', async () => {
    const app = await appWith(async () => Buffer.from('<!doctype html><html>404 not found</html>'));
    const token = await login(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/images/adopt',
      headers: { authorization: `Bearer ${token}` },
      payload: body(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('image_rejected');
  });

  it('surfaces a fetch failure as a 502, not a 500', async () => {
    const app = await appWith(async () => {
      throw new Error('socket hang up');
    });
    const token = await login(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/images/adopt',
      headers: { authorization: `Bearer ${token}` },
      payload: body(),
    });
    expect(response.statusCode).toBe(502);
  });

  it('rejects an unknown source and extra properties', async () => {
    const bytes = await jpeg();
    const app = await appWith(async () => bytes);
    const token = await login(app);
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'POST', url: '/api/images/adopt', headers, payload: body({ source: 'pinterest' }) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/images/adopt', headers, payload: body({ source: 'upload' }) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/images/adopt', headers, payload: { ...body(), sneaky: 1 } })).statusCode).toBe(400);
  });

  it('requires application/json for a cookie session (CSRF guard)', async () => {
    const bytes = await jpeg();
    const app = await appWith(async () => bytes);
    const response = await app.inject({
      method: 'POST',
      url: '/api/images/adopt',
      headers: { 'content-type': 'text/plain' },
      payload: 'url=whatever',
    });
    expect(response.statusCode).toBe(415);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm vitest run test/images-adopt.test.ts`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Add the route**

Append inside `imageRoutes` in `server/src/routes/images.ts`:

```ts
  const ADOPT_SOURCES = ['off', 'openverse', 'wikimedia', 'themealdb'] as const;

  app.post<{ Body: { url: string; source: AdoptProvider; source_url?: string; license?: string; attribution?: string } }>(
    '/api/images/adopt',
    {
      schema: {
        body: {
          type: 'object',
          required: ['url', 'source'],
          additionalProperties: false,
          properties: {
            url: { type: 'string', minLength: 1, maxLength: 2048 },
            // `upload` is deliberately absent: that is the other route.
            source: { type: 'string', enum: ADOPT_SOURCES },
            source_url: { type: 'string', maxLength: 2048 },
            license: { type: 'string', maxLength: 120 },
            attribution: { type: 'string', maxLength: IMAGE_ATTRIBUTION_MAX },
          },
        },
      },
    },
    async (request) => {
      const { url, source, source_url, license, attribution } = request.body;

      // Gate one: the URL must be https, credential-free, on the default port, on a host this
      // provider actually serves bytes from, and resolve only to public addresses.
      try {
        await assertAdoptableUrl(url, source);
      } catch (error) {
        if (error instanceof UrlRejectedError) throw new ApiError(400, 'url_rejected', error.message);
        throw error;
      }

      let bytes: Buffer;
      try {
        bytes = await ctx.deps.fetchImage(url);
      } catch (error) {
        // Bad content is the client's problem; an unreachable host is the upstream's.
        if (error instanceof ImageRejectedError) throw new ApiError(400, 'image_rejected', error.message);
        throw new ApiError(502, 'image_unavailable', `Could not fetch the image: ${(error as Error).message}`);
      }

      // Gate two: the bytes must really be an image, whatever the host's content-type said.
      let stored;
      try {
        stored = await ctx.deps.images.put(bytes);
      } catch (error) {
        if (error instanceof ImageRejectedError) throw new ApiError(400, 'image_rejected', error.message);
        throw error;
      }

      return upsertImageRow(ctx, stored, {
        source,
        source_url: source_url ?? url,
        license: license ?? null,
        attribution: attribution ?? null,
      });
    },
  );
```

- [ ] **Step 4: Write the shared row upsert**

Both `adopt` and `upload` need it. Add to `server/src/routes/images.ts`, above `imageRoutes`:

```ts
/**
 * Insert or refresh the `image` metadata row for stored bytes.
 *
 * This writes only the `image` table. The client sets `food.image_id` / `meal.image_id` through
 * its ordinary sync push, so that edit participates in last-write-wins and offline queueing like
 * every other change — the server never writes a food or meal row from an image route.
 *
 * Re-adopting an existing hash is a no-op that returns the stored row: the bytes are identical by
 * definition, and overwriting the metadata would discard the attribution captured the first time.
 */
function upsertImageRow(
  ctx: AppContext,
  stored: StoredImage,
  meta: { source: ImageSource; source_url: string | null; license: string | null; attribution: string | null },
): ImageRow {
  const existing = ctx.db.prepare('SELECT * FROM image WHERE id = ?').get(stored.id) as ImageRow | undefined;
  if (existing && existing.deleted === 0) return existing;

  const record = {
    id: stored.id,
    mime: stored.mime,
    width: stored.width,
    height: stored.height,
    source: meta.source,
    source_url: meta.source_url,
    license: meta.license,
    attribution: meta.attribution,
    updated_at: ctx.deps.now(),
    updated_by: 'server-images',
    deleted: 0,
  };
  // Through the sync path so validation, server_seq assignment and last-write-wins are identical
  // to a device push, and the new row reaches every client on its next pull.
  const [result] = applyPush(ctx.db, 'owner', [{ table: 'image', record }]);
  if (result?.status !== 'accepted') {
    throw new ApiError(500, 'image_row_rejected', `Image metadata rejected: ${result?.message ?? 'unknown reason'}`);
  }
  return ctx.db.prepare('SELECT * FROM image WHERE id = ?').get(stored.id) as ImageRow;
}
```

with `type ImageRow = ImageData & { updated_at: number; updated_by: string; deleted: number; server_seq: number }` declared above it, and imports for `applyPush`, `assertAdoptableUrl`, `UrlRejectedError`, `type AdoptProvider`, `ImageRejectedError`, `type StoredImage`, `IMAGE_ATTRIBUTION_MAX`, `type ImageData`, `type ImageSource`.

- [ ] **Step 5: Run the tests**

Run: `cd server && pnpm vitest run test/images-adopt.test.ts`
Expected: PASS (7 tests). The unsafe-URL cases pass without any network stub because the guard rejects before `fetchImage` is called.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/images.ts server/test/images-adopt.test.ts
git commit -m "server: adopt provider images behind the SSRF guard"
```

---

## Task 13: `POST /api/images/upload`

**Files:**
- Modify: `server/src/routes/images.ts`
- Test: `server/test/images-upload.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/test/images-upload.test.ts
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { buildTestApp, login } from './helpers';

const png = () => sharp({ create: { width: 1200, height: 900, channels: 3, background: '#0a0' } }).png().toBuffer();

describe('POST /api/images/upload', () => {
  it('accepts base64 bytes, re-encodes to a capped JPEG and records source=upload', async () => {
    const app = await buildTestApp();
    const token = await login(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/images/upload',
      headers: { authorization: `Bearer ${token}` },
      payload: { data_base64: (await png()).toString('base64'), mime: 'image/png' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mime: 'image/jpeg',
      source: 'upload',
      source_url: null,
      license: null,
      attribution: null,
      width: 800,
      height: 600,
    });
  });

  it('rejects base64 that does not decode to an image', async () => {
    const app = await buildTestApp();
    const token = await login(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/images/upload',
      headers: { authorization: `Bearer ${token}` },
      payload: { data_base64: Buffer.from('just text').toString('base64'), mime: 'image/jpeg' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('image_rejected');
  });

  it('rejects a missing field, an unsupported mime and extra properties', async () => {
    const app = await buildTestApp();
    const token = await login(app);
    const headers = { authorization: `Bearer ${token}` };
    const cases = [
      { mime: 'image/jpeg' },
      { data_base64: 'aGk=', mime: 'image/tiff' },
      { data_base64: 'aGk=', mime: 'image/jpeg', extra: true },
    ];
    for (const payload of cases) {
      expect((await app.inject({ method: 'POST', url: '/api/images/upload', headers, payload })).statusCode).toBe(400);
    }
  });

  it('dedups: uploading the same photo twice yields one id', async () => {
    const app = await buildTestApp();
    const token = await login(app);
    const data_base64 = (await png()).toString('base64');
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/images/upload',
        headers: { authorization: `Bearer ${token}` },
        payload: { data_base64, mime: 'image/png' },
      });
    expect((await send()).json().id).toBe((await send()).json().id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm vitest run test/images-upload.test.ts`
Expected: FAIL — 404.

- [ ] **Step 3: Add the route**

Append inside `imageRoutes`:

```ts
  /**
   * Base64 JSON rather than multipart, for two reasons: it needs no @fastify/multipart, and it
   * satisfies the CSRF guard (src/csrf.ts:29-38), which requires application/json on any
   * cookie-authenticated mutating request — a multipart upload from the web client would be a 415.
   *
   * The global 5MB body limit (src/app.ts:57) bounds this; base64 inflates by 4/3, so the ceiling
   * is ~3.7MB of image. Clients downscale first so a 12MP photo never reaches it, but that is an
   * optimisation, not a trust boundary: the bytes are re-encoded here regardless.
   */
  app.post<{ Body: { data_base64: string; mime: string } }>(
    '/api/images/upload',
    {
      schema: {
        body: {
          type: 'object',
          required: ['data_base64', 'mime'],
          additionalProperties: false,
          properties: {
            data_base64: { type: 'string', minLength: 1 },
            mime: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/heic', 'image/webp'] },
          },
        },
      },
    },
    async (request) => {
      const bytes = Buffer.from(request.body.data_base64, 'base64');
      if (bytes.byteLength === 0) throw new ApiError(400, 'image_rejected', 'data_base64 did not decode to any bytes');

      let stored;
      try {
        stored = await ctx.deps.images.put(bytes);
      } catch (error) {
        if (error instanceof ImageRejectedError) throw new ApiError(400, 'image_rejected', error.message);
        throw error;
      }
      // The declared mime is advisory only; sniffing and re-encoding decide what is stored.
      return upsertImageRow(ctx, stored, { source: 'upload', source_url: null, license: null, attribution: null });
    },
  );
```

- [ ] **Step 4: Run the tests**

Run: `cd server && pnpm vitest run test/images-upload.test.ts && pnpm test`
Expected: PASS, whole server suite green.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/images.ts server/test/images-upload.test.ts
git commit -m "server: upload a user photo as base64 JSON"
```

---

## Task 14: OFF product photos on a barcode scan

**Files:**
- Modify: `server/src/off/client.ts:2` (`OFF_FIELDS`, `OffProduct`), `server/src/off/normalize.ts:32-57`, `server/src/routes/barcode.ts:41-51`
- Test: `server/test/off.test.ts` (extend), `server/test/barcode.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `server/test/off.test.ts`:

```ts
describe('OFF image candidate', () => {
  it('requests the image fields', () => {
    expect(OFF_FIELDS).toContain('image_front_url');
    expect(OFF_FIELDS).toContain('image_front_small_url');
  });

  it('maps an OFF photo to a candidate on an allowlisted host', () => {
    const candidate = offImageCandidate({
      ...THAI_KITCHEN.product,
      code: THAI_KITCHEN.code,
      image_front_url: 'https://images.openfoodfacts.org/images/products/073/762/806/4502/front_en.4.400.jpg',
      image_front_small_url: 'https://images.openfoodfacts.org/images/products/073/762/806/4502/front_en.4.200.jpg',
    });
    expect(candidate).toEqual({
      provider: 'off',
      thumb_url: 'https://images.openfoodfacts.org/images/products/073/762/806/4502/front_en.4.200.jpg',
      full_url: 'https://images.openfoodfacts.org/images/products/073/762/806/4502/front_en.4.400.jpg',
      width: null,
      height: null,
      license: 'CC-BY-SA-3.0',
      attribution: 'Open Food Facts',
      title: THAI_KITCHEN.product.product_name,
    });
  });

  it('returns null when OFF has no photo or the URL is off-host', () => {
    expect(offImageCandidate({ code: '1' })).toBeNull();
    expect(offImageCandidate({ code: '1', image_front_url: 'https://evil.test/x.jpg' })).toBeNull();
  });
});
```

Add to `server/test/barcode.test.ts`, in the known/draft cases:

```ts
  it('returns the OFF photo alongside a draft', async () => {
    // Build the app with an off client stub whose product carries image_front_url, then:
    expect(response.json().image_candidate).toMatchObject({ provider: 'off' });
  });

  it('omits image_candidate when OFF has no photo', async () => {
    expect(response.json().image_candidate).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && pnpm vitest run test/off.test.ts test/barcode.test.ts`
Expected: FAIL — `OFF_FIELDS` lacks the image fields and `offImageCandidate` does not exist.

- [ ] **Step 3: Implement**

`server/src/off/client.ts` — extend the field list and the type:

```ts
export const OFF_FIELDS =
  'code,product_name,brands,serving_size,serving_quantity,serving_quantity_unit,nutriments,image_front_url,image_front_small_url';
```

```ts
export interface OffProduct {
  // ...existing fields...
  /** Product photo, when OFF has one. Always on images.openfoodfacts.org. */
  image_front_url?: string;
  image_front_small_url?: string;
}
```

`server/src/off/normalize.ts` — add:

```ts
import { PROVIDER_HOSTS } from '../images/urlguard';
import type { ImageCandidate } from '../images/providers/types';

/**
 * OFF photos are contributed under CC-BY-SA; the credit line is the project itself.
 * Returns null unless the URL is on an OFF-owned host, so an unadoptable candidate never
 * reaches the scan-confirm screen.
 */
export function offImageCandidate(product: OffProduct): ImageCandidate | null {
  const full = product.image_front_url?.trim();
  if (!full || !URL.canParse(full)) return null;
  if (!PROVIDER_HOSTS.off.includes(new URL(full).hostname.toLowerCase())) return null;
  const small = product.image_front_small_url?.trim();
  return {
    provider: 'off',
    thumb_url: small && URL.canParse(small) ? small : full,
    full_url: full,
    width: null,
    height: null,
    license: 'CC-BY-SA-3.0',
    attribution: 'Open Food Facts',
    title: product.product_name ?? null,
  };
}
```

`server/src/routes/barcode.ts` — include it in the response when present:

```ts
      const image_candidate = offImageCandidate(product);
      return { status: 'draft', draft, ...(image_candidate ? { image_candidate } : {}) };
```

- [ ] **Step 4: Run the tests**

Run: `cd server && pnpm vitest run test/off.test.ts test/barcode.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/off/client.ts server/src/off/normalize.ts server/src/routes/barcode.ts server/test/off.test.ts server/test/barcode.test.ts
git commit -m "server: offer the Open Food Facts product photo on a scan"
```

---

## Task 15: `carbbook images gc`

Manual, never automatic, and destructive only behind `--delete`. Per the spec, only unreferenced hashes older than 30 days are eligible, because another device may hold a reference it has not pushed yet.

**Files:**
- Create: `server/src/images/gc.ts`
- Modify: `server/src/cli.ts:20-22` (usage) and its command dispatch
- Test: `server/test/images-gc.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/test/images-gc.test.ts
import { describe, expect, it } from 'vitest';
import { openTestDb, pushAs } from './helpers';
import { findUnreferencedImages } from '../src/images/gc';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const hash = (char: string) => char.repeat(64);
const meta = (updated_at: number) => ({ updated_at, updated_by: 'test', deleted: 0 });

function seed(db: ReturnType<typeof openTestDb>) {
  pushAs(db, 'owner', [
    { table: 'image', record: { id: hash('a'), mime: 'image/jpeg', width: 8, height: 8, source: 'upload', source_url: null, license: null, attribution: null, ...meta(NOW - 60 * DAY) } },
    { table: 'image', record: { id: hash('b'), mime: 'image/jpeg', width: 8, height: 8, source: 'upload', source_url: null, license: null, attribution: null, ...meta(NOW - 60 * DAY) } },
    { table: 'image', record: { id: hash('c'), mime: 'image/jpeg', width: 8, height: 8, source: 'upload', source_url: null, license: null, attribution: null, ...meta(NOW - 2 * DAY) } },
    { table: 'food', record: { id: 'f1', name: 'Soup', source: 'custom', carbs_per_100g: 10, image_id: hash('a'), ...meta(NOW) } },
  ]);
}

describe('findUnreferencedImages', () => {
  it('keeps referenced images, keeps young ones, and reports only old orphans', () => {
    const db = openTestDb();
    seed(db);
    expect(findUnreferencedImages(db, NOW, 30)).toEqual([hash('b')]);
  });

  it('counts a meal reference too', () => {
    const db = openTestDb();
    seed(db);
    pushAs(db, 'owner', [
      { table: 'meal', record: { id: 'm1', name: 'Pot', yield_servings: 4, image_id: hash('b'), ...meta(NOW) } },
    ]);
    expect(findUnreferencedImages(db, NOW, 30)).toEqual([]);
  });

  it('ignores a reference from a soft-deleted food', () => {
    const db = openTestDb();
    seed(db);
    pushAs(db, 'owner', [
      { table: 'food', record: { id: 'f1', name: 'Soup', source: 'custom', carbs_per_100g: 10, image_id: hash('a'), updated_at: NOW + 1, updated_by: 'test', deleted: 1 } },
    ]);
    expect(findUnreferencedImages(db, NOW + 2, 30).sort()).toEqual([hash('a'), hash('b')].sort());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && pnpm vitest run test/images-gc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/src/images/gc.ts
import type { Db } from '../db';
import type { ImageStore } from './store';

/**
 * Hashes no live food or meal references, older than `minAgeDays`.
 *
 * The age floor matters: a device that has been offline for a while may hold a reference it has
 * not pushed yet, and deleting those bytes would surface as a permanently broken thumbnail. Thirty
 * days is far longer than any realistic offline window here.
 */
export function findUnreferencedImages(db: Db, now: number, minAgeDays: number): string[] {
  const cutoff = now - minAgeDays * 86_400_000;
  const rows = db
    .prepare(
      `SELECT i.id FROM image i
        WHERE i.updated_at < ?
          AND NOT EXISTS (SELECT 1 FROM food f WHERE f.deleted = 0 AND f.image_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM meal m WHERE m.deleted = 0 AND m.image_id = i.id)
        ORDER BY i.id`,
    )
    .all(cutoff) as { id: string }[];
  return rows.map((row) => row.id);
}

/** Deletes bytes and soft-deletes rows. Only ever called from the CLI with --delete. */
export async function deleteImages(db: Db, store: ImageStore, hashes: string[], now: number): Promise<void> {
  const mark = db.prepare('UPDATE image SET deleted = 1, updated_at = ?, updated_by = ? WHERE id = ?');
  for (const hash of hashes) {
    await store.remove(hash);
    mark.run(now, 'server-images-gc', hash);
  }
}
```

- [ ] **Step 4: Add the CLI subcommand**

In `server/src/cli.ts`, extend the usage string:

```
  carbbook images gc [--delete] [--min-age-days <n>]   report unreferenced images; --delete removes them
```

and add the dispatch branch, following the shape of the existing `user add` / `import-usda` branches:

```ts
  if (command === 'images' && argv[1] === 'gc') {
    const wantsDelete = argv.includes('--delete');
    const ageIndex = argv.indexOf('--min-age-days');
    const minAgeDays = ageIndex === -1 ? 30 : Number(argv[ageIndex + 1]);
    if (!Number.isInteger(minAgeDays) || minAgeDays < 1) throw new Error('--min-age-days must be a positive integer');

    const db = openDb(config.databasePath);
    const store = createImageStore({ imageDir: config.imageDir });
    const hashes = findUnreferencedImages(db, Date.now(), minAgeDays);
    console.log(`${hashes.length} unreferenced image(s) older than ${minAgeDays} days`);
    for (const hash of hashes) console.log(`  ${hash}`);
    if (!wantsDelete) {
      console.log('nothing deleted; re-run with --delete to remove them');
      return;
    }
    await deleteImages(db, store, hashes, Date.now());
    console.log(`deleted ${hashes.length} image(s)`);
    return;
  }
```

- [ ] **Step 5: Run the tests and exercise the CLI**

Run: `cd server && pnpm vitest run test/images-gc.test.ts && pnpm test`
Expected: PASS.

Run: `cd server && pnpm carbbook images gc 2>&1 | head -3`
Expected: a count line. (Against a local dev DB; it reads only.)

- [ ] **Step 6: Commit**

```bash
git add server/src/images/gc.ts server/src/cli.ts server/test/images-gc.test.ts
git commit -m "server: carbbook images gc"
```

---

## Task 16: Web sync registration (Dexie v4)

**Files:**
- Modify: `web/src/db/db.ts:19-30` (`SYNC_TABLES`), `:34-44` (`SyncRecords`), and a new `this.version(4)`
- Test: `web/test/db.test.ts` (extend, or create if absent — check first)

- [ ] **Step 1: Write the failing test**

```ts
// web/test/images-db.test.ts
import { describe, expect, it } from 'vitest';
import { SYNC_TABLES } from '../src/db/db';

describe('web sync tables', () => {
  it('includes image, last, matching the server pull order', () => {
    expect(SYNC_TABLES.at(-1)).toBe('image');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && pnpm vitest run test/images-db.test.ts`
Expected: FAIL — last entry is `plan_item`.

- [ ] **Step 3: Register the table**

In `web/src/db/db.ts`: add `'image',` to the end of `SYNC_TABLES`; add `image: Synced<ImageData>;` to `SyncRecords` (importing `ImageData` from `@carbbook/core`); and add a new version below `version(3)`:

```ts
    // v4 adds the image metadata table (images spec 2026-09-18). Pure addition: no existing store
    // definition changes, no data migration, and no pull-cursor reset — the rows are new, so they
    // arrive on the next ordinary pull.
    this.version(4).stores({
      food: 'id, source_ref, image_id',
      portion: 'id, food_id',
      barcode: 'id, code, food_id',
      meal: 'id, image_id',
      meal_item: 'id, meal_id, ref_id',
      log_entry: 'id, eaten_at',
      log_item: 'id, log_entry_id, ref_id',
      dose_settings: 'id, effective_from',
      plan_entry: 'id, date, window_name, log_entry_id',
      plan_item: 'id, plan_entry_id, ref_id',
      image: 'id',
      outbox: 'key',
      meta: 'key',
      sync_error: 'key, at',
      usda_food: 'fdc_id',
      usda_portion: 'id, fdc_id',
      pending_barcode: 'code',
    });
```

Copy the trailing store definitions verbatim from `version(3)` — Dexie requires every store to be repeated, and silently drops any you omit. Read `web/src/db/db.ts:199-220` and match it exactly rather than trusting the list above.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/db/db.ts web/test/images-db.test.ts
git commit -m "web: sync the image metadata table (Dexie v4)"
```

---

## Task 17: Web image client and picker

**Files:**
- Create: `web/src/lib/images.ts`, `web/src/ui/ImageThumb.tsx`, `web/src/ui/ImagePicker.tsx`
- Modify: `web/vite.config.ts:8-35`
- Test: `web/test/images-client.test.ts`

- [ ] **Step 1: Write the failing test for the downscale-and-encode helper**

```ts
// web/test/images-client.test.ts
import { describe, expect, it, vi } from 'vitest';
import { imageUrl, searchImages, adoptImage } from '../src/lib/images';

describe('imageUrl', () => {
  it('builds the hash URL and returns null for no image', () => {
    expect(imageUrl('a'.repeat(64))).toBe('/api/images/' + 'a'.repeat(64));
    expect(imageUrl(null)).toBeNull();
    expect(imageUrl(undefined)).toBeNull();
    // A dangling or malformed id renders as no image rather than a broken request.
    expect(imageUrl('nope')).toBeNull();
  });
});

describe('searchImages', () => {
  it('sends the query and returns candidates with failed providers', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ candidates: [], providers_failed: ['wikimedia'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await searchImages('tomato soup');
    expect(fetchMock.mock.calls[0]![0]).toContain('/api/images/search?q=tomato+soup');
    expect(result.providers_failed).toEqual(['wikimedia']);
  });

  it('returns an empty result rather than throwing when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    expect(await searchImages('x')).toEqual({ candidates: [], providers_failed: ['server'] });
  });
});

describe('adoptImage', () => {
  it('posts JSON and returns the image row', async () => {
    const row = { id: 'b'.repeat(64), mime: 'image/jpeg', width: 800, height: 600, source: 'openverse' };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(row), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await adoptImage({
      provider: 'openverse',
      thumb_url: 't',
      full_url: 'https://api.openverse.org/v1/images/x/thumb/',
      width: null,
      height: null,
      license: 'CC0-1.0',
      attribution: null,
      title: null,
    });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toMatchObject({ source: 'openverse', license: 'CC0-1.0' });
    expect(result.id).toBe(row.id);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && pnpm vitest run test/images-client.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/images'`

- [ ] **Step 3: Write the client**

```ts
// web/src/lib/images.ts
import { IMAGE_HASH_PATTERN, IMAGE_MAX_EDGE_PX, type ImageData } from '@carbbook/core';
import type { ImageCandidate, ImageSearchResult } from './wire';

/** Null for no image and for a malformed id, so a dangling reference renders as empty, never broken. */
export function imageUrl(imageId: string | null | undefined): string | null {
  if (!imageId || !IMAGE_HASH_PATTERN.test(imageId)) return null;
  return `/api/images/${imageId}`;
}

/** Search never throws: an unavailable service degrades the picker, it does not break the editor. */
export async function searchImages(query: string, limit = 24): Promise<ImageSearchResult> {
  try {
    const response = await fetch(`/api/images/search?${new URLSearchParams({ q: query, limit: String(limit) })}`);
    if (!response.ok) return { candidates: [], providers_failed: ['server'] };
    return (await response.json()) as ImageSearchResult;
  } catch {
    return { candidates: [], providers_failed: ['server'] };
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    // Required by the CSRF guard for cookie sessions (server/src/csrf.ts:29-38).
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(detail.message ?? `request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export function adoptImage(candidate: ImageCandidate): Promise<ImageData> {
  return postJson<ImageData>('/api/images/adopt', {
    url: candidate.full_url,
    source: candidate.provider,
    source_url: candidate.full_url,
    ...(candidate.license ? { license: candidate.license } : {}),
    ...(candidate.attribution ? { attribution: candidate.attribution } : {}),
  });
}

/**
 * Downscale before upload so a phone photo never approaches the 5MB body limit. The server
 * re-encodes regardless — this is bandwidth, not validation.
 */
export async function uploadPhoto(file: File): Promise<ImageData> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('could not prepare the photo for upload');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  const data_base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return postJson<ImageData>('/api/images/upload', { data_base64, mime: 'image/jpeg' });
}
```

Add the two wire types to `web/src/lib/wire.ts` (mirroring `server/src/images/providers/types.ts`):

```ts
export interface ImageCandidate {
  provider: 'openverse' | 'wikimedia' | 'themealdb' | 'off';
  thumb_url: string;
  full_url: string;
  width: number | null;
  height: number | null;
  license: string | null;
  attribution: string | null;
  title: string | null;
}

export interface ImageSearchResult {
  candidates: ImageCandidate[];
  providers_failed: string[];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && pnpm vitest run test/images-client.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write `ImageThumb`**

```tsx
// web/src/ui/ImageThumb.tsx
import { imageUrl } from '../lib/images';

/**
 * One image, or nothing at all. There is deliberately no placeholder silhouette: an empty slot
 * is quieter than a fake image, and a dangling image_id must look like "no image", not an error.
 */
export function ImageThumb({ imageId, alt, size = 40 }: { imageId: string | null | undefined; alt: string; size?: number }) {
  const url = imageUrl(imageId);
  if (!url) return null;
  return (
    <img
      src={url}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      style={{ width: size, height: size, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }}
      // A hash URL whose bytes are missing (server restored from a backup without /data/images)
      // hides itself rather than showing a broken-image glyph in every list row.
      onError={(event) => {
        event.currentTarget.style.display = 'none';
      }}
    />
  );
}
```

- [ ] **Step 6: Write `ImagePicker`**

```tsx
// web/src/ui/ImagePicker.tsx
import { useState } from 'react';
import type { ImageData } from '@carbbook/core';
import { adoptImage, imageUrl, searchImages, uploadPhoto } from '../lib/images';
import type { ImageCandidate } from '../lib/wire';

interface ImagePickerProps {
  /** The current image, if any. */
  imageId: string | null | undefined;
  /** Prefilled search query — the food or meal name. */
  defaultQuery: string;
  /** Attribution to display for the current image, when known. */
  attribution?: string | null;
  /** Called with the new image id, or null when the image is removed. Persisted by the caller via sync. */
  onChange: (imageId: string | null) => void;
}

export function ImagePicker({ imageId, defaultQuery, attribution, onChange }: ImagePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(defaultQuery);
  const [candidates, setCandidates] = useState<ImageCandidate[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = imageUrl(imageId);

  async function run() {
    setBusy(true);
    setError(null);
    const result = await searchImages(query);
    setCandidates(result.candidates);
    setFailed(result.providers_failed);
    setBusy(false);
  }

  async function choose(candidate: ImageCandidate) {
    setBusy(true);
    setError(null);
    try {
      const image: ImageData = await adoptImage(candidate);
      onChange(image.id);
      setOpen(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const image = await uploadPhoto(file);
      onChange(image.id);
      setOpen(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {current ? (
        <div>
          <img src={current} alt="" style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 8 }} />
          {attribution ? <p style={{ fontSize: '0.75rem', opacity: 0.7, margin: '0.25rem 0' }}>{attribution}</p> : null}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => setOpen((value) => !value)}>
          {current ? 'Change image' : 'Find image'}
        </button>
        <label>
          Take photo
          <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => void upload(e.target.files?.[0])} />
        </label>
        {current ? (
          <button type="button" onClick={() => onChange(null)}>
            Remove
          </button>
        ) : null}
      </div>

      {open ? (
        <div>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search images" />
            <button type="button" onClick={() => void run()} disabled={busy || query.trim() === ''}>
              Search
            </button>
          </div>
          {error ? <p role="alert">{error}</p> : null}
          {failed.length > 0 ? <p style={{ fontSize: '0.75rem', opacity: 0.7 }}>No response from {failed.join(', ')}</p> : null}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: '0.5rem' }}>
            {candidates.map((candidate) => (
              <button
                key={candidate.full_url}
                type="button"
                onClick={() => void choose(candidate)}
                disabled={busy}
                title={candidate.attribution ?? candidate.title ?? candidate.provider}
                style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
              >
                <img
                  src={candidate.thumb_url}
                  alt={candidate.title ?? ''}
                  loading="lazy"
                  style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 6 }}
                />
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 7: Cache image bytes in the service worker**

In `web/vite.config.ts`, inside the `VitePWA({ workbox: {...} })` options, add:

```ts
        runtimeCaching: [
          {
            // Hash URLs are immutable, so CacheFirst never needs revalidation and images stay
            // available offline. navigateFallbackDenylist already excludes /api/ from the SPA shell.
            urlPattern: /^.*\/api\/images\/[0-9a-f]{64}$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'carbbook-images',
              expiration: { maxEntries: 500 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
```

- [ ] **Step 8: Run tests, typecheck and build**

Run: `cd web && pnpm test && pnpm typecheck && pnpm build`
Expected: PASS, and `web/dist/sw.js` now mentions `carbbook-images`.

Run: `grep -c carbbook-images dist/sw.js`
Expected: at least 1.

- [ ] **Step 9: Commit**

```bash
git add web/src/lib/images.ts web/src/lib/wire.ts web/src/ui/ImageThumb.tsx web/src/ui/ImagePicker.tsx web/vite.config.ts web/test/images-client.test.ts
git commit -m "web: image client, picker and offline byte caching"
```

---

## Task 18: Web editors, lists and the scan-confirm photo

**Files:**
- Modify: `web/src/screens/Foods.tsx`, `web/src/screens/Meals.tsx` (the food and meal editors live here — confirm in Step 1)
- Modify: `web/src/ui/SearchPanel.tsx`, `web/src/ui/ItemEditor.tsx`, `web/src/screens/Plan.tsx` (thumbnails)
- Modify: `web/src/ui/ScannerDialog.tsx` (OFF photo opt-in)
- Test: `web/e2e/carbbook.spec.ts` (extend)

- [ ] **Step 1: Locate the editors**

Run: `grep -rn "yield_servings" web/src/screens/Meals.tsx | head -5 && grep -rn "carbs_per_100g" web/src/screens/Foods.tsx | head -5`
Whichever components render those form fields are the editors. If the forms turn out to live in their own components rather than the screens, use those files instead and note it in the commit message.

- [ ] **Step 2: Write the failing e2e test**

Add to `web/e2e/carbbook.spec.ts`:

```ts
test('a food can be given an image from a search and it shows in the list', async ({ page }) => {
  // Stub the provider fan-out and the adopt round-trip so the test never leaves the machine.
  await page.route('**/api/images/search*', (route) =>
    route.fulfill({
      json: {
        candidates: [
          {
            provider: 'openverse',
            thumb_url: '/icon-192.png',
            full_url: 'https://api.openverse.org/v1/images/x/thumb/',
            width: 800,
            height: 600,
            license: 'CC0-1.0',
            attribution: 'CC0-1.0',
            title: 'Soup',
          },
        ],
        providers_failed: [],
      },
    }),
  );
  const hash = 'a'.repeat(64);
  await page.route('**/api/images/adopt', (route) =>
    route.fulfill({ json: { id: hash, mime: 'image/jpeg', width: 800, height: 600, source: 'openverse', attribution: 'CC0-1.0' } }),
  );
  await page.route(`**/api/images/${hash}`, (route) => route.fulfill({ path: 'public/icon-192.png' }));

  // ...open the food editor for an existing food (follow the existing spec's helpers)...
  await page.getByRole('button', { name: 'Find image' }).click();
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button').filter({ has: page.getByAltText('Soup') }).click();
  await expect(page.getByText('CC0-1.0')).toBeVisible();
  // ...save, return to the list...
  await expect(page.locator(`img[src="/api/images/${hash}"]`).first()).toBeVisible();
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd web && pnpm playwright test -g "can be given an image"`
Expected: FAIL — no "Find image" button exists.

- [ ] **Step 4: Add the picker to both editors**

In the food editor, alongside the other fields:

```tsx
<ImagePicker
  imageId={draft.image_id}
  defaultQuery={draft.name}
  attribution={image?.attribution ?? null}
  onChange={(image_id) => setDraft({ ...draft, image_id })}
/>
```

where `image` is the `image` row looked up from the local Dexie table by `draft.image_id`. The meal editor gets the identical block against the meal draft. `image_id` rides the existing save path — it is just another field on the record the editor already pushes, so no new sync code is needed.

- [ ] **Step 5: Add thumbnails to the lists**

In `web/src/ui/SearchPanel.tsx` (food/meal result rows), `web/src/ui/ItemEditor.tsx` (component rows) and `web/src/screens/Plan.tsx` (plan item rows), prepend to each row:

```tsx
<ImageThumb imageId={resolved?.image_id} alt="" />
```

where `resolved` is the food or meal the row **already** looked up to render its display name. In
`ItemEditor.tsx` that is the catalog lookup near `ItemEditor.tsx:190-195`; in `SearchPanel.tsx` it is
the result row's own record; in `Plan.tsx` it is the object behind the plan item's `ref_type`/`ref_id`.
Do not add a second catalog lookup — reuse the one that is there.

- [ ] **Step 6: Offer the OFF photo on a scan**

In `web/src/ui/ScannerDialog.tsx`, when the barcode response carries `image_candidate`, show the thumbnail with an unchecked "use this photo" checkbox. On confirm, if it is checked, call `adoptImage(candidate)` and set `image_id` on the drafted food. Unchecked is the default because an adopt is a deliberate act, not a side effect of scanning.

- [ ] **Step 7: Run the suites**

Run: `cd web && pnpm test && pnpm typecheck && pnpm playwright test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src/screens web/src/ui web/e2e/carbbook.spec.ts
git commit -m "web: image slot in the editors, thumbnails in lists, OFF photo on scan"
```

---

## Task 19: iOS sync registration

**Files:**
- Modify: `ios/CarbBookKit/Sources/CarbBookKit/Schema.swift` (new `v5Images` migration), `ios/CarbBookKit/Sources/CarbBookKit/TableCodec.swift:10-27`, `ios/CarbBookCore/Sources/CarbBookCore/Sync.swift:33-36`
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/SyncEngineTests.swift` (extend), `ios/CarbBookKit/Tests/` schema test

- [ ] **Step 1: Write the failing tests**

```swift
// ios/CarbBookCore/Tests/CarbBookCoreTests/SyncEngineTests.swift (add)
func testSyncTablesMatchesServerPullOrder() {
    XCTAssertEqual(SyncTables.all, [
        "food", "portion", "barcode", "meal", "meal_item", "log_entry", "log_item",
        "dose_settings", "plan_entry", "plan_item", "image",
    ])
}
```

```swift
// ios/CarbBookKit/Tests/CarbBookKitTests/SchemaTests.swift (add)
func testImageTableAndColumnsExist() throws {
    let store = try makeTestStore()   // whatever the existing schema tests use
    try store.read { db in
        XCTAssertTrue(try db.tableExists("image"))
        let food = try db.columns(in: "food").map(\.name)
        XCTAssertTrue(food.contains("image_id"))
        let meal = try db.columns(in: "meal").map(\.name)
        XCTAssertTrue(meal.contains("image_id"))
    }
    XCTAssertEqual(try TableCodec.columns("image"), [
        "id", "mime", "width", "height", "source", "source_url", "license", "attribution",
        "updated_at", "updated_by", "deleted", "server_seq",
    ])
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `./ios/scripts/swift-test.sh`
Expected: FAIL — `SyncTables.all` is missing three entries and there is no `image` table.

- [ ] **Step 3: Fix `SyncTables.all`**

```swift
public enum SyncTables {
    /// Synced tables, in the server's pull order. `plan_entry`/`plan_item` were missing here while
    /// PlanEditing.swift was already writing them (fixed with the images spec); `image` is new.
    public static let all = [
        "food", "portion", "barcode", "meal", "meal_item", "log_entry", "log_item",
        "dose_settings", "plan_entry", "plan_item", "image",
    ]
}
```

Before committing, confirm nothing depends on the old eight-entry list:

Run: `grep -rn "SyncTables.all" ios/`
Expected: only the test guard and, if anything else appears, verify adding entries is correct for that caller too.

- [ ] **Step 4: Add the schema migration**

In `Schema.swift`, register it after `v4QuickCarbs`:

```swift
        migrator.registerMigration("v5-images") { db in
            try db.execute(sql: v5Images)
        }
```

```swift
    /// Images (images spec 2026-09-18). Mirrors server migration 006 without the CHECKs the server
    /// enforces: this database stores whatever the server sends, and a row the server would reject
    /// comes back as a `sync_rejection` rather than failing an INSERT here.
    /// `image_id` is added to food and meal; rows pending at migration time were edited without
    /// knowing the column, so `sync_legacy_pending` makes their push omit it (the server keeps its
    /// stored value) until they are edited again — the v4 pattern.
    /// No pull-cursor reset: the image table is new, so its rows arrive on the next ordinary pull.
    static let v5Images = """
    CREATE TABLE image (
      id TEXT PRIMARY KEY, mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
      source TEXT NOT NULL, source_url TEXT, license TEXT, attribution TEXT,
      updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, server_seq INTEGER
    );
    ALTER TABLE food ADD COLUMN image_id TEXT;
    ALTER TABLE meal ADD COLUMN image_id TEXT;
    CREATE INDEX food_image ON food (image_id);
    CREATE INDEX meal_image ON meal (image_id);
    INSERT OR IGNORE INTO sync_legacy_pending (key) SELECT key FROM sync_pending WHERE table_name IN ('food', 'meal');
    """
```

- [ ] **Step 5: Register the columns in `TableCodec`**

Add to `dataColumns`:

```swift
        "image": ["mime", "width", "height", "source", "source_url", "license", "attribution"],
```

Append `image_id` to the `food` and `meal` entries, and add both to `legacyColumns`:

```swift
        "food": ["carbs_per_100ml", "image_id"], "meal": ["image_id"],
```

Add the new integer columns so they round-trip as numbers, not strings:

```swift
    static let integerColumns: Set<String> = ["eaten_at", "effective_from", "position", "updated_at", "deleted", "server_seq", "width", "height"]
```

- [ ] **Step 6: Run the Swift tests**

Run: `./ios/scripts/swift-test.sh`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ios/CarbBookKit/Sources/CarbBookKit/Schema.swift ios/CarbBookKit/Sources/CarbBookKit/TableCodec.swift ios/CarbBookCore/Sources/CarbBookCore/Sync.swift ios/CarbBookCore/Tests ios/CarbBookKit/Tests
git commit -m "ios: sync the image table, add image_id, fix SyncTables.all"
```

---

## Task 20: iOS image cache

The notifications spec depends on this producing a real file path, because `UNNotificationAttachment` cannot take bytes.

**Files:**
- Create: `ios/CarbBookKit/Sources/CarbBookKit/ImageCache.swift`
- Test: `ios/CarbBookKit/Tests/CarbBookKitTests/ImageCacheTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
// ios/CarbBookKit/Tests/CarbBookKitTests/ImageCacheTests.swift
import XCTest
@testable import CarbBookKit

final class ImageCacheTests: XCTestCase {
    private let hash = String(repeating: "a", count: 64)

    private func makeCache(fetch: @escaping (String) async throws -> Data) throws -> (ImageCache, URL) {
        let dir = URL.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return (ImageCache(directory: dir, fetch: fetch), dir)
    }

    func testFetchesOnceThenServesFromDisk() async throws {
        var calls = 0
        let (cache, _) = try makeCache { _ in
            calls += 1
            return Data([0xFF, 0xD8, 0xFF, 0xE0])
        }
        let first = try await cache.fileURL(for: hash)
        let second = try await cache.fileURL(for: hash)
        XCTAssertEqual(first, second)
        XCTAssertEqual(calls, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: first.path))
    }

    func testRefetchesAfterEviction() async throws {
        var calls = 0
        let (cache, _) = try makeCache { _ in
            calls += 1
            return Data([0xFF, 0xD8, 0xFF, 0xE0])
        }
        let url = try await cache.fileURL(for: hash)
        // The OS can purge Caches at any time; a miss must refetch, not throw.
        try FileManager.default.removeItem(at: url)
        _ = try await cache.fileURL(for: hash)
        XCTAssertEqual(calls, 2)
    }

    func testRejectsAMalformedHashWithoutFetching() async throws {
        var calls = 0
        let (cache, _) = try makeCache { _ in
            calls += 1
            return Data()
        }
        do {
            _ = try await cache.fileURL(for: "../../etc/passwd")
            XCTFail("expected a rejection")
        } catch {
            XCTAssertEqual(calls, 0)
        }
    }

    func testPropagatesAFetchFailure() async throws {
        let (cache, _) = try makeCache { _ in throw URLError(.notConnectedToInternet) }
        do {
            _ = try await cache.fileURL(for: hash)
            XCTFail("expected a rejection")
        } catch {}
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `./ios/scripts/swift-test.sh`
Expected: FAIL — no `ImageCache`.

- [ ] **Step 3: Write the implementation**

```swift
// ios/CarbBookKit/Sources/CarbBookKit/ImageCache.swift
import Foundation

/// Hash-keyed on-disk cache for `GET /api/images/:hash`.
///
/// The URL is the content hash, so a cached file never needs revalidating. Files live in Caches,
/// which the OS may purge at any time, so every read treats a miss as "fetch again" rather than an
/// error. `fileURL(for:)` returns a real path because `UNNotificationAttachment` requires one.
public actor ImageCache {
    public enum CacheError: Error, Equatable {
        case notAnImageHash(String)
    }

    private let directory: URL
    private let fetch: (String) async throws -> Data
    /// Coalesces concurrent requests for the same hash into one download.
    private var inFlight: [String: Task<URL, Error>] = [:]

    public init(directory: URL, fetch: @escaping (String) async throws -> Data) {
        self.directory = directory
        self.fetch = fetch
    }

    private static let hashPattern = /^[0-9a-f]{64}$/

    public func fileURL(for hash: String) async throws -> URL {
        guard hash.wholeMatch(of: Self.hashPattern) != nil else { throw CacheError.notAnImageHash(hash) }
        let target = directory.appending(path: "\(hash).jpg")
        if FileManager.default.fileExists(atPath: target.path) { return target }

        if let existing = inFlight[hash] { return try await existing.value }
        let task = Task<URL, Error> { [fetch, directory] in
            let data = try await fetch(hash)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            // Write then move, so a cancelled download never leaves a truncated file at the
            // content-addressed path where it would be served forever.
            let temporary = directory.appending(path: "\(hash).\(UUID().uuidString).tmp")
            try data.write(to: temporary, options: .atomic)
            if FileManager.default.fileExists(atPath: target.path) {
                try? FileManager.default.removeItem(at: temporary)
            } else {
                try FileManager.default.moveItem(at: temporary, to: target)
            }
            return target
        }
        inFlight[hash] = task
        defer { inFlight[hash] = nil }
        return try await task.value
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `./ios/scripts/swift-test.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ios/CarbBookKit/Sources/CarbBookKit/ImageCache.swift ios/CarbBookKit/Tests/CarbBookKitTests/ImageCacheTests.swift
git commit -m "ios: hash-keyed image cache"
```

---

## Task 21: iOS picker, editor slot and thumbnails

**Files:**
- Create: `ios/CarbBook/Images/ImageThumbView.swift`, `ios/CarbBook/Images/ImagePickerSheet.swift`
- Modify: `ios/CarbBook/Foods/FoodEditorView.swift`, `ios/CarbBook/Meals/MealEditorView.swift`, `ios/CarbBook/Foods/FoodsView.swift`, `ios/CarbBook/Meals/MealsView.swift`, `ios/CarbBook/Plan/*View.swift`, `ios/CarbBook/Scanner/*`
- Modify: `ios/project.yml` (add `INFOPLIST_KEY_NSPhotoLibraryUsageDescription`)

- [ ] **Step 1: Add the photo-library usage key**

In `ios/project.yml`, next to the existing `INFOPLIST_KEY_NSCameraUsageDescription` (line ~29-52):

```yaml
      INFOPLIST_KEY_NSPhotoLibraryUsageDescription: CarbBook uses photos you choose to illustrate your foods and meals.
```

The camera key already exists for the barcode scanner and covers taking a photo.

- [ ] **Step 2: Write `ImageThumbView`**

```swift
// ios/CarbBook/Images/ImageThumbView.swift
import CarbBookKit
import SwiftUI

/// One cached image, or nothing. No placeholder: an empty slot is quieter than a fake image, and a
/// dangling image_id must read as "no image".
struct ImageThumbView: View {
    let imageID: String?
    var size: CGFloat = 40

    @Environment(\.imageCache) private var cache
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: size, height: size)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .task(id: imageID) {
            image = nil
            guard let imageID else { return }
            // A failure here is silence, never an alert: images are decoration.
            guard let url = try? await cache.fileURL(for: imageID),
                  let data = try? Data(contentsOf: url),
                  let loaded = UIImage(data: data) else { return }
            image = loaded
        }
    }
}
```

Add an `imageCache` environment key wherever the app's other shared services are injected (`ios/CarbBook/App/AppModel.swift`), constructed with a `fetch` closure that calls `GET /api/images/:hash` through the existing authenticated API client.

- [ ] **Step 3: Write the downscale helper with a test**

```swift
// ios/CarbBookKit/Sources/CarbBookKit/PhotoEncoder.swift
import UIKit

/// Downscale-and-encode before upload so a 12MP photo never approaches the server's 5MB body
/// limit. The server re-encodes regardless: this is bandwidth, not validation.
public enum PhotoEncoder {
    /// `maxEdge` matches IMAGE_MAX_EDGE_PX; the server caps again at the same size.
    public static func jpegBase64(_ image: UIImage, maxEdge: CGFloat = 800, quality: CGFloat = 0.85) -> String? {
        let longest = max(image.size.width, image.size.height)
        let scale = min(1, maxEdge / max(longest, 1))
        let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
        let rendered = UIGraphicsImageRenderer(size: size).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return rendered.jpegData(compressionQuality: quality)?.base64EncodedString()
    }
}
```

```swift
// ios/CarbBookKit/Tests/CarbBookKitTests/PhotoEncoderTests.swift
func testDownscalesAndEncodes() throws {
    let big = UIGraphicsImageRenderer(size: CGSize(width: 2400, height: 1200)).image { context in
        UIColor.red.setFill()
        context.fill(CGRect(x: 0, y: 0, width: 2400, height: 1200))
    }
    let base64 = try XCTUnwrap(PhotoEncoder.jpegBase64(big))
    let decoded = try XCTUnwrap(UIImage(data: try XCTUnwrap(Data(base64Encoded: base64))))
    XCTAssertEqual(max(decoded.size.width, decoded.size.height), 800, accuracy: 1)
}

func testDoesNotUpscaleASmallPhoto() throws {
    let small = UIGraphicsImageRenderer(size: CGSize(width: 120, height: 90)).image { context in
        UIColor.green.setFill()
        context.fill(CGRect(x: 0, y: 0, width: 120, height: 90))
    }
    let base64 = try XCTUnwrap(PhotoEncoder.jpegBase64(small))
    let decoded = try XCTUnwrap(UIImage(data: try XCTUnwrap(Data(base64Encoded: base64))))
    XCTAssertEqual(decoded.size.width, 120, accuracy: 1)
}
```

Run: `./ios/scripts/swift-test.sh`
Expected: both PASS.

- [ ] **Step 4: Write `ImagePickerSheet`**

```swift
// ios/CarbBook/Images/ImagePickerSheet.swift
import CarbBookKit
import PhotosUI
import SwiftUI

/// Search candidates, the user's own photo, or removal. Adopting and uploading both return an
/// image row; the sheet hands its id back and the editor saves it through the ordinary sync path.
struct ImagePickerSheet: View {
    let defaultQuery: String
    let hasImage: Bool
    let onPick: (String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.api) private var api          // the existing authenticated API client
    @State private var query: String = ""
    @State private var candidates: [ImageCandidate] = []
    @State private var providersFailed: [String] = []
    @State private var photo: PhotosPickerItem?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                HStack {
                    TextField("Search images", text: $query)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { Task { await search() } }
                    Button("Search") { Task { await search() } }
                        .disabled(busy || query.trimmingCharacters(in: .whitespaces).isEmpty)
                }

                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                if !providersFailed.isEmpty {
                    Text("No response from \(providersFailed.joined(separator: ", "))")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 8)], spacing: 8) {
                        ForEach(candidates, id: \.full_url) { candidate in
                            Button { Task { await adopt(candidate) } } label: {
                                AsyncImage(url: URL(string: candidate.thumb_url)) { image in
                                    image.resizable().aspectRatio(contentMode: .fill)
                                } placeholder: {
                                    Color.secondary.opacity(0.1)
                                }
                                .frame(width: 96, height: 96)
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                            }
                            .buttonStyle(.plain)
                            .disabled(busy)
                            .accessibilityLabel(candidate.title ?? candidate.provider)
                        }
                    }
                }

                PhotosPicker("Choose photo", selection: $photo, matching: .images)
                if hasImage {
                    Button("Remove image", role: .destructive) {
                        onPick(nil)
                        dismiss()
                    }
                }
            }
            .padding()
            .navigationTitle("Image")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .overlay { if busy { ProgressView() } }
            .task { query = defaultQuery }
            .onChange(of: photo) { _, item in Task { await upload(item) } }
        }
    }

    /// Search never surfaces as an error: an unavailable service degrades the grid.
    private func search() async {
        busy = true
        error = nil
        let result = await api.searchImages(query: query)
        candidates = result.candidates
        providersFailed = result.providers_failed
        busy = false
    }

    private func adopt(_ candidate: ImageCandidate) async {
        busy = true
        error = nil
        do {
            let image = try await api.adoptImage(candidate)
            onPick(image.id)
            dismiss()
        } catch {
            // Stay open so the user can pick something else.
            self.error = error.localizedDescription
        }
        busy = false
    }

    private func upload(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        busy = true
        error = nil
        do {
            guard let data = try await item.loadTransferable(type: Data.self),
                  let uiImage = UIImage(data: data),
                  let base64 = PhotoEncoder.jpegBase64(uiImage) else {
                throw NSError(domain: "CarbBook", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not read that photo"])
            }
            let image = try await api.uploadImage(dataBase64: base64)
            onPick(image.id)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }
}
```

Add the three API client methods next to the existing barcode and sync calls, decoding into
`ImageCandidate` / `ImageSearchResult` / `ImageData` Codable mirrors of the wire shapes in
`server/src/images/providers/types.ts`:

```swift
func searchImages(query: String) async -> ImageSearchResult        // never throws; empty on failure
func adoptImage(_ candidate: ImageCandidate) async throws -> ImageData
func uploadImage(dataBase64: String) async throws -> ImageData
```

- [ ] **Step 5: Add the slot and thumbnails**

`FoodEditorView` and `MealEditorView` get a thumbnail row that opens the sheet, with the attribution shown beneath when the `image` row has one. `FoodsView`, `MealsView`, the plan rows and the calculator item rows get a leading `ImageThumbView(imageID:)` reusing the food or meal each row already resolves.

- [ ] **Step 6: Build and test**

Run: `./ios/scripts/swift-test.sh`
Expected: PASS (core and kit tests; the app target builds on GitHub CI, not locally).

Push the branch and confirm the macOS CI build is green before the next task.

- [ ] **Step 7: Commit**

```bash
git add ios/CarbBook ios/CarbBookKit ios/project.yml
git commit -m "ios: image picker, editor slot and list thumbnails"
```

---

## Task 22: Deploy and verify on real devices

Nothing in this feature is done until it works on the phone. Per the project's own rule, do not mark the plan complete before this task passes.

- [ ] **Step 1: Back up the database before the migration**

```bash
ssh pi sudo systemctl start carbbook-backup.service
ssh pi "ls -lt /opt/carbbook/backups | head -3"
```
Expected: a backup dated today, newest first.

- [ ] **Step 2: Confirm sharp resolves on the Pi's architecture**

```bash
ssh pi "docker run --rm --platform linux/arm64 node:22-bookworm-slim sh -c 'npm i --silent sharp >/dev/null 2>&1 && node -e \"console.log(require(\\\"sharp\\\").versions.vips)\"'"
```
Expected: a libvips version printed with no compiler output. If this builds from source or fails, **stop** — see Task 4 Step 1's stop condition.

- [ ] **Step 3: Create the image directory with the right ownership**

```bash
ssh pi "sudo mkdir -p /opt/carbbook/data/images && sudo chown --reference=/opt/carbbook/data/carbbook.db /opt/carbbook/data/images && ls -ld /opt/carbbook/data/images"
```

`IMAGE_DIR` defaults to `/data/images`, which is inside the already-mounted `/opt/carbbook/data:/data` volume, so `deploy/compose.yml` needs no new volume — but add `IMAGE_DIR` explicitly to the compose environment anyway, so the path is documented where the other paths are.

- [ ] **Step 4: Deploy**

```bash
cd ~/Projects/CarbBook && ./deploy/deploy.sh
ssh pi "docker exec carbs-server sh -lc 'sqlite3 /data/carbbook.db \"PRAGMA user_version; SELECT count(*) FROM image;\"'"
```
Expected: `6` and `0`.

- [ ] **Step 5: Verify the web app end to end**

Open https://recipes.dxshdw.dev and, on the soup food created on 2026-09-17:
- Search an image, adopt it, save. The thumbnail appears in the Foods list.
- Confirm the attribution line shows under the image in the editor.
- Take/choose a photo on another food and confirm it uploads.
- Reload with the network disabled (DevTools offline) and confirm both thumbnails still render from the service-worker cache.
- Confirm `GET /api/images/<hash>` returns `cache-control: private, max-age=31536000, immutable`.

- [ ] **Step 6: Verify the SSRF guard against the live server**

```bash
# Expect 400 url_rejected for each, with a real session cookie or bearer token.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://recipes.dxshdw.dev/api/images/adopt \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"url":"http://api.openverse.org/x.jpg","source":"openverse"}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://recipes.dxshdw.dev/api/images/adopt \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"url":"https://192.168.1.210/x.jpg","source":"openverse"}'
```
Expected: `400` for both. This is the one check worth doing against production as well as in tests.

- [ ] **Step 7: Verify iOS**

Build a release through the existing GitHub release workflow, install via ipa-hub, then on the phone:
- Sync and confirm the images adopted on the web appear in the Foods and Meals lists.
- Adopt an image from the phone and confirm it appears on the web after a sync.
- Take a photo and confirm it uploads and displays.
- Airplane-mode the phone and confirm thumbnails still render from the cache.
- Scan a barcode for a product OFF has a photo for and confirm the "use this photo" option appears and works.

- [ ] **Step 8: Update the docs and memory**

- Add the image routes and `IMAGE_DIR` to `deploy/README.md`, including that `/opt/carbbook/data/images` is **not** covered by the existing DB backup and is regenerable only by re-adopting.
- Note in `HANDOFF.md` what shipped.

- [ ] **Step 9: Commit and open the PR**

```bash
git add deploy/README.md HANDOFF.md deploy/compose.yml
git commit -m "docs: image store deployment notes"
git push -u origin feat/food-images
gh pr create --title "Food and meal images" --body "$(cat <<'BODY'
Implements docs/superpowers/specs/2026-09-18-food-images-design.md.

- New synced `image` metadata table; `food.image_id` / `meal.image_id`.
- Content-addressed byte store under IMAGE_DIR, normalised to <=800px JPEG by sharp.
- Search across Openverse, Wikimedia Commons and TheMealDB (no API keys); OFF product
  photo offered on a barcode scan; user photo upload as base64 JSON.
- Adoption is gated by an SSRF guard: https only, provider-owned hosts only, no
  credentials, default port only, and every resolved address must be public.
- Also fixes pre-existing drift: iOS `SyncTables.all` was missing plan_entry/plan_item.

Verified on device: web adopt/upload/offline, iOS adopt/upload/offline, OFF scan photo,
and the SSRF rejections against the live server.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

---

## Notes carried forward to the notifications spec

- `ImageCache.fileURL(for:)` is what `UNNotificationAttachment` will use. It returns a path in Caches, which the OS may purge, so the notification scheduler must prefetch images for planned items **at scheduling time** and tolerate a miss by scheduling without an attachment.
- `image_id` lives on the food or meal, not the plan item, so a notification resolves its image through the plan item's `ref_type`/`ref_id` the same way it resolves the display name.
