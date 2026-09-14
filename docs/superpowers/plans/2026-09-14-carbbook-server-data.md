# CarbBook Server Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the data half of `@carbbook/server`: per-record sync push/pull with last-write-wins and viewer restrictions, USDA FoodData Central CSV import with portion normalization and downloadable bundles, FTS5 search, and Open Food Facts barcode lookup.

**Architecture:** Builds on the foundation plan's `buildApp({ db, config, deps })`. Sync is table-driven: one `TableSpec` per synced table drives validation, upserts and pull decoding; LWW uses `isNewer` and meal-cycle checks use `createCatalog` + `wouldCreateCycle` from `@carbbook/core`. The USDA importer streams extracted FDC CSV folders into `usda_food`/`usda_portion`, then writes a content-versioned gzip-JSON bundle (web) and SQLite bundle (iOS). Open Food Facts is an injected `OffClient`, so tests never touch the network.

**Tech Stack:** as the foundation plan, plus csv-parse 7.0.2 (already in `server/package.json`), SQLite FTS5 (`unicode61 remove_diacritics 2`).

**Spec:** `docs/superpowers/specs/2026-09-13-carbbook-design.md` §3 (usda tables), §5 sync, §6 food data, §9 (OFF failures, per-record push errors), §10 sync tests. **Prerequisite:** `docs/superpowers/plans/2026-09-14-carbbook-server-foundation.md` fully implemented (49 tests green).

---

## Verified facts this plan relies on (2026-09-14)

All code below was run in a scratch copy of the workspace: 28 test files / 142 tests passing, `tsc` clean. A real import of the three FDC downloads produced 13,694 foods and 32,505 portions.

**USDA FoodData Central** (`https://fdc.nal.usda.gov/download-datasets/`, downloaded and parsed):
- Foundation 04/2026: `https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_csv_2026-04-30.zip`
- SR Legacy (final, 04/2018): `https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip`
- FNDDS/Survey 10/2024: `https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_csv_2024-10-31.zip`
- Each zip extracts to a folder of the same name containing `food.csv` (`fdc_id,data_type,description,food_category_id,publication_date`), `food_nutrient.csv` (`id,fdc_id,nutrient_id,amount,…`), `food_portion.csv` (`id,fdc_id,seq_num,amount,measure_unit_id,portion_description,modifier,gram_weight,…`), `measure_unit.csv` (`id,name`).
- Nutrient 1005 = "Carbohydrate, by difference" (nutrient_nbr 205); 1079 = "Fiber, total dietary" (nbr 291). **The FNDDS 2024-10-31 `food_nutrient.nutrient_id` column holds the legacy numbers 205/291, not 1005/1079** — the importer accepts both.
- Foundation's `food.csv` also contains ~87k `sub_sample_food`/`market_acquisition`/… rows; only `data_type = foundation_food` (469 foods) are foods. SR Legacy = 7,793 `sr_legacy_food`; FNDDS = 5,432 `survey_fndds_food`.
- Portions differ per dataset: Foundation puts the unit in `measure_unit_id` (1000 cup, 1001 tablespoon, 1009 fl oz, 1045 quart, 1071 each…) with free text in `modifier`; SR Legacy always uses 9999 "undetermined" with the unit at the start of `modifier` ("cup, chopped", "tbsp", "fl oz", "oz"); FNDDS uses 9999 with empty `amount`, text like "1 cup, cooked" in `portion_description` and a numeric code in `modifier`.

**Open Food Facts** (live `curl`, docs at `https://openfoodfacts.github.io/openfoodfacts-server/api/`):
- `GET https://world.openfoodfacts.org/api/v2/product/{code}?fields=code,product_name,brands,serving_size,serving_quantity,serving_quantity_unit,nutriments`
- Found → HTTP 200 `{"code","status":1,"status_verbose":"product found","product":{…}}`; `nutriments.carbohydrates_100g`, `nutriments.fiber_100g`, `serving_quantity` (e.g. `52`) with `serving_quantity_unit` (`"g"`), `serving_size` text. Any field may be missing.
- Unknown → **HTTP 404** `{"status":0,"status_verbose":"product not found"}`; invalid code → HTTP 200 with `status: 0`. The API normalizes codes (`737628064502` → `0737628064502`).
- Requires a custom `User-Agent: AppName/Version (ContactEmail)`; read limit 15 requests/min per IP.

## Wire formats (for the web and iOS plans)

- `POST /api/sync/push` body `{ changes: [{ table, record }] }` (≤500). Response `{ results: [...], server_seq }`; each result is `{table,id,status:'accepted',server_seq}`, `{table,id,status:'ignored',server_seq}` (stored row is newer — pull to get it) or `{table,id,status:'rejected',reason:'unknown_table'|'invalid'|'forbidden'|'cycle'|'append_only',message}`. Records use the §3 column names; `dose_settings.windows/correction/rounding` are JSON objects on the wire. `dose_settings` rows are append-only: a viewer push is `forbidden`; an owner push that soft-deletes or edits `effective_from`/`windows`/`correction`/`rounding` on an *existing* row is `append_only` — only brand-new versions are accepted.
- `GET /api/sync/pull?since=<seq>&limit=<1..1000, default 500>` → `{ changes: [{table, record}], next_since, has_more }` in `server_seq` order, soft-deleted rows included.
- `GET /api/usda/manifest` → `{version, created_at, food_count, portion_count, json_file, json_sha256, json_url, sqlite_file, sqlite_sha256, sqlite_url}` or 404 `usda_not_imported`. Files are served at `/api/usda/files/<name>` with `cache-control: private, max-age=31536000, immutable`. JSON bundle (gzip, `application/gzip`): `{format:1, foods:[[fdc_id,name,carbs_per_100g,fiber_per_100g]], portions:[[id,fdc_id,label,kind,quantity,grams,description]]}`. SQLite bundle (`application/vnd.sqlite3`): tables `usda_food`, `usda_portion`, `usda_fts` (FTS5), `bundle_meta(version)`.
- `GET /api/search?q=&limit=` → `{ results: [{kind:'meal'|'food'|'usda', id, name, brand, source, carbs_per_100g}] }`; USDA ids are `usda:<fdc_id>`.
- `GET /api/barcode/:code` (6–14 digits) → always HTTP 200 with `status`: `known` (`food`, `portions`), `draft` (`draft: {food, portions, barcode, serving_size}`), `not_found` (`code`), or `unavailable` (`code`, `message` — OFF error/timeout, client falls back to manual entry prefilled with the code).

## Decisions and open questions for the owner

1. **How clients use a USDA food** is not in the spec. This plan assumes a client copies the USDA row into `food` (`source: 'usda'`, `source_ref: '<fdc_id>'`) plus its portions the first time it is used in a meal or log. The server accepts that; confirm before the web plan.
2. Search ranking reads spec §6 as: tier 0 = meals + `custom` foods; tier 1 = other saved foods (`off`/`usda` copies), most recently logged first; tier 2 = USDA library. bm25 orders within a tier.
3. USDA portion rules: mass portions (`oz`, `lb`, …) are dropped because mass units are always available; quarts/pints/gallons become cups (×4/×2/×16); "cup, dry, yields" style rows stay `count` so they don't define a wrong density; zero-gram rows are dropped. The original wording is kept in `description`. Real data: 9,526 volume, 16,618 count, 6,361 serving portions; 4,177 rows skipped.
4. 102 Foundation foods have no carbohydrate value at all (mostly meats/fats) and import with `carbs_per_100g = null`, so core marks them incomplete.
5. The barcode route never calls OFF for a code already saved locally, including the UPC-A/EAN-13 zero-padding variant.
6. Pushes are validated per record; an envelope error (not an array, >500 changes) is a 400 for the whole request.
7. Spec §5 "LWW tie → higher `updated_by`" is implemented by core's `isNewer`; an exact replay (same `updated_at` and `updated_by`) is `ignored`.

---

## File structure

```
server/migrations/002_usda_search.sql   usda_food, usda_portion, usda_fts, catalog_fts + triggers
server/src/sync/tables.ts               TableSpec per synced table + dose_settings JSON checks
server/src/sync/validate.ts             validateRecord (→ SQL row), decodeRow (→ wire shape)
server/src/sync/push.ts                 applyPush: LWW, viewer rules, meal cycle rejection
server/src/sync/pull.ts                 pullChanges: cross-table paging by server_seq
server/src/routes/sync.ts               POST /api/sync/push, GET /api/sync/pull
server/src/usda/portions.ts             normalizePortion (FDC row → core portion model)
server/src/usda/import.ts               readCsv, importUsda(db, dirs)
server/src/usda/bundle.ts               buildUsdaBundles (json.gz + sqlite + manifest), readManifest
server/src/routes/usda.ts               GET /api/usda/manifest, GET /api/usda/files/:name
server/src/search/search.ts             toFtsQuery, search (tiered ranking)
server/src/routes/search.ts             GET /api/search
server/src/off/client.ts                OffClient (API v2, User-Agent, timeout)
server/src/off/normalize.ts             normalizeOffProduct, barcodeCandidates
server/src/routes/barcode.ts            GET /api/barcode/:code
server/src/context.ts, app.ts, cli.ts   modified: off dep, route registration, import-usda command
server/test/sync-helpers.ts             record factories
server/test/fixtures.ts                 + USDA_FIXTURES
server/test/fixtures/usda/{foundation,sr_legacy,survey}/*.csv   real FDC rows, trimmed
server/test/*.test.ts                   one file per task
```

---

### Task 1: Sync table specs and record validation

**Files:**
- Create: `server/src/sync/tables.ts`, `server/src/sync/validate.ts`, `server/test/sync-helpers.ts`
- Test: `server/test/sync-validate.test.ts`

- [ ] **Step 1: Write the record factories**

`server/test/sync-helpers.ts`:
```ts
import type { DoseSettingsData } from '@carbbook/core';
import { SEED_WINDOWS } from '../src/seed';

let counter = 0;
export const uid = (prefix: string) => `${prefix}-${String(++counter).padStart(4, '0')}`;

type Meta = { updated_at?: number; updated_by?: string; deleted?: 0 | 1 };
const meta = (m: Meta) => ({ updated_at: m.updated_at ?? 1000, updated_by: m.updated_by ?? 'phone', deleted: m.deleted ?? 0 });

export const food = (fields: Partial<Record<string, unknown>> & Meta = {}) => ({
  id: uid('food'),
  name: 'Tortilla',
  brand: null,
  source: 'custom',
  source_ref: null,
  derived_from: null,
  carbs_per_100g: 48,
  fiber_per_100g: 3,
  density_g_per_ml: null,
  notes: null,
  ...fields,
  ...meta(fields),
});

export const meal = (fields: Partial<Record<string, unknown>> & Meta = {}) => ({
  id: uid('meal'),
  name: 'Tacos',
  yield_servings: 4,
  total_weight_g: null,
  notes: null,
  ...fields,
  ...meta(fields),
});

export const mealItem = (mealId: string, refType: 'food' | 'meal', refId: string, fields: Meta & { position?: number } = {}) => ({
  id: uid('item'),
  meal_id: mealId,
  ref_type: refType,
  ref_id: refId,
  amount: 1,
  unit: refType === 'meal' ? 'serving' : 'g',
  position: fields.position ?? 0,
  ...meta(fields),
});

export const doseSettings = (fields: Partial<DoseSettingsData> & Meta = {}) => ({
  id: uid('dose'),
  effective_from: Date.parse('2026-09-15T05:00:00Z'),
  windows: SEED_WINDOWS,
  correction: { threshold: 180, step: 40, units_per_step: 1, mode: 'started' },
  rounding: { increment: 0.5, round_down_below_bg: 130 },
  ...fields,
  ...meta(fields),
});
```

- [ ] **Step 2: Write the failing test**

`server/test/sync-validate.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { TABLE_SPECS } from '../src/sync/tables';
import { decodeRow, validateRecord } from '../src/sync/validate';
import { doseSettings, food, mealItem } from './sync-helpers';

describe('validateRecord', () => {
  it('accepts a complete food and drops unknown fields', () => {
    const record = { ...food({ id: 'f1', name: 'Tortilla' }), favourite: true };
    const result = validateRecord(TABLE_SPECS.food, record);
    expect(result).toEqual({
      ok: true,
      row: {
        id: 'f1',
        updated_at: 1000,
        updated_by: 'phone',
        deleted: 0,
        name: 'Tortilla',
        brand: null,
        source: 'custom',
        source_ref: null,
        derived_from: null,
        carbs_per_100g: 48,
        fiber_per_100g: 3,
        density_g_per_ml: null,
        notes: null,
      },
    });
  });

  it('treats missing nullable fields as null', () => {
    const { brand: _b, notes: _n, ...record } = food({ id: 'f2' });
    const result = validateRecord(TABLE_SPECS.food, record);
    expect(result.ok && result.row.brand).toBeNull();
  });

  it.each([
    [{ ...food(), id: '' }, 'id must be a string of 1-64 characters'],
    [{ ...food(), updated_at: 1.5 }, 'updated_at must be a non-negative integer (ms)'],
    [{ ...food(), deleted: true }, 'deleted must be 0 or 1'],
    [{ ...food(), name: '  ' }, 'name must not be empty'],
    [{ ...food(), source: 'mystery' }, 'source must be one of usda, off, custom'],
    [{ ...food(), carbs_per_100g: -1 }, 'carbs_per_100g must be >= 0'],
    [{ ...food(), density_g_per_ml: 0 }, 'density_g_per_ml must be > 0'],
    [{ ...food(), carbs_per_100g: 'lots' }, 'carbs_per_100g must be a finite number'],
  ])('rejects invalid food %#', (record, message) => {
    expect(validateRecord(TABLE_SPECS.food, record)).toEqual({ ok: false, message });
  });

  it('requires volume portions to use a core volume unit id', () => {
    const base = { id: 'p1', food_id: 'f1', kind: 'volume', quantity: 1, grams: 229, updated_at: 1, updated_by: 'd', deleted: 0 };
    expect(validateRecord(TABLE_SPECS.portion, { ...base, label: 'cup' }).ok).toBe(true);
    expect(validateRecord(TABLE_SPECS.portion, { ...base, label: '1 cup, chopped' })).toEqual({
      ok: false,
      message: 'volume portion label must be one of ml, l, tsp, tbsp, floz, cup',
    });
    expect(validateRecord(TABLE_SPECS.portion, { ...base, kind: 'count', label: 'slice' }).ok).toBe(true);
  });

  it('requires integer meal_item positions', () => {
    expect(validateRecord(TABLE_SPECS.meal_item, { ...mealItem('m1', 'food', 'f1'), position: 0.5 })).toEqual({
      ok: false,
      message: 'position must be an integer',
    });
  });

  it('validates and serializes dose_settings JSON', () => {
    const record = doseSettings({ id: 'd1' });
    const result = validateRecord(TABLE_SPECS.dose_settings, record);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.row.windows).toBe('string');
    expect(decodeRow(TABLE_SPECS.dose_settings, result.row)).toMatchObject({ windows: record.windows, correction: record.correction });
  });

  it.each([
    [{ windows: [] }, 'windows must be an array of 1-24 windows'],
    [{ windows: [{ name: 'Late', start: '25:00', ratio_g_per_unit: 8 }] }, 'window "Late" has invalid start "25:00"'],
    [
      {
        windows: [
          { name: 'A', start: '05:00', ratio_g_per_unit: 8 },
          { name: 'B', start: '05:00', ratio_g_per_unit: 9 },
        ],
      },
      'duplicate window start 05:00',
    ],
    [{ windows: [{ name: 'A', start: '05:00', ratio_g_per_unit: 0 }] }, 'window "A" needs ratio_g_per_unit > 0'],
    [{ correction: { threshold: 200, step: 0, units_per_step: 1, mode: 'started' } }, 'correction.step must be > 0'],
    [{ correction: { threshold: 200, step: 50, units_per_step: 1, mode: 'sometimes' } }, 'correction.mode must be started, full or proportional'],
    [{ rounding: { increment: 0, round_down_below_bg: null } }, 'rounding.increment must be > 0'],
  ])('rejects invalid dose_settings %#', (fields, message) => {
    expect(validateRecord(TABLE_SPECS.dose_settings, doseSettings(fields as never))).toEqual({ ok: false, message });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/sync-validate.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/sync/tables' imported from …/server/test/sync-validate.test.ts`

- [ ] **Step 4: Implement the table specs**

`server/src/sync/tables.ts`:
```ts
import { isVolumeUnit, parseHHMM, VOLUME_UNITS } from '@carbbook/core';

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

export type FieldSpec =
  | { type: 'text'; nullable?: boolean; max?: number }
  | { type: 'number'; nullable?: boolean; min?: number; positive?: boolean; integer?: boolean }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'json'; check: (value: unknown) => string | null };

export interface TableSpec {
  name: SyncTable;
  /** Data columns in schema order, excluding id and sync metadata. */
  fields: Record<string, FieldSpec>;
  /** Only the owner may write (spec §7: viewers cannot change dose settings). */
  ownerOnly?: boolean;
  /** Cross-field rule run after every field is valid. */
  check?: (record: Record<string, unknown>) => string | null;
}

export const META_COLUMNS = ['updated_at', 'updated_by', 'deleted', 'server_seq'] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function checkWindows(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 24) {
    return 'windows must be an array of 1-24 windows';
  }
  const starts = new Set<number>();
  for (const window of value) {
    if (!isObject(window) || typeof window.name !== 'string' || window.name.trim() === '') {
      return 'every window needs a name';
    }
    let minutes: number;
    try {
      minutes = parseHHMM(String(window.start));
    } catch {
      return `window "${window.name}" has invalid start "${String(window.start)}"`;
    }
    if (starts.has(minutes)) return `duplicate window start ${String(window.start)}`;
    starts.add(minutes);
    if (!isFiniteNumber(window.ratio_g_per_unit) || window.ratio_g_per_unit <= 0) {
      return `window "${window.name}" needs ratio_g_per_unit > 0`;
    }
  }
  return null;
}

export function checkCorrection(value: unknown): string | null {
  if (!isObject(value)) return 'correction must be an object';
  if (!isFiniteNumber(value.threshold) || value.threshold < 0) return 'correction.threshold must be >= 0';
  if (!isFiniteNumber(value.step) || value.step <= 0) return 'correction.step must be > 0';
  if (!isFiniteNumber(value.units_per_step) || value.units_per_step < 0) return 'correction.units_per_step must be >= 0';
  if (!['started', 'full', 'proportional'].includes(value.mode as string)) {
    return 'correction.mode must be started, full or proportional';
  }
  return null;
}

export function checkRounding(value: unknown): string | null {
  if (!isObject(value)) return 'rounding must be an object';
  if (!isFiniteNumber(value.increment) || value.increment <= 0) return 'rounding.increment must be > 0';
  const below = value.round_down_below_bg;
  if (below !== null && (!isFiniteNumber(below) || below < 0)) {
    return 'rounding.round_down_below_bg must be null or >= 0';
  }
  return null;
}

const text = (max = 200): FieldSpec => ({ type: 'text', max });
const optionalText = (max = 200): FieldSpec => ({ type: 'text', nullable: true, max });
const REF_TYPES = ['food', 'meal'] as const;

export const TABLE_SPECS: Record<SyncTable, TableSpec> = {
  food: {
    name: 'food',
    fields: {
      name: text(),
      brand: optionalText(),
      source: { type: 'enum', values: ['usda', 'off', 'custom'] },
      source_ref: optionalText(64),
      derived_from: optionalText(64),
      carbs_per_100g: { type: 'number', nullable: true, min: 0 },
      fiber_per_100g: { type: 'number', nullable: true, min: 0 },
      density_g_per_ml: { type: 'number', nullable: true, positive: true },
      notes: optionalText(4000),
    },
  },
  portion: {
    name: 'portion',
    fields: {
      food_id: text(64),
      label: text(),
      kind: { type: 'enum', values: ['volume', 'count', 'serving'] },
      quantity: { type: 'number', positive: true },
      grams: { type: 'number', positive: true },
    },
    check: (r) =>
      r.kind === 'volume' && !isVolumeUnit(String(r.label))
        ? `volume portion label must be one of ${Object.keys(VOLUME_UNITS).join(', ')}`
        : null,
  },
  barcode: {
    name: 'barcode',
    fields: { code: text(32), food_id: text(64) },
  },
  meal: {
    name: 'meal',
    fields: {
      name: text(),
      yield_servings: { type: 'number', positive: true },
      total_weight_g: { type: 'number', nullable: true, positive: true },
      notes: optionalText(4000),
    },
  },
  meal_item: {
    name: 'meal_item',
    fields: {
      meal_id: text(64),
      ref_type: { type: 'enum', values: REF_TYPES },
      ref_id: text(64),
      amount: { type: 'number', min: 0 },
      unit: text(64),
      position: { type: 'number', integer: true, min: 0 },
    },
  },
  log_entry: {
    name: 'log_entry',
    fields: {
      eaten_at: { type: 'number', integer: true, min: 0 },
      window_name: optionalText(),
      bg_mgdl: { type: 'number', nullable: true, min: 0 },
      bg_source: { type: 'enum', values: ['dexcom', 'manual', 'none'] },
      bg_trend: optionalText(64),
      total_carbs_g: { type: 'number', min: 0 },
      suggested_units: { type: 'number', nullable: true, min: 0 },
      taken_units: { type: 'number', nullable: true, min: 0 },
      settings_version_id: optionalText(64),
      notes: optionalText(4000),
    },
  },
  log_item: {
    name: 'log_item',
    fields: {
      log_entry_id: text(64),
      ref_type: { type: 'enum', values: REF_TYPES },
      ref_id: text(64),
      display_name: text(),
      amount: { type: 'number', min: 0 },
      unit: text(64),
      carbs_g: { type: 'number', min: 0 },
    },
  },
  dose_settings: {
    name: 'dose_settings',
    ownerOnly: true,
    fields: {
      effective_from: { type: 'number', integer: true, min: 0 },
      windows: { type: 'json', check: checkWindows },
      correction: { type: 'json', check: checkCorrection },
      rounding: { type: 'json', check: checkRounding },
    },
  },
};

export function isSyncTable(name: unknown): name is SyncTable {
  return typeof name === 'string' && (SYNC_TABLES as readonly string[]).includes(name);
}

export function columnsOf(spec: TableSpec): string[] {
  return ['id', ...Object.keys(spec.fields), ...META_COLUMNS];
}
```

- [ ] **Step 5: Implement validation**

`server/src/sync/validate.ts`:
```ts
import type { FieldSpec, TableSpec } from './tables';

/** A row ready for SQLite: JSON fields are serialized, server_seq is not assigned yet. */
export type SqlRow = Record<string, string | number | null>;

export type ValidationResult = { ok: true; row: SqlRow } | { ok: false; message: string };

const MAX_ID_LENGTH = 64;

function checkField(name: string, spec: FieldSpec, value: unknown): { value: string | number | null } | { error: string } {
  if (spec.type === 'json') {
    const problem = spec.check(value);
    return problem ? { error: problem } : { value: JSON.stringify(value) };
  }
  if (value === undefined || value === null) {
    if ((spec.type === 'text' || spec.type === 'number') && spec.nullable) return { value: null };
    return { error: `${name} is required` };
  }
  switch (spec.type) {
    case 'text':
      if (typeof value !== 'string') return { error: `${name} must be a string` };
      if (!spec.nullable && value.trim() === '') return { error: `${name} must not be empty` };
      if (value.length > (spec.max ?? 200)) return { error: `${name} is longer than ${spec.max ?? 200} characters` };
      return { value };
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `${name} must be a finite number` };
      if (spec.integer && !Number.isSafeInteger(value)) return { error: `${name} must be an integer` };
      if (spec.positive && value <= 0) return { error: `${name} must be > 0` };
      if (spec.min !== undefined && value < spec.min) return { error: `${name} must be >= ${spec.min}` };
      return { value };
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        return { error: `${name} must be one of ${spec.values.join(', ')}` };
      }
      return { value };
  }
}

/** Validates one pushed record against its table spec. Unknown fields are ignored. */
export function validateRecord(spec: TableSpec, record: unknown): ValidationResult {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { ok: false, message: 'record must be an object' };
  }
  const r = record as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id === '' || r.id.length > MAX_ID_LENGTH) {
    return { ok: false, message: `id must be a string of 1-${MAX_ID_LENGTH} characters` };
  }
  if (typeof r.updated_at !== 'number' || !Number.isSafeInteger(r.updated_at) || r.updated_at < 0) {
    return { ok: false, message: 'updated_at must be a non-negative integer (ms)' };
  }
  if (typeof r.updated_by !== 'string' || r.updated_by === '' || r.updated_by.length > MAX_ID_LENGTH) {
    return { ok: false, message: `updated_by must be a string of 1-${MAX_ID_LENGTH} characters` };
  }
  if (r.deleted !== 0 && r.deleted !== 1) return { ok: false, message: 'deleted must be 0 or 1' };

  const row: SqlRow = { id: r.id, updated_at: r.updated_at, updated_by: r.updated_by, deleted: r.deleted };
  for (const [name, fieldSpec] of Object.entries(spec.fields)) {
    const result = checkField(name, fieldSpec, r[name]);
    if ('error' in result) return { ok: false, message: result.error };
    row[name] = result.value;
  }
  const problem = spec.check?.(r);
  if (problem) return { ok: false, message: problem };
  return { ok: true, row };
}

/** Converts a stored row back to the wire shape (JSON columns parsed). */
export function decodeRow(spec: TableSpec, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const [name, fieldSpec] of Object.entries(spec.fields)) {
    if (fieldSpec.type === 'json' && typeof out[name] === 'string') out[name] = JSON.parse(out[name] as string);
  }
  return out;
}
```

- [ ] **Step 6: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/sync-validate.test.ts`
Expected: `Tests  20 passed (20)`

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/sync/tables.ts server/src/sync/validate.ts server/test/sync-helpers.ts server/test/sync-validate.test.ts
git commit -m "feat(server): table specs and per-record sync validation"
```

---

### Task 2: Push with last-write-wins

**Files:**
- Create: `server/src/sync/push.ts`
- Test: `server/test/sync-push.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/sync-push.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { initDatabase } from '../src/init';
import { applyPush } from '../src/sync/push';
import { food, meal } from './sync-helpers';

const SEEDED_SEQ = 1; // one seed dose_settings row

describe('applyPush last-write-wins', () => {
  it('accepts new records and assigns increasing server_seq', () => {
    const db = initDatabase(':memory:');
    const a = food({ id: 'f1' });
    const b = meal({ id: 'm1' });
    expect(applyPush(db, 'owner', [{ table: 'food', record: a }, { table: 'meal', record: b }])).toEqual([
      { table: 'food', id: 'f1', status: 'accepted', server_seq: SEEDED_SEQ + 1 },
      { table: 'meal', id: 'm1', status: 'accepted', server_seq: SEEDED_SEQ + 2 },
    ]);
    expect(db.prepare('SELECT name, server_seq FROM food WHERE id = ?').get('f1')).toEqual({ name: 'Tortilla', server_seq: 2 });
  });

  it('overwrites only with a newer updated_at, and breaks ties by higher updated_by', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', name: 'v1', updated_at: 2000, updated_by: 'laptop' }) }]);

    const older = applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', name: 'old', updated_at: 1999, updated_by: 'zz' }) }]);
    expect(older).toEqual([{ table: 'food', id: 'f1', status: 'ignored', server_seq: 2 }]);

    const tieLower = applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', name: 'tie-low', updated_at: 2000, updated_by: 'ipad' }) }]);
    expect(tieLower[0]!.status).toBe('ignored');

    const tieHigher = applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', name: 'tie-high', updated_at: 2000, updated_by: 'phone' }) }]);
    expect(tieHigher).toEqual([{ table: 'food', id: 'f1', status: 'accepted', server_seq: 3 }]);

    const newer = applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', name: 'v2', updated_at: 2001, updated_by: 'aaa' }) }]);
    expect(newer[0]!.status).toBe('accepted');
    expect(db.prepare('SELECT name FROM food WHERE id = ?').pluck().get('f1')).toBe('v2');
  });

  it('keeps soft deletes as rows', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', updated_at: 1 }) }]);
    applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', updated_at: 2, deleted: 1 }) }]);
    expect(db.prepare('SELECT deleted FROM food WHERE id = ?').pluck().get('f1')).toBe(1);
  });

  it('reports unknown tables and invalid records per record without blocking the rest', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'owner', [
      { table: 'user', record: { id: 'u1' } },
      { table: 'food', record: { ...food({ id: 'bad' }), source: 'mystery' } },
      { table: 'food', record: food({ id: 'good' }) },
    ]);
    expect(results).toEqual([
      { table: 'user', id: 'u1', status: 'rejected', reason: 'unknown_table', message: 'Unknown table "user"' },
      { table: 'food', id: 'bad', status: 'rejected', reason: 'invalid', message: 'source must be one of usda, off, custom' },
      { table: 'food', id: 'good', status: 'accepted', server_seq: 2 },
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/sync-push.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/sync/push' imported from …/server/test/sync-push.test.ts`

- [ ] **Step 3: Implement**

`server/src/sync/push.ts`:
```ts
import { isNewer } from '@carbbook/core';
import type { Role } from '../auth/users';
import { type Db, nextServerSeq } from '../db';
import { columnsOf, isSyncTable, type TableSpec, TABLE_SPECS } from './tables';
import { type SqlRow, validateRecord } from './validate';

export interface PushChange {
  table: string;
  record: unknown;
}

export type RejectReason = 'unknown_table' | 'invalid' | 'forbidden' | 'cycle';

export type PushResult =
  | { table: string; id: string; status: 'accepted'; server_seq: number }
  /** The stored row is newer (or identical); the client picks up the winner on pull. */
  | { table: string; id: string; status: 'ignored'; server_seq: number }
  | { table: string; id: string | null; status: 'rejected'; reason: RejectReason; message: string };

function recordId(record: unknown): string | null {
  const id = (record as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : null;
}

function upsert(db: Db, spec: TableSpec, row: SqlRow): void {
  const columns = columnsOf(spec);
  const updates = columns
    .filter((c) => c !== 'id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  db.prepare(
    `INSERT INTO ${spec.name} (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})
     ON CONFLICT (id) DO UPDATE SET ${updates}`,
  ).run(row);
}

function applyOne(db: Db, _role: Role, change: PushChange): PushResult {
  const id = recordId(change.record);
  const table = String(change.table);
  if (!isSyncTable(change.table)) {
    return { table, id, status: 'rejected', reason: 'unknown_table', message: `Unknown table "${table}"` };
  }
  const spec = TABLE_SPECS[change.table];
  const validation = validateRecord(spec, change.record);
  if (!validation.ok) return { table, id, status: 'rejected', reason: 'invalid', message: validation.message };
  const row = validation.row;
  const rowId = row.id as string;

  const stored = db
    .prepare(`SELECT updated_at, updated_by, server_seq FROM ${spec.name} WHERE id = ?`)
    .get(rowId) as { updated_at: number; updated_by: string; server_seq: number } | undefined;
  const incoming = { updated_at: row.updated_at as number, updated_by: row.updated_by as string };
  if (stored && !isNewer(incoming, stored)) {
    return { table, id: rowId, status: 'ignored', server_seq: stored.server_seq };
  }

  const serverSeq = nextServerSeq(db);
  upsert(db, spec, { ...row, server_seq: serverSeq });
  return { table, id: rowId, status: 'accepted', server_seq: serverSeq };
}

/** Applies pushed records in order inside one transaction; each record gets its own result. */
export function applyPush(db: Db, role: Role, changes: PushChange[]): PushResult[] {
  return db.transaction(() => changes.map((change) => applyOne(db, role, change)))();
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/sync-push.test.ts`
Expected: `Tests  4 passed (4)`

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/sync/push.ts server/test/sync-push.test.ts
git commit -m "feat(server): sync push with last-write-wins per record"
```

---

### Task 3: Push rules — viewer restrictions, append-only dose_settings, and meal cycles

**Files:**
- Modify: `server/src/sync/push.ts` (full replacement)
- Test: `server/test/sync-push-rules.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/sync-push-rules.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { initDatabase } from '../src/init';
import { applyPush } from '../src/sync/push';
import { doseSettings, food, meal, mealItem } from './sync-helpers';

describe('applyPush permissions', () => {
  it('rejects dose_settings from a viewer but accepts their foods, meals and logs', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'viewer', [
      { table: 'dose_settings', record: doseSettings({ id: 'd-viewer' }) },
      { table: 'food', record: food({ id: 'f1' }) },
      {
        table: 'log_entry',
        record: {
          id: 'l1', eaten_at: 1, window_name: 'Lunch', bg_mgdl: 140, bg_source: 'manual', bg_trend: null, total_carbs_g: 40,
          suggested_units: 5, taken_units: 5, settings_version_id: null, notes: null, updated_at: 1, updated_by: 'kim', deleted: 0,
        },
      },
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'accepted', 'accepted']);
    expect(results[0]).toEqual({
      table: 'dose_settings', id: 'd-viewer', status: 'rejected', reason: 'forbidden', message: 'Only the owner can change dose_settings',
    });
    expect(db.prepare('SELECT count(*) FROM dose_settings WHERE id = ?').pluck().get('d-viewer')).toBe(0);
  });

  it('lets the owner save a new dose_settings version', () => {
    const db = initDatabase(':memory:');
    expect(applyPush(db, 'owner', [{ table: 'dose_settings', record: doseSettings({ id: 'd-owner' }) }])[0]!.status).toBe('accepted');
  });
});

describe('applyPush dose_settings append-only rule', () => {
  it('rejects an owner push that soft-deletes an existing dose_settings row', () => {
    const db = initDatabase(':memory:');
    const seeded = db.prepare('SELECT id FROM dose_settings LIMIT 1').get() as { id: string };
    const results = applyPush(db, 'owner', [
      { table: 'dose_settings', record: doseSettings({ id: seeded.id, updated_at: 2000, deleted: 1 }) },
    ]);
    expect(results).toEqual([
      {
        table: 'dose_settings', id: seeded.id, status: 'rejected', reason: 'append_only',
        message: 'dose_settings rows are append-only: cannot delete an existing version',
      },
    ]);
    expect(db.prepare('SELECT deleted FROM dose_settings WHERE id = ?').pluck().get(seeded.id)).toBe(0);
  });

  it('rejects an owner push that edits an existing dose_settings row\'s effective_from, windows, correction or rounding', () => {
    const db = initDatabase(':memory:');
    const created = doseSettings({ id: 'd-owner' });
    applyPush(db, 'owner', [{ table: 'dose_settings', record: created }]);

    const edits = [
      { ...created, updated_at: 2000, effective_from: created.effective_from + 1 },
      { ...created, updated_at: 2000, windows: [{ name: 'Only', start: '00:00', ratio_g_per_unit: 9 }] },
      { ...created, updated_at: 2000, correction: { ...created.correction, threshold: 999 } },
      { ...created, updated_at: 2000, rounding: { ...created.rounding, increment: 2 } },
    ];
    for (const record of edits) {
      const [result] = applyPush(db, 'owner', [{ table: 'dose_settings', record }]);
      expect(result).toEqual({
        table: 'dose_settings', id: 'd-owner', status: 'rejected', reason: 'append_only',
        message: 'dose_settings rows are append-only: cannot edit an existing version, push a new one instead',
      });
    }
    expect(db.prepare('SELECT effective_from FROM dose_settings WHERE id = ?').pluck().get('d-owner')).toBe(created.effective_from);
  });

  it('still accepts a metadata-only republish of the same version (same content, newer updated_at)', () => {
    const db = initDatabase(':memory:');
    const created = doseSettings({ id: 'd-owner' });
    applyPush(db, 'owner', [{ table: 'dose_settings', record: created }]);
    const republish = applyPush(db, 'owner', [{ table: 'dose_settings', record: { ...created, updated_at: 2000 } }]);
    expect(republish[0]!.status).toBe('accepted');
  });
});

describe('applyPush meal cycles', () => {
  it('rejects a meal_item that makes a meal contain itself, directly or transitively', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [
      { table: 'meal', record: meal({ id: 'A' }) },
      { table: 'meal', record: meal({ id: 'B' }) },
      { table: 'meal', record: meal({ id: 'C' }) },
      { table: 'meal_item', record: mealItem('A', 'meal', 'B') },
      { table: 'meal_item', record: mealItem('B', 'meal', 'C') },
    ]);
    const results = applyPush(db, 'owner', [
      { table: 'meal_item', record: mealItem('C', 'meal', 'A', { position: 1 }) },
      { table: 'meal_item', record: mealItem('A', 'meal', 'A', { position: 2 }) },
      { table: 'meal_item', record: mealItem('C', 'food', 'f1', { position: 3 }) },
    ]);
    expect(results.map((r) => (r.status === 'rejected' ? r.reason : r.status))).toEqual(['cycle', 'cycle', 'accepted']);
  });

  it('ignores deleted items when checking, including earlier records in the same push', () => {
    const db = initDatabase(':memory:');
    const aToB = mealItem('A', 'meal', 'B', { updated_at: 1 });
    applyPush(db, 'owner', [{ table: 'meal_item', record: aToB }]);
    const results = applyPush(db, 'owner', [
      { table: 'meal_item', record: { ...aToB, updated_at: 2, deleted: 1 } },
      { table: 'meal_item', record: mealItem('B', 'meal', 'A', { updated_at: 2 }) },
    ]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/sync-push-rules.test.ts`
Expected: FAIL — 5 failed, 2 passed: the original viewer-forbidden and meal-cycle cases fail as before (`expected [ 'accepted', 'accepted', 'accepted' ] to deeply equal [ 'rejected', 'accepted', 'accepted' ]` and `… to deeply equal [ 'cycle', 'cycle', 'accepted' ]`), plus the three new append-only cases fail with e.g. `expected 'accepted' to deeply equal { …, reason: 'append_only', … }` (nothing yet rejects a delete or a field edit of an existing dose_settings row).

- [ ] **Step 3: Implement**

Replace `server/src/sync/push.ts` with:
```ts
import { createCatalog, isNewer, type MealItemData, wouldCreateCycle } from '@carbbook/core';
import type { Role } from '../auth/users';
import { type Db, nextServerSeq } from '../db';
import { columnsOf, isSyncTable, type TableSpec, TABLE_SPECS } from './tables';
import { type SqlRow, validateRecord } from './validate';

export interface PushChange {
  table: string;
  record: unknown;
}

export type RejectReason = 'unknown_table' | 'invalid' | 'forbidden' | 'cycle' | 'append_only';

export type PushResult =
  | { table: string; id: string; status: 'accepted'; server_seq: number }
  /** The stored row is newer (or identical); the client picks up the winner on pull. */
  | { table: string; id: string; status: 'ignored'; server_seq: number }
  | { table: string; id: string | null; status: 'rejected'; reason: RejectReason; message: string };

function recordId(record: unknown): string | null {
  const id = (record as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : null;
}

function upsert(db: Db, spec: TableSpec, row: SqlRow): void {
  const columns = columnsOf(spec);
  const updates = columns
    .filter((c) => c !== 'id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  db.prepare(
    `INSERT INTO ${spec.name} (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})
     ON CONFLICT (id) DO UPDATE SET ${updates}`,
  ).run(row);
}

/** Would saving this meal_item make a meal contain itself? Uses core's wouldCreateCycle. */
function createsCycle(db: Db, row: SqlRow): boolean {
  const items = db
    .prepare(
      `SELECT id, meal_id, ref_type, ref_id, amount, unit, position
         FROM meal_item WHERE deleted = 0 AND id <> ?`,
    )
    .all(row.id) as MealItemData[];
  const candidate = {
    id: row.id,
    meal_id: row.meal_id,
    ref_type: row.ref_type,
    ref_id: row.ref_id,
    amount: row.amount,
    unit: row.unit,
    position: row.position,
  } as MealItemData;
  const catalog = createCatalog({ meal_items: [...items, candidate] });
  return wouldCreateCycle(catalog, candidate.meal_id, candidate.ref_id);
}

/**
 * dose_settings versions are append-only (spec §7): once a version exists, a push may not soft-delete
 * it or change the fields that drive dosing. Only brand-new ids (no `existing` row) are unconstrained.
 */
function dosSettingsAppendOnlyViolation(db: Db, row: SqlRow): 'delete' | 'edit' | null {
  const existing = db
    .prepare('SELECT effective_from, windows, correction, rounding FROM dose_settings WHERE id = ?')
    .get(row.id) as { effective_from: number; windows: string; correction: string; rounding: string } | undefined;
  if (!existing) return null;
  if (row.deleted === 1) return 'delete';
  if (
    row.effective_from !== existing.effective_from ||
    row.windows !== existing.windows ||
    row.correction !== existing.correction ||
    row.rounding !== existing.rounding
  ) {
    return 'edit';
  }
  return null;
}

function applyOne(db: Db, role: Role, change: PushChange): PushResult {
  const id = recordId(change.record);
  const table = String(change.table);
  if (!isSyncTable(change.table)) {
    return { table, id, status: 'rejected', reason: 'unknown_table', message: `Unknown table "${table}"` };
  }
  const spec = TABLE_SPECS[change.table];
  const validation = validateRecord(spec, change.record);
  if (!validation.ok) return { table, id, status: 'rejected', reason: 'invalid', message: validation.message };
  const row = validation.row;
  const rowId = row.id as string;

  if (spec.ownerOnly && role !== 'owner') {
    return { table, id: rowId, status: 'rejected', reason: 'forbidden', message: `Only the owner can change ${table}` };
  }

  const stored = db
    .prepare(`SELECT updated_at, updated_by, server_seq FROM ${spec.name} WHERE id = ?`)
    .get(rowId) as { updated_at: number; updated_by: string; server_seq: number } | undefined;
  const incoming = { updated_at: row.updated_at as number, updated_by: row.updated_by as string };
  if (stored && !isNewer(incoming, stored)) {
    return { table, id: rowId, status: 'ignored', server_seq: stored.server_seq };
  }

  if (spec.name === 'dose_settings') {
    const violation = dosSettingsAppendOnlyViolation(db, row);
    if (violation === 'delete') {
      return {
        table, id: rowId, status: 'rejected', reason: 'append_only',
        message: 'dose_settings rows are append-only: cannot delete an existing version',
      };
    }
    if (violation === 'edit') {
      return {
        table, id: rowId, status: 'rejected', reason: 'append_only',
        message: 'dose_settings rows are append-only: cannot edit an existing version, push a new one instead',
      };
    }
  }

  if (spec.name === 'meal_item' && row.deleted === 0 && row.ref_type === 'meal' && createsCycle(db, row)) {
    return { table, id: rowId, status: 'rejected', reason: 'cycle', message: 'A meal cannot contain itself' };
  }

  const serverSeq = nextServerSeq(db);
  upsert(db, spec, { ...row, server_seq: serverSeq });
  return { table, id: rowId, status: 'accepted', server_seq: serverSeq };
}

/** Applies pushed records in order inside one transaction; each record gets its own result. */
export function applyPush(db: Db, role: Role, changes: PushChange[]): PushResult[] {
  return db.transaction(() => changes.map((change) => applyOne(db, role, change)))();
}
```

- [ ] **Step 4: Run both push test files**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/sync-push-rules.test.ts test/sync-push.test.ts`
Expected: `Test Files  2 passed (2)` and `Tests  11 passed (11)`

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/sync/push.ts server/test/sync-push-rules.test.ts
git commit -m "feat(server): reject viewer dose_settings, non-append-only edits, and meal cycles on push"
```

---

### Task 4: Pull with paging

**Files:**
- Create: `server/src/sync/pull.ts`
- Test: `server/test/sync-pull.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/sync-pull.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { initDatabase } from '../src/init';
import { pullChanges } from '../src/sync/pull';
import { applyPush } from '../src/sync/push';
import { food, meal } from './sync-helpers';

describe('pullChanges', () => {
  it('returns seeded dose settings from since=0 with JSON decoded', () => {
    const db = initDatabase(':memory:');
    const page = pullChanges(db, 0, 500);
    expect(page.has_more).toBe(false);
    expect(page.next_since).toBe(1);
    expect(page.changes.map((c) => c.table)).toEqual(['dose_settings']);
    expect(Array.isArray(page.changes[0]!.record.windows)).toBe(true);
    expect(page.changes[0]!.record.correction).toEqual({ threshold: 200, step: 50, units_per_step: 1, mode: 'started' });
  });

  it('pages across tables in server_seq order', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [
      { table: 'meal', record: meal({ id: 'm1' }) },
      { table: 'food', record: food({ id: 'f1' }) },
      { table: 'meal', record: meal({ id: 'm2' }) },
    ]);
    const first = pullChanges(db, 1, 2);
    expect(first.changes.map((c) => [c.table, c.record.id, c.record.server_seq])).toEqual([
      ['meal', 'm1', 2],
      ['food', 'f1', 3],
    ]);
    expect(first).toMatchObject({ next_since: 3, has_more: true });
    const second = pullChanges(db, first.next_since, 2);
    expect(second.changes.map((c) => c.record.id)).toEqual(['m2']);
    expect(second).toMatchObject({ next_since: 4, has_more: false });
    expect(pullChanges(db, 4, 2)).toEqual({ changes: [], next_since: 4, has_more: false });
  });

  it('includes soft-deleted records so clients learn about deletes', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', updated_at: 1 }) }]);
    applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', updated_at: 2, deleted: 1 }) }]);
    const page = pullChanges(db, 1, 10);
    expect(page.changes).toHaveLength(1);
    expect(page.changes[0]!.record).toMatchObject({ id: 'f1', deleted: 1, server_seq: 3 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/sync-pull.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/sync/pull' imported from …/server/test/sync-pull.test.ts`

- [ ] **Step 3: Implement**

`server/src/sync/pull.ts`:
```ts
import type { Db } from '../db';
import { SYNC_TABLES, type SyncTable, TABLE_SPECS } from './tables';
import { decodeRow } from './validate';

export interface PullChange {
  table: SyncTable;
  record: Record<string, unknown> & { server_seq: number };
}

export interface PullPage {
  changes: PullChange[];
  /** Pass as `since` on the next pull. */
  next_since: number;
  has_more: boolean;
}

/** Records from every synced table with server_seq > since, in server_seq order. */
export function pullChanges(db: Db, since: number, limit: number): PullPage {
  const collected: PullChange[] = [];
  for (const table of SYNC_TABLES) {
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE server_seq > ? ORDER BY server_seq LIMIT ?`)
      .all(since, limit + 1) as Record<string, unknown>[];
    for (const row of rows) {
      collected.push({ table, record: decodeRow(TABLE_SPECS[table], row) as PullChange['record'] });
    }
  }
  collected.sort((a, b) => a.record.server_seq - b.record.server_seq);
  const changes = collected.slice(0, limit);
  const last = changes.at(-1);
  return { changes, next_since: last ? last.record.server_seq : since, has_more: collected.length > limit };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/sync-pull.test.ts`
Expected: `Tests  3 passed (3)`

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/sync/pull.ts server/test/sync-pull.test.ts
git commit -m "feat(server): paged sync pull across tables"
```

---

### Task 5: Sync HTTP routes

**Files:**
- Create: `server/src/routes/sync.ts`
- Modify: `server/src/app.ts` (import + register)
- Test: `server/test/sync-routes.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/sync-routes.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { addUser, loginBearer, loginCookie, makeTestApp } from './helpers';
import { doseSettings, food } from './sync-helpers';

describe('sync routes', () => {
  it('pushes with a cookie and pulls with a bearer token', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const cookie = await loginCookie(app, 'brett');
    const authorization = await loginBearer(app, 'brett');

    const push = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie },
      payload: { changes: [{ table: 'food', record: food({ id: 'f1' }) }] },
    });
    expect(push.statusCode).toBe(200);
    expect(push.json()).toEqual({ results: [{ table: 'food', id: 'f1', status: 'accepted', server_seq: 2 }], server_seq: 2 });

    const pull = await app.inject({ url: '/api/sync/pull?since=1&limit=10', headers: { authorization } });
    expect(pull.statusCode).toBe(200);
    expect(pull.json()).toMatchObject({ next_since: 2, has_more: false, changes: [{ table: 'food', record: { id: 'f1', server_seq: 2 } }] });
  });

  it('reports viewer dose_settings pushes as rejected records (HTTP 200)', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'kim', 'viewer');
    const cookie = await loginCookie(app, 'kim');
    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie },
      payload: { changes: [{ table: 'dose_settings', record: doseSettings({ id: 'd1' }) }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results[0]).toMatchObject({ status: 'rejected', reason: 'forbidden' });
  });

  it('validates the envelope and query', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const cookie = await loginCookie(app, 'brett');
    const tooMany = Array.from({ length: 501 }, () => ({ table: 'food', record: food() }));
    for (const payload of [{}, { changes: 'nope' }, { changes: tooMany }]) {
      const response = await app.inject({ method: 'POST', url: '/api/sync/push', headers: { cookie }, payload });
      expect(response.statusCode).toBe(400);
    }
    expect((await app.inject({ url: '/api/sync/pull?since=-1', headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/sync/pull?limit=5000', headers: { cookie } })).statusCode).toBe(400);
  });

  it('requires auth', async () => {
    const { app } = await makeTestApp();
    expect((await app.inject({ url: '/api/sync/pull' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/sync/push', payload: { changes: [] } })).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/sync-routes.test.ts`
Expected: FAIL — 4 failed, e.g. `expected 404 to be 200`, `expected 404 to be 400`, `expected 404 to be 401`.

- [ ] **Step 3: Implement the routes**

`server/src/routes/sync.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/plugin';
import type { AppContext } from '../context';
import { currentServerSeq } from '../db';
import { pullChanges } from '../sync/pull';
import { applyPush, type PushChange } from '../sync/push';

export const MAX_PUSH_CHANGES = 500;
export const DEFAULT_PULL_LIMIT = 500;
export const MAX_PULL_LIMIT = 1000;

export async function syncRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post<{ Body: { changes: PushChange[] } }>(
    '/api/sync/push',
    {
      schema: {
        body: {
          type: 'object',
          required: ['changes'],
          properties: {
            changes: {
              type: 'array',
              maxItems: MAX_PUSH_CHANGES,
              items: { type: 'object', required: ['table', 'record'], properties: { table: { type: 'string' } } },
            },
          },
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const results = applyPush(ctx.db, auth.user.role, request.body.changes);
      return { results, server_seq: currentServerSeq(ctx.db) };
    },
  );

  app.get<{ Querystring: { since: number; limit: number } }>(
    '/api/sync/pull',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            since: { type: 'integer', minimum: 0, default: 0 },
            limit: { type: 'integer', minimum: 1, maximum: MAX_PULL_LIMIT, default: DEFAULT_PULL_LIMIT },
          },
        },
      },
    },
    async (request) => pullChanges(ctx.db, request.query.since, request.query.limit),
  );
}
```

- [ ] **Step 4: Register them**

In `server/src/app.ts` add the import:
```ts
import { syncRoutes } from './routes/sync';
```
and inside the authenticated scope, after `await api.register(bgRoutes, ctx);`, add:
```ts
    await api.register(syncRoutes, ctx);
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/sync-routes.test.ts`
Expected: `Tests  4 passed (4)`

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/routes/sync.ts server/src/app.ts server/test/sync-routes.test.ts
git commit -m "feat(server): sync push/pull HTTP routes"
```

---

### Task 6: Two-client sync scenarios (spec §10)

**Files:**
- Test: `server/test/sync-scenarios.test.ts`

This task adds end-to-end tests over the routes built in Tasks 2–5; they should pass without new production code. A failure here is a real sync bug — fix it in `push.ts`/`pull.ts` before continuing.

- [ ] **Step 1: Write the scenarios**

`server/test/sync-scenarios.test.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { PushResult } from '../src/sync/push';
import { addUser, loginBearer, loginCookie, makeTestApp } from './helpers';
import { doseSettings, food } from './sync-helpers';

type Rec = Record<string, unknown> & { id: string };

/** A minimal offline-first client: local rows + pending queue, push then pull until drained (spec §5). */
class SimClient {
  rows = new Map<string, Rec>();
  pending = new Map<string, { table: string; record: Rec }>();
  since = 0;
  lastResults: PushResult[] = [];

  constructor(
    private app: FastifyInstance,
    private headers: Record<string, string>,
    readonly deviceId: string,
  ) {}

  write(table: string, record: Rec, at: number): void {
    const stamped = { ...record, updated_at: at, updated_by: this.deviceId };
    this.rows.set(`${table}/${record.id}`, stamped);
    this.pending.set(`${table}/${record.id}`, { table, record: stamped });
  }

  get(table: string, id: string): Rec | undefined {
    return this.rows.get(`${table}/${id}`);
  }

  async sync(): Promise<void> {
    if (this.pending.size > 0) {
      const push = await this.app.inject({
        method: 'POST',
        url: '/api/sync/push',
        headers: this.headers,
        payload: { changes: [...this.pending.values()] },
      });
      if (push.statusCode !== 200) throw new Error(`push failed ${push.statusCode}: ${push.body}`);
      this.lastResults = push.json().results;
      this.pending.clear();
    }
    for (;;) {
      const pull = await this.app.inject({ url: `/api/sync/pull?since=${this.since}&limit=2`, headers: this.headers });
      const page = pull.json() as { changes: { table: string; record: Rec }[]; next_since: number; has_more: boolean };
      for (const change of page.changes) this.rows.set(`${change.table}/${change.record.id}`, change.record);
      this.since = page.next_since;
      if (!page.has_more) break;
    }
  }
}

async function setup() {
  const t = await makeTestApp();
  await addUser(t.db, 'brett', 'owner');
  await addUser(t.db, 'kim', 'viewer');
  const phone = new SimClient(t.app, { authorization: await loginBearer(t.app, 'brett') }, 'phone');
  const laptop = new SimClient(t.app, { cookie: await loginCookie(t.app, 'brett') }, 'laptop');
  const viewer = new SimClient(t.app, { cookie: await loginCookie(t.app, 'kim') }, 'kim-web');
  return { ...t, phone, laptop, viewer };
}

describe('two clients syncing through the server', () => {
  it('converges on the newer offline edit regardless of reconnect order', async () => {
    const { phone, laptop } = await setup();
    phone.write('food', food({ id: 'f1', name: 'Tortilla' }), 1000);
    await phone.sync();
    await laptop.sync();
    expect(laptop.get('food', 'f1')?.name).toBe('Tortilla');

    // Both go offline and edit the same food; the laptop edit is newer but reconnects first.
    phone.write('food', { ...phone.get('food', 'f1')!, name: 'Phone edit' }, 2000);
    laptop.write('food', { ...laptop.get('food', 'f1')!, name: 'Laptop edit' }, 3000);
    await laptop.sync();
    await phone.sync();
    expect(phone.lastResults[0]).toMatchObject({ status: 'ignored' });
    await laptop.sync();

    expect(phone.get('food', 'f1')?.name).toBe('Laptop edit');
    expect(laptop.get('food', 'f1')?.name).toBe('Laptop edit');
  });

  it('breaks updated_at ties by the higher device id on both clients', async () => {
    const { phone, laptop } = await setup();
    phone.write('food', food({ id: 'f1', name: 'from phone' }), 5000);
    laptop.write('food', food({ id: 'f1', name: 'from laptop' }), 5000);
    await phone.sync();
    await laptop.sync();
    await phone.sync();
    expect(phone.get('food', 'f1')?.name).toBe('from phone');
    expect(laptop.get('food', 'f1')?.name).toBe('from phone');
  });

  it('propagates a newer offline delete over an older edit, and a later edit restores the record', async () => {
    const { phone, laptop } = await setup();
    phone.write('food', food({ id: 'f1' }), 1000);
    await phone.sync();
    await laptop.sync();

    laptop.write('food', { ...laptop.get('food', 'f1')!, name: 'Edited' }, 2000);
    phone.write('food', { ...phone.get('food', 'f1')!, deleted: 1 }, 2500);
    await phone.sync();
    await laptop.sync();
    await phone.sync();
    expect(laptop.get('food', 'f1')).toMatchObject({ deleted: 1 });
    expect(phone.get('food', 'f1')).toMatchObject({ deleted: 1 });

    laptop.write('food', { ...laptop.get('food', 'f1')!, deleted: 0, name: 'Restored' }, 4000);
    await laptop.sync();
    await phone.sync();
    expect(phone.get('food', 'f1')).toMatchObject({ deleted: 0, name: 'Restored' });
  });

  it('rejects viewer dose_settings while syncing the rest of the batch', async () => {
    const { phone, viewer } = await setup();
    viewer.write('food', food({ id: 'kim-food', name: 'Kim snack' }), 1000);
    viewer.write('dose_settings', doseSettings({ id: 'kim-dose' }), 1000);
    await viewer.sync();
    expect(viewer.lastResults.map((r) => r.status)).toEqual(['accepted', 'rejected']);

    await phone.sync();
    expect(phone.get('food', 'kim-food')?.name).toBe('Kim snack');
    expect(phone.get('dose_settings', 'kim-dose')).toBeUndefined();
    // The viewer's local copy still holds its rejected row plus the one seeded version from the server.
    expect([...viewer.rows.keys()].filter((k) => k.startsWith('dose_settings/'))).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the scenarios**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/sync-scenarios.test.ts`
Expected: `Tests  4 passed (4)`

- [ ] **Step 3: Commit**

```bash
cd ~/Projects/CarbBook
git add server/test/sync-scenarios.test.ts
git commit -m "test(server): two-client offline sync scenarios"
```

---

### Task 7: Migration 002 — USDA tables and FTS5 indexes

**Files:**
- Create: `server/migrations/002_usda_search.sql`
- Test: `server/test/migration-002.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/migration-002.test.ts`:
```ts
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrate, openDb } from '../src/db';

const catalog = (db: ReturnType<typeof openDb>) =>
  db.prepare('SELECT kind, ref_id, name FROM catalog_fts ORDER BY kind, ref_id').all();

describe('migration 002 (USDA + search)', () => {
  it('backfills catalog_fts from rows written before the migration', () => {
    const onlyFirst = mkdtempSync(join(tmpdir(), 'carbbook-mig-'));
    copyFileSync(join(MIGRATIONS_DIR, '001_init.sql'), join(onlyFirst, '001_init.sql'));
    const db = openDb(':memory:');
    migrate(db, onlyFirst);
    db.prepare(
      "INSERT INTO food (id, name, source, updated_at, updated_by, deleted, server_seq) VALUES ('f1', 'Tortilla', 'custom', 1, 'd', 0, 1), ('f2', 'Gone', 'custom', 1, 'd', 1, 2)",
    ).run();
    db.prepare("INSERT INTO meal (id, name, updated_at, updated_by, deleted, server_seq) VALUES ('m1', 'Tacos', 1, 'd', 0, 3)").run();

    expect(readdirSync(MIGRATIONS_DIR)).toContain('002_usda_search.sql');
    expect(migrate(db)).toBe(2);
    expect(catalog(db)).toEqual([
      { kind: 'food', ref_id: 'f1', name: 'Tortilla' },
      { kind: 'meal', ref_id: 'm1', name: 'Tacos' },
    ]);
  });

  it('keeps catalog_fts in sync on insert, rename, soft delete and undelete', () => {
    const db = openDb(':memory:');
    migrate(db);
    const upsert = db.prepare(
      `INSERT INTO food (id, name, source, updated_at, updated_by, deleted, server_seq) VALUES (@id, @name, 'custom', 1, 'd', @deleted, 1)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, deleted = excluded.deleted`,
    );
    upsert.run({ id: 'f1', name: 'Tortilla', deleted: 0 });
    upsert.run({ id: 'f1', name: 'Flour tortilla', deleted: 0 });
    expect(catalog(db)).toEqual([{ kind: 'food', ref_id: 'f1', name: 'Flour tortilla' }]);
    upsert.run({ id: 'f1', name: 'Flour tortilla', deleted: 1 });
    expect(catalog(db)).toEqual([]);
    upsert.run({ id: 'f1', name: 'Flour tortilla', deleted: 0 });
    expect(catalog(db)).toEqual([{ kind: 'food', ref_id: 'f1', name: 'Flour tortilla' }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/migration-002.test.ts`
Expected: FAIL — `expected [ '001_init.sql' ] to include '002_usda_search.sql'` and `SqliteError: no such table: catalog_fts`.

- [ ] **Step 3: Write the migration**

`server/migrations/002_usda_search.sql`:
```sql
-- USDA reference library (spec §6) and full-text search for foods, meals and USDA.

CREATE TABLE usda_food (
  fdc_id INTEGER PRIMARY KEY,
  data_type TEXT NOT NULL,
  name TEXT NOT NULL,
  carbs_per_100g REAL,
  fiber_per_100g REAL
);

-- id = FDC food_portion.id; label/kind follow core's PortionData rules.
CREATE TABLE usda_portion (
  id INTEGER PRIMARY KEY,
  fdc_id INTEGER NOT NULL REFERENCES usda_food (fdc_id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('volume', 'count', 'serving')),
  quantity REAL NOT NULL,
  grams REAL NOT NULL,
  description TEXT NOT NULL
);
CREATE INDEX usda_portion_fdc ON usda_portion (fdc_id);

-- External-content index; rebuilt after each import.
CREATE VIRTUAL TABLE usda_fts USING fts5 (
  name,
  content = 'usda_food',
  content_rowid = 'fdc_id',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- User library (food + meal), kept current by triggers.
CREATE VIRTUAL TABLE catalog_fts USING fts5 (
  kind UNINDEXED,
  ref_id UNINDEXED,
  name,
  brand,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO catalog_fts (kind, ref_id, name, brand)
  SELECT 'food', id, name, coalesce(brand, '') FROM food WHERE deleted = 0;
INSERT INTO catalog_fts (kind, ref_id, name, brand)
  SELECT 'meal', id, name, '' FROM meal WHERE deleted = 0;

CREATE TRIGGER food_catalog_insert AFTER INSERT ON food WHEN new.deleted = 0 BEGIN
  INSERT INTO catalog_fts (kind, ref_id, name, brand) VALUES ('food', new.id, new.name, coalesce(new.brand, ''));
END;

CREATE TRIGGER food_catalog_update AFTER UPDATE ON food BEGIN
  DELETE FROM catalog_fts WHERE kind = 'food' AND ref_id = old.id;
  INSERT INTO catalog_fts (kind, ref_id, name, brand)
    SELECT 'food', new.id, new.name, coalesce(new.brand, '') WHERE new.deleted = 0;
END;

CREATE TRIGGER meal_catalog_insert AFTER INSERT ON meal WHEN new.deleted = 0 BEGIN
  INSERT INTO catalog_fts (kind, ref_id, name, brand) VALUES ('meal', new.id, new.name, '');
END;

CREATE TRIGGER meal_catalog_update AFTER UPDATE ON meal BEGIN
  DELETE FROM catalog_fts WHERE kind = 'meal' AND ref_id = old.id;
  INSERT INTO catalog_fts (kind, ref_id, name, brand)
    SELECT 'meal', new.id, new.name, '' WHERE new.deleted = 0;
END;
```

- [ ] **Step 4: Run it and the earlier database tests**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/migration-002.test.ts test/db.test.ts test/seed.test.ts`
Expected: `Test Files  3 passed (3)` and `Tests  11 passed (11)`

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add server/migrations/002_usda_search.sql server/test/migration-002.test.ts
git commit -m "feat(server): USDA tables and FTS5 search indexes"
```

---

### Task 8: USDA portion normalization

**Files:**
- Create: `server/src/usda/portions.ts`
- Test: `server/test/usda-portions.test.ts`

- [ ] **Step 1: Write the failing test**

All rows below are real FDC `food_portion.csv` rows except ids 900001/900002, which exercise the unit id 1118 "Tablespoons" and FNDDS "1/4 cup" patterns found in the downloads.

`server/test/usda-portions.test.ts`:
```ts
import { foodAmountToGrams, type FoodData, type PortionData } from '@carbbook/core';
import { describe, expect, it } from 'vitest';
import { type FdcPortionRow, normalizePortion, splitLeadingQuantity } from '../src/usda/portions';

const UNITS = new Map([
  ['1000', 'cup'],
  ['1001', 'tablespoon'],
  ['1002', 'teaspoon'],
  ['1009', 'fl oz'],
  ['1044', 'pieces'],
  ['1045', 'quart'],
  ['1060', 'wedge'],
  ['1071', 'each'],
  ['1118', 'Tablespoons'],
]);

/** Columns: id, fdc_id, amount, measure_unit_id, portion_description, modifier, gram_weight (real FDC rows). */
const row = (...c: [string, string, string, string, string, string, string]): FdcPortionRow => ({
  id: c[0],
  fdc_id: c[1],
  amount: c[2],
  measure_unit_id: c[3],
  portion_description: c[4],
  modifier: c[5],
  gram_weight: c[6],
});

describe('splitLeadingQuantity', () => {
  it.each([
    ['1 cup', 1, 'cup'],
    ['1/4 cup', 0.25, 'cup'],
    ['1 1/2 cups', 1.5, 'cups'],
    ['0.5 fl oz', 0.5, 'fl oz'],
    ['Quantity not specified', null, 'Quantity not specified'],
  ])('%s', (input, quantity, text) => {
    expect(splitLeadingQuantity(input)).toEqual({ quantity, text });
  });
});

describe('normalizePortion — Foundation (measure_unit_id set)', () => {
  it.each([
    [row('119207', '324860', '2.0', '1001', '', '', '32.0'), { label: 'tbsp', kind: 'volume', quantity: 2, grams: 32, description: 'tablespoon' }],
    [row('118952', '322892', '1.0', '1009', '', '', '30.5'), { label: 'floz', kind: 'volume', quantity: 1, grams: 30.5, description: 'fl oz' }],
    [row('118954', '322892', '1.0', '1045', '', '', '976.0'), { label: 'cup', kind: 'volume', quantity: 4, grams: 976, description: 'quart' }],
    [row('119057', '323505', '1.0', '1000', '', 'pieces of ~1"', '20.6'), { label: 'cup', kind: 'volume', quantity: 1, grams: 20.6, description: 'cup, pieces of ~1"' }],
    [row('121452', '332597', '1.0', '1071', '', 'large', '230.0'), { label: 'large', kind: 'count', quantity: 1, grams: 230, description: 'large' }],
    [row('187511', '746770', '10.0', '1044', '', 'balls', '138.0'), { label: 'pieces, balls', kind: 'count', quantity: 10, grams: 138, description: 'pieces, balls' }],
    [row('187506', '746770', '1.0', '1060', '', 'large (1/8 of large melon)', '102.0'), { label: 'wedge, large (1/8 of large melon)', kind: 'count', quantity: 1, grams: 102, description: 'wedge, large (1/8 of large melon)' }],
    [row('900001', '1', '1.0', '1118', '', '', '14.0'), { label: 'tbsp', kind: 'volume', quantity: 1, grams: 14, description: 'Tablespoons' }],
  ])('row %#', (input, expected) => {
    expect(normalizePortion(input, UNITS)).toEqual({ id: Number(input.id), fdc_id: Number(input.fdc_id), ...expected });
  });
});

describe('normalizePortion — SR Legacy (unit in modifier)', () => {
  it.each([
    [row('94062', '174273', '1', '9999', '', 'cup, stirred', '84'), { label: 'cup', kind: 'volume', quantity: 1, grams: 84, description: 'cup, stirred' }],
    [row('94063', '174273', '1', '9999', '', 'tbsp', '5.2'), { label: 'tbsp', kind: 'volume', quantity: 1, grams: 5.2, description: 'tbsp' }],
    [row('94693', '174643', '0.75', '9999', '', 'cup (1 NLEA serving)', '27'), { label: 'cup', kind: 'volume', quantity: 0.75, grams: 27, description: 'cup (1 NLEA serving)' }],
    [row('85728', '169944', '1', '9999', '', 'slice or ring (3" dia) with liquid', '49'), { label: 'slice or ring (3" dia) with liquid', kind: 'count', quantity: 1, grams: 49, description: 'slice or ring (3" dia) with liquid' }],
    [row('81549', '167512', '1', '9999', '', 'serving', '34'), { label: 'serving', kind: 'serving', quantity: 1, grams: 34, description: 'serving' }],
  ])('row %#', (input, expected) => {
    expect(normalizePortion(input, UNITS)).toEqual({ id: Number(input.id), fdc_id: Number(input.fdc_id), ...expected });
  });

  it('drops mass portions (4 oz steak) because mass units are always available', () => {
    expect(normalizePortion(row('83480', '168642', '4', '9999', '', 'oz', '113'), UNITS)).toBeNull();
  });
});

describe('normalizePortion — FNDDS (text in portion_description, modifier is a code)', () => {
  it.each([
    [row('290506', '2705383', '', '9999', '1 cup', '10205', '246.0'), { label: 'cup', kind: 'volume', quantity: 1, grams: 246, description: 'cup' }],
    [row('290508', '2705383', '', '9999', '1 fl oz', '30000', '30.8'), { label: 'floz', kind: 'volume', quantity: 1, grams: 30.8, description: 'fl oz' }],
    [row('302942', '2708432', '', '9999', '1 cup, cooked', '10043', '155.0'), { label: 'cup', kind: 'volume', quantity: 1, grams: 155, description: 'cup, cooked' }],
    [row('293579', '2706093', '', '9999', '1 nugget', '61508', '16.0'), { label: 'nugget', kind: 'count', quantity: 1, grams: 16, description: 'nugget' }],
    [row('293582', '2706093', '', '9999', 'Quantity not specified', '90000', '80.0'), { label: 'Quantity not specified', kind: 'serving', quantity: 1, grams: 80, description: 'Quantity not specified' }],
    [row('900002', '2', '', '9999', '1/4 cup', '10210', '60.0'), { label: 'cup', kind: 'volume', quantity: 0.25, grams: 60, description: 'cup' }],
  ])('row %#', (input, expected) => {
    expect(normalizePortion(input, UNITS)).toEqual({ id: Number(input.id), fdc_id: Number(input.fdc_id), ...expected });
  });

  it('keeps "cup, dry, yields" as a count portion so it does not define a bogus density', () => {
    expect(normalizePortion(row('302943', '2708432', '', '9999', '1 cup, dry, yields', '10074', '624.0'), UNITS)).toMatchObject({
      label: 'cup, dry, yields',
      kind: 'count',
    });
  });

  it('drops zero-gram and mass rows', () => {
    expect(normalizePortion(row('290507', '2705383', '', '9999', 'Quantity not specified', '90000', '0.0'), UNITS)).toBeNull();
    expect(normalizePortion(row('302944', '2708432', '', '9999', '1 oz, dry, yields', '40049', '95.0'), UNITS)).toBeNull();
  });
});

describe('normalized portions work with core unit conversion', () => {
  it('derives density from a USDA cup portion', () => {
    const milk: FoodData = { id: 'usda:322892', name: 'Milk', carbs_per_100g: 4.67 };
    const portions = [row('118951', '322892', '1.0', '1000', '', '', '229.0'), row('118953', '322892', '1.0', '1001', '', '', '15.0')]
      .map((r) => normalizePortion(r, UNITS)!)
      .map((p): PortionData => ({ id: String(p.id), food_id: milk.id, label: p.label, kind: p.kind, quantity: p.quantity, grams: p.grams }));
    expect(foodAmountToGrams(1, 'cup', milk, portions)).toBeCloseTo(229, 6);
    expect(foodAmountToGrams(2, 'tbsp', milk, portions)).toBeCloseTo(28.63, 2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/usda-portions.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/usda/portions' imported from …/server/test/usda-portions.test.ts`

- [ ] **Step 3: Implement**

`server/src/usda/portions.ts`:
```ts
import type { PortionKind, VolumeUnit } from '@carbbook/core';

/** A food_portion.csv row (all FDC datasets share these columns). */
export interface FdcPortionRow {
  id: string;
  fdc_id: string;
  amount: string;
  measure_unit_id: string;
  portion_description: string;
  modifier: string;
  gram_weight: string;
}

export interface UsdaPortion {
  id: number;
  fdc_id: number;
  /** Core volume unit id when kind is "volume", otherwise the human label. */
  label: string;
  kind: PortionKind;
  quantity: number;
  grams: number;
  /** Original USDA wording, e.g. "cup, chopped". */
  description: string;
}

export const UNDETERMINED_UNIT_ID = '9999';

/** Lower-case USDA spellings → core volume unit id and multiplier. Longest match wins. */
const VOLUME_ALIASES: ReadonlyArray<readonly [string, VolumeUnit, number]> = (
  [
    ['fluid ounces', 'floz', 1],
    ['fluid ounce', 'floz', 1],
    ['fl oz', 'floz', 1],
    ['tablespoons', 'tbsp', 1],
    ['tablespoon', 'tbsp', 1],
    ['tbsp', 'tbsp', 1],
    ['teaspoons', 'tsp', 1],
    ['teaspoon', 'tsp', 1],
    ['tsp', 'tsp', 1],
    ['cups', 'cup', 1],
    ['cup', 'cup', 1],
    ['milliliters', 'ml', 1],
    ['milliliter', 'ml', 1],
    ['cubic centimeters', 'ml', 1],
    ['cubic centimeter', 'ml', 1],
    ['ml', 'ml', 1],
    ['liters', 'l', 1],
    ['liter', 'l', 1],
    ['quarts', 'cup', 4],
    ['quart', 'cup', 4],
    ['pints', 'cup', 2],
    ['pint', 'cup', 2],
    ['gallons', 'cup', 16],
    ['gallon', 'cup', 16],
  ] as const
)
  .slice()
  .sort((a, b) => b[0].length - a[0].length);

/** Mass portions duplicate the always-available mass units, so they are dropped. */
const MASS_WORDS = new Set(['oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'pounds', 'g', 'gram', 'grams', 'kg']);
/** Unit names that add nothing when a modifier is present ("each, large" → "large"). */
const GENERIC_UNITS = new Set(['each', 'unit']);
const SERVING_RE = /^(serving|nlea serving|quantity not specified|guideline amount)/i;

function matchVolume(text: string): { unit: VolumeUnit; factor: number; rest: string } | null {
  const lower = text.toLowerCase();
  for (const [alias, unit, factor] of VOLUME_ALIASES) {
    if (!lower.startsWith(alias)) continue;
    const next = lower.charAt(alias.length);
    if (next === '' || next === ' ' || next === ',' || next === '(' || next === ';') {
      return { unit, factor, rest: text.slice(alias.length).replace(/^[\s,;]+/, '') };
    }
  }
  return null;
}

/** "1 cup" → 1, "1/4 cup" → 0.25, "1 1/2 cups" → 1.5. */
export function splitLeadingQuantity(text: string): { quantity: number | null; text: string } {
  const match = /^(\d+\s+\d+\/\d+|\d+\/\d+|\d*\.?\d+)\s+(.+)$/.exec(text);
  if (!match) return { quantity: null, text };
  const token = match[1]!;
  let quantity: number;
  if (token.includes('/')) {
    const [whole, fraction] = token.includes(' ') ? token.split(/\s+/) : ['0', token];
    const [num, den] = fraction!.split('/').map(Number);
    quantity = Number(whole) + num! / den!;
  } else {
    quantity = Number(token);
  }
  return { quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null, text: match[2]! };
}

function positive(value: string): number | null {
  const n = Number(value);
  return value.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Normalizes an FDC portion row to core's portion model:
 * - Foundation: unit in measure_unit_id, text in modifier ("1.0" + cup + "chopped").
 * - SR Legacy: measure_unit_id 9999, unit is the start of modifier ("1" + "cup, chopped").
 * - FNDDS: measure_unit_id 9999, amount empty, "1 cup, cooked" in portion_description; modifier is a code.
 * Returns null for zero-gram rows and mass portions.
 */
export function normalizePortion(row: FdcPortionRow, unitNames: ReadonlyMap<string, string>): UsdaPortion | null {
  const grams = positive(row.gram_weight);
  if (grams === null) return null;
  const unitName = row.measure_unit_id === UNDETERMINED_UNIT_ID ? undefined : unitNames.get(row.measure_unit_id);
  const description = row.portion_description.trim();
  const modifier = row.modifier.trim();

  let quantity = positive(row.amount) ?? 1;
  let text: string;
  if (unitName) {
    const extra = [description, modifier].filter(Boolean);
    text = (GENERIC_UNITS.has(unitName.toLowerCase()) && extra.length > 0 ? extra : [unitName, ...extra]).join(', ');
  } else if (description) {
    const split = splitLeadingQuantity(description);
    quantity = split.quantity ?? 1;
    text = split.text;
  } else {
    text = modifier;
  }
  if (!text) return null;

  const base = { id: Number(row.id), fdc_id: Number(row.fdc_id), grams, description: text };
  const volume = matchVolume(text);
  if (volume && !/\byields?\b/i.test(volume.rest)) {
    return { ...base, label: volume.unit, kind: 'volume', quantity: quantity * volume.factor };
  }
  const firstWord = text.toLowerCase().split(/[\s,(]+/)[0] ?? '';
  if (MASS_WORDS.has(firstWord)) return null;
  return { ...base, label: text, kind: SERVING_RE.test(text) ? 'serving' : 'count', quantity };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/usda-portions.test.ts`
Expected: `Tests  28 passed (28)`

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/usda/portions.ts server/test/usda-portions.test.ts
git commit -m "feat(server): normalize USDA portions to core volume/count/serving units"
```

---

### Task 9: USDA CSV importer

**Files:**
- Create: `server/src/usda/import.ts`, `server/test/fixtures/usda/{foundation,sr_legacy,survey}/{food,food_nutrient,food_portion,measure_unit}.csv`
- Modify: `server/test/fixtures.ts` (full replacement)
- Test: `server/test/usda-import.test.ts`

- [ ] **Step 1: Create the fixture CSVs (rows copied from the real downloads)**

`server/test/fixtures/usda/foundation/food.csv`:
```csv
"fdc_id","data_type","description","food_category_id","publication_date"
"319877","sub_sample_food","Hummus","16","2019-04-01"
"322892","foundation_food","Milk, whole, 3.25% milkfat, with added vitamin D","1","2019-04-01"
"323505","foundation_food","Kale, raw","11","2019-04-01"
"324860","foundation_food","Peanut butter, smooth style, with salt","16","2019-04-01"
"332597","foundation_food","Pears, raw, bartlett (Includes foods for USDA's Food Distribution Program)","9","2019-04-01"
"746770","foundation_food","Melons, cantaloupe, raw","9","2019-12-16"
```

`server/test/fixtures/usda/foundation/food_nutrient.csv`:
```csv
"id","fdc_id","nutrient_id","amount","data_points","derivation_id","min","max","median","footnote","min_year_acquired"
"2226446","322892","1008","60.0","","49","","","","",""
"2226445","322892","1005","4.67","","49","","","","",""
"2229563","323505","1079","4.1","2","1","4.0","4.2","4.1","","2015"
"2229571","323505","1005","4.42","","49","","","","",""
"2234226","324860","1079","4.8","9","1","3.6","6.1","4.9","","2013"
"2234280","324860","1005","22.3","","49","","","","",""
"2262294","332597","1079","3.1","6","1","2.5","3.7","3.1","","2000"
"2262322","332597","1005","15.1","","49","","","","",""
"8514995","746770","1079","0.8","","4","","","","",""
"8514985","746770","1005","8.16","","49","","","","",""
"2199001","319877","1005","14.3","","1","","","","",""
```

`server/test/fixtures/usda/foundation/food_portion.csv`:
```csv
"id","fdc_id","seq_num","amount","measure_unit_id","portion_description","modifier","gram_weight","data_points","footnote","min_year_acquired"
"118951","322892","1","1.0","1000","","","229.0","25","","2018"
"118952","322892","2","1.0","1009","","","30.5","1","","2018"
"118953","322892","3","1.0","1001","","","15.0","1","","2018"
"118954","322892","4","1.0","1045","","","976.0","1","","2018"
"119057","323505","1","1.0","1000","","pieces of ~1""","20.6","9","","2015"
"119207","324860","1","2.0","1001","","","32.0","1","","2013"
"119208","324860","2","1.0","1000","","","258.0","1","","2013"
"121449","332597","1","1.0","1000","","slices","140.0","1","","2000"
"121452","332597","4","1.0","1071","","large","230.0","1","","2000"
"187503","746770","1","1.0","1000","","cubes","160.0","1","","2001"
"187506","746770","4","1.0","1060","","large (1/8 of large melon)","102.0","1","","2001"
"187511","746770","9","10.0","1044","","balls","138.0","1","","2001"
```

`server/test/fixtures/usda/foundation/measure_unit.csv`:
```csv
"id","name"
"1000","cup"
"1001","tablespoon"
"1002","teaspoon"
"1009","fl oz"
"1044","pieces"
"1045","quart"
"1060","wedge"
"1071","each"
"9999","undetermined"
```

`server/test/fixtures/usda/sr_legacy/food.csv`:
```csv
"fdc_id","data_type","description","food_category_id","publication_date"
"168642","sr_legacy_food","Beef, short loin, t-bone steak, bone-in, separable lean only, trimmed to 1/8"" fat, all grades, raw","13","2019-04-01"
"169944","sr_legacy_food","Pineapple, canned, heavy syrup pack, solids and liquids","9","2019-04-01"
"174273","sr_legacy_food","Soy flour, full-fat, raw","16","2019-04-01"
"174643","sr_legacy_food","Cereals ready-to-eat, MALT-O-MEAL, GOLDEN PUFFS","8","2019-04-01"
```

`server/test/fixtures/usda/sr_legacy/food_nutrient.csv`:
```csv
"id","fdc_id","nutrient_id","amount","data_points","derivation_id","min","max","median","footnote","min_year_acquired"
"1376998","168642","1008","153","0","49","","","","",""
"1377072","168642","1079","0","0","68","","","","",""
"1377108","168642","1005","0","0","49","","","","",""
"1481867","169944","1079","0.8","0","","","","","",""
"1481888","169944","1005","20.2","0","49","","","","",""
"1845408","174273","1005","31.92","0","49","","","","",""
"1845446","174273","1079","9.6","0","","","","","",""
"1874861","174643","1005","89.72","0","49","","","","",""
"1874922","174643","1079","2.6","3","1","2.5","2.8","","",""
```

`server/test/fixtures/usda/sr_legacy/food_portion.csv`:
```csv
"id","fdc_id","seq_num","amount","measure_unit_id","portion_description","modifier","gram_weight","data_points","footnote","min_year_acquired"
"83480","168642","1","4","9999","","oz","113","","",""
"83481","168642","2","1","9999","","steak","460","36","",""
"85727","169944","1","1","9999","","cup, crushed, sliced, or chunks","254","","",""
"85728","169944","2","1","9999","","slice or ring (3"" dia) with liquid","49","","",""
"94062","174273","1","1","9999","","cup, stirred","84","","",""
"94063","174273","2","1","9999","","tbsp","5.2","","",""
"94693","174643","1","0.75","9999","","cup (1 NLEA serving)","27","","",""
"94694","174643","2","1","9999","","cup","37","3","",""
```

`server/test/fixtures/usda/sr_legacy/measure_unit.csv`:
```csv
"id","name"
"1000","cup"
"9999","undetermined"
```

`server/test/fixtures/usda/survey/food.csv`:
```csv
"fdc_id","data_type","description","food_category_id","publication_date"
"2705383","survey_fndds_food","Milk, human","9602","2022-10-28"
"2706093","survey_fndds_food","Chicken nuggets, from fast food","2204","2022-10-28"
"2708432","survey_fndds_food","Rice, white, cooked with fat, Puerto Rican style","4002","2022-10-28"
```

`server/test/fixtures/usda/survey/food_nutrient.csv` (FNDDS stores nutrient numbers: 205 carbs, 291 fiber, 301 calcium):
```csv
"id","fdc_id","nutrient_id","amount","data_points","derivation_id","min","max","median","footnote","min_year_acquired"
"34182246","2706093","205","14.93","","","","","","",""
"34182253","2706093","291","0.9","","","","","","",""
"34334288","2708432","291","0.5","","","","","","",""
"34334281","2708432","205","31.9","","","","","","",""
"34334282","2708432","301","3","","","","","","",""
```

`server/test/fixtures/usda/survey/food_portion.csv`:
```csv
"id","fdc_id","seq_num","amount","measure_unit_id","portion_description","modifier","gram_weight","data_points","footnote","min_year_acquired"
"290506","2705383","1","","9999","1 cup","10205","246.0","","",""
"290507","2705383","2","","9999","Quantity not specified","90000","0.0","","",""
"290508","2705383","3","","9999","1 fl oz","30000","30.8","","",""
"293579","2706093","1","","9999","1 nugget","61508","16.0","","",""
"293580","2706093","2","","9999","1 chicken bite","64261","16.0","","",""
"293581","2706093","3","","9999","1 cup","10205","140.0","","",""
"293582","2706093","4","","9999","Quantity not specified","90000","80.0","","",""
"302942","2708432","1","","9999","1 cup, cooked","10043","155.0","","",""
"302943","2708432","2","","9999","1 cup, dry, yields","10074","624.0","","",""
"302944","2708432","3","","9999","1 oz, dry, yields","40049","95.0","","",""
"302945","2708432","4","","9999","Quantity not specified","90000","116.0","","",""
```

`server/test/fixtures/usda/survey/measure_unit.csv`:
```csv
"id","name"
"9999","undetermined"
```

Replace `server/test/fixtures.ts` with:
```ts
import { fileURLToPath } from 'node:url';

/** Extracted-CSV fixture folders trimmed from the real FDC downloads (see test/fixtures/usda/). */
export const USDA_FIXTURES = ['foundation', 'sr_legacy', 'survey'].map((dataset) =>
  fileURLToPath(new URL(`./fixtures/usda/${dataset}/`, import.meta.url)),
);

export const WEB_FIXTURE = fileURLToPath(new URL('./fixtures/web/', import.meta.url));
```

- [ ] **Step 2: Write the failing test**

Expected counts: 12 foods (the Hummus `sub_sample_food` is skipped); portions Foundation 12 + SR Legacy 7 + FNDDS 9 = 28; skipped = SR "4 oz" + FNDDS zero-gram + FNDDS "1 oz, dry, yields" = 3.

`server/test/usda-import.test.ts`:
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initDatabase } from '../src/init';
import { importUsda } from '../src/usda/import';
import { USDA_FIXTURES } from './fixtures';

describe('importUsda', () => {
  it('imports Foundation, SR Legacy and FNDDS fixture CSVs', async () => {
    const db = initDatabase(':memory:');
    const stats = await importUsda(db, USDA_FIXTURES);
    expect(stats).toEqual({ datasets: 3, foods: 12, portions: 28, skipped_portions: 3 });

    const food = (fdcId: number) =>
      db.prepare('SELECT data_type, name, carbs_per_100g, fiber_per_100g FROM usda_food WHERE fdc_id = ?').get(fdcId);
    expect(food(324860)).toEqual({ data_type: 'foundation_food', name: 'Peanut butter, smooth style, with salt', carbs_per_100g: 22.3, fiber_per_100g: 4.8 });
    expect(food(322892)).toEqual({ data_type: 'foundation_food', name: 'Milk, whole, 3.25% milkfat, with added vitamin D', carbs_per_100g: 4.67, fiber_per_100g: null });
    expect(food(174643)).toMatchObject({ data_type: 'sr_legacy_food', carbs_per_100g: 89.72, fiber_per_100g: 2.6 });
    // FNDDS stores nutrient numbers (205/291) in food_nutrient.nutrient_id.
    expect(food(2706093)).toMatchObject({ data_type: 'survey_fndds_food', carbs_per_100g: 14.93, fiber_per_100g: 0.9 });
    expect(food(2705383)).toMatchObject({ name: 'Milk, human', carbs_per_100g: null });
    // sub_sample_food rows in the Foundation download are not foods.
    expect(food(319877)).toBeUndefined();

    expect(
      db.prepare('SELECT label, kind, quantity, grams FROM usda_portion WHERE fdc_id = ? ORDER BY id').all(322892),
    ).toEqual([
      { label: 'cup', kind: 'volume', quantity: 1, grams: 229 },
      { label: 'floz', kind: 'volume', quantity: 1, grams: 30.5 },
      { label: 'tbsp', kind: 'volume', quantity: 1, grams: 15 },
      { label: 'cup', kind: 'volume', quantity: 4, grams: 976 },
    ]);
  });

  it('is re-runnable without duplicating rows and rebuilds the USDA FTS index', async () => {
    const db = initDatabase(':memory:');
    await importUsda(db, USDA_FIXTURES);
    await importUsda(db, USDA_FIXTURES);
    expect(db.prepare('SELECT count(*) FROM usda_food').pluck().get()).toBe(12);
    expect(db.prepare('SELECT count(*) FROM usda_portion').pluck().get()).toBe(28);
    expect(db.prepare("SELECT rowid FROM usda_fts WHERE usda_fts MATCH 'kale'").pluck().all()).toEqual([323505]);
  });

  it('fails clearly when a CSV is missing', async () => {
    const db = initDatabase(':memory:');
    const empty = mkdtempSync(join(tmpdir(), 'carbbook-usda-'));
    await expect(importUsda(db, [empty])).rejects.toThrow(`${empty} is missing food.csv`);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/usda-import.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/usda/import' imported from …/server/test/usda-import.test.ts`

- [ ] **Step 4: Implement**

`server/src/usda/import.ts`:
```ts
import { parse } from 'csv-parse';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db';
import { type FdcPortionRow, normalizePortion, type UsdaPortion } from './portions';

export const USDA_DATA_TYPES = new Set(['foundation_food', 'sr_legacy_food', 'survey_fndds_food']);
/**
 * food_nutrient.nutrient_id values for carbohydrate (by difference) and total dietary fiber.
 * Foundation and SR Legacy use nutrient ids 1005/1079; the FNDDS 2024-10-31 CSV stores the legacy
 * nutrient numbers 205/291 in the same column.
 */
export const CARB_NUTRIENT_IDS = new Set(['1005', '205']);
export const FIBER_NUTRIENT_IDS = new Set(['1079', '291']);
export const REQUIRED_FILES = ['food.csv', 'food_nutrient.csv', 'food_portion.csv', 'measure_unit.csv'] as const;

export interface UsdaImportStats {
  datasets: number;
  foods: number;
  portions: number;
  skipped_portions: number;
}

interface PendingFood {
  fdc_id: number;
  data_type: string;
  name: string;
  carbs_per_100g: number | null;
  fiber_per_100g: number | null;
}

export async function* readCsv(path: string): AsyncGenerator<Record<string, string>> {
  const parser = createReadStream(path).pipe(parse({ columns: true, bom: true, skip_empty_lines: true }));
  for await (const record of parser) yield record as Record<string, string>;
}

function amount(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function readDataset(dir: string) {
  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(dir, file))) throw new Error(`${dir} is missing ${file}`);
  }
  const unitNames = new Map<string, string>();
  for await (const row of readCsv(join(dir, 'measure_unit.csv'))) unitNames.set(row.id!, row.name!);

  const foods = new Map<string, PendingFood>();
  for await (const row of readCsv(join(dir, 'food.csv'))) {
    if (!USDA_DATA_TYPES.has(row.data_type!)) continue;
    foods.set(row.fdc_id!, {
      fdc_id: Number(row.fdc_id),
      data_type: row.data_type!,
      name: row.description!.trim(),
      carbs_per_100g: null,
      fiber_per_100g: null,
    });
  }

  for await (const row of readCsv(join(dir, 'food_nutrient.csv'))) {
    const food = foods.get(row.fdc_id!);
    if (!food) continue;
    const nutrientId = row.nutrient_id!;
    if (CARB_NUTRIENT_IDS.has(nutrientId) && food.carbs_per_100g === null) food.carbs_per_100g = amount(row.amount);
    if (FIBER_NUTRIENT_IDS.has(nutrientId) && food.fiber_per_100g === null) food.fiber_per_100g = amount(row.amount);
  }

  const portions: UsdaPortion[] = [];
  let skipped = 0;
  for await (const row of readCsv(join(dir, 'food_portion.csv'))) {
    if (!foods.has(row.fdc_id!)) continue;
    const portion = normalizePortion(row as unknown as FdcPortionRow, unitNames);
    if (portion) portions.push(portion);
    else skipped++;
  }
  return { foods: [...foods.values()], portions, skipped };
}

/** Imports one or more extracted FDC CSV directories (Foundation, SR Legacy, FNDDS). Re-runnable. */
export async function importUsda(db: Db, datasetDirs: string[]): Promise<UsdaImportStats> {
  const stats: UsdaImportStats = { datasets: 0, foods: 0, portions: 0, skipped_portions: 0 };
  const upsertFood = db.prepare(
    `INSERT INTO usda_food (fdc_id, data_type, name, carbs_per_100g, fiber_per_100g)
     VALUES (@fdc_id, @data_type, @name, @carbs_per_100g, @fiber_per_100g)
     ON CONFLICT (fdc_id) DO UPDATE SET data_type = excluded.data_type, name = excluded.name,
       carbs_per_100g = excluded.carbs_per_100g, fiber_per_100g = excluded.fiber_per_100g`,
  );
  const clearPortions = db.prepare('DELETE FROM usda_portion WHERE fdc_id = ?');
  const insertPortion = db.prepare(
    `INSERT INTO usda_portion (id, fdc_id, label, kind, quantity, grams, description)
     VALUES (@id, @fdc_id, @label, @kind, @quantity, @grams, @description)`,
  );
  for (const dir of datasetDirs) {
    const dataset = await readDataset(dir);
    db.transaction(() => {
      for (const food of dataset.foods) {
        upsertFood.run(food);
        clearPortions.run(food.fdc_id);
      }
      for (const portion of dataset.portions) insertPortion.run(portion);
    })();
    stats.datasets++;
    stats.foods += dataset.foods.length;
    stats.portions += dataset.portions.length;
    stats.skipped_portions += dataset.skipped;
  }
  db.exec("INSERT INTO usda_fts (usda_fts) VALUES ('rebuild')");
  return stats;
}
```

- [ ] **Step 5: Run it and the static test (fixtures.ts changed)**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/usda-import.test.ts test/static.test.ts`
Expected: `Test Files  2 passed (2)` and `Tests  6 passed (6)`

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/usda/import.ts server/test/usda-import.test.ts server/test/fixtures.ts server/test/fixtures/usda
git commit -m "feat(server): import USDA FoodData Central CSVs"
```

---

### Task 10: USDA bundles for clients

**Files:**
- Create: `server/src/usda/bundle.ts`
- Test: `server/test/usda-bundle.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/usda-bundle.test.ts`:
```ts
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { initDatabase } from '../src/init';
import { buildUsdaBundles, readManifest, type UsdaJsonBundle } from '../src/usda/bundle';
import { importUsda } from '../src/usda/import';
import { USDA_FIXTURES } from './fixtures';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('buildUsdaBundles', () => {
  it('writes a gzip JSON bundle, a SQLite bundle and a manifest', async () => {
    const db = initDatabase(':memory:');
    await importUsda(db, USDA_FIXTURES);
    const dir = mkdtempSync(join(tmpdir(), 'carbbook-bundle-'));
    const manifest = buildUsdaBundles(db, dir, 42);

    expect(manifest).toMatchObject({ created_at: 42, food_count: 12, portion_count: 28 });
    expect(manifest.version).toMatch(/^fdc-[0-9a-f]{12}$/);
    expect(readManifest(dir)).toEqual(manifest);

    const gz = readFileSync(join(dir, manifest.json_file));
    expect(sha256(gz)).toBe(manifest.json_sha256);
    const json = JSON.parse(gunzipSync(gz).toString('utf8')) as UsdaJsonBundle;
    expect(json.format).toBe(1);
    expect(json.foods).toContainEqual([324860, 'Peanut butter, smooth style, with salt', 22.3, 4.8]);
    expect(json.portions).toContainEqual([119207, 324860, 'tbsp', 'volume', 2, 32, 'tablespoon']);

    const sqlitePath = join(dir, manifest.sqlite_file);
    expect(sha256(readFileSync(sqlitePath))).toBe(manifest.sqlite_sha256);
    const bundle = new Database(sqlitePath, { readonly: true });
    expect(bundle.prepare("SELECT rowid FROM usda_fts WHERE usda_fts MATCH 'peanut'").pluck().all()).toEqual([324860]);
    expect(bundle.prepare("SELECT value FROM bundle_meta WHERE key = 'version'").pluck().get()).toBe(manifest.version);
    bundle.close();
  });

  it('keeps the version stable for identical data and removes superseded files', async () => {
    const db = initDatabase(':memory:');
    await importUsda(db, USDA_FIXTURES.slice(0, 1));
    const dir = mkdtempSync(join(tmpdir(), 'carbbook-bundle-'));
    const first = buildUsdaBundles(db, dir, 1);
    expect(buildUsdaBundles(db, dir, 2).version).toBe(first.version);

    await importUsda(db, USDA_FIXTURES);
    const second = buildUsdaBundles(db, dir, 3);
    expect(second.version).not.toBe(first.version);
    expect(existsSync(join(dir, first.json_file))).toBe(false);
    expect(existsSync(join(dir, first.sqlite_file))).toBe(false);
    expect(existsSync(join(dir, second.json_file))).toBe(true);
  });

  it('readManifest returns null when nothing was imported', () => {
    expect(readManifest(mkdtempSync(join(tmpdir(), 'carbbook-bundle-')))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/usda-bundle.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/usda/bundle' imported from …/server/test/usda-bundle.test.ts`

- [ ] **Step 3: Implement**

`server/src/usda/bundle.ts`:
```ts
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Db } from '../db';

export interface UsdaManifest {
  version: string;
  created_at: number;
  food_count: number;
  portion_count: number;
  json_file: string;
  json_sha256: string;
  sqlite_file: string;
  sqlite_sha256: string;
}

/**
 * Web bundle (gzip JSON), format 1:
 *   foods:    [fdc_id, name, carbs_per_100g | null, fiber_per_100g | null]
 *   portions: [id, fdc_id, label, kind, quantity, grams, description]
 */
export interface UsdaJsonBundle {
  format: 1;
  foods: [number, string, number | null, number | null][];
  portions: [number, number, string, string, number, number, string][];
}

export const MANIFEST_FILE = 'manifest.json';

/** Schema of the iOS SQLite bundle (same shape as the server tables). */
export const BUNDLE_SCHEMA = `
CREATE TABLE usda_food (fdc_id INTEGER PRIMARY KEY, name TEXT NOT NULL, carbs_per_100g REAL, fiber_per_100g REAL);
CREATE TABLE usda_portion (id INTEGER PRIMARY KEY, fdc_id INTEGER NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL,
  quantity REAL NOT NULL, grams REAL NOT NULL, description TEXT NOT NULL);
CREATE INDEX usda_portion_fdc ON usda_portion (fdc_id);
CREATE VIRTUAL TABLE usda_fts USING fts5 (name, content = 'usda_food', content_rowid = 'fdc_id',
  tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE bundle_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

function writeSqliteBundle(path: string, bundle: UsdaJsonBundle, version: string): void {
  rmSync(path, { force: true });
  const out = new Database(path);
  try {
    out.exec(BUNDLE_SCHEMA);
    const food = out.prepare('INSERT INTO usda_food VALUES (?, ?, ?, ?)');
    const portion = out.prepare('INSERT INTO usda_portion VALUES (?, ?, ?, ?, ?, ?, ?)');
    out.transaction(() => {
      for (const f of bundle.foods) food.run(...f);
      for (const p of bundle.portions) portion.run(...p);
      out.prepare("INSERT INTO bundle_meta VALUES ('version', ?)").run(version);
    })();
    out.exec("INSERT INTO usda_fts (usda_fts) VALUES ('rebuild')");
  } finally {
    out.close();
  }
}

/** Writes usda-<version>.json.gz, usda-<version>.sqlite and manifest.json; removes older bundles. */
export function buildUsdaBundles(db: Db, outDir: string, now: number): UsdaManifest {
  const foods = db
    .prepare('SELECT fdc_id, name, carbs_per_100g, fiber_per_100g FROM usda_food ORDER BY fdc_id')
    .raw()
    .all() as UsdaJsonBundle['foods'];
  const portions = db
    .prepare('SELECT id, fdc_id, label, kind, quantity, grams, description FROM usda_portion ORDER BY fdc_id, id')
    .raw()
    .all() as UsdaJsonBundle['portions'];
  const bundle: UsdaJsonBundle = { format: 1, foods, portions };
  const json = JSON.stringify(bundle);
  const version = `fdc-${sha256(json).slice(0, 12)}`;

  mkdirSync(outDir, { recursive: true });
  const jsonFile = `usda-${version}.json.gz`;
  const sqliteFile = `usda-${version}.sqlite`;
  const gz = gzipSync(json, { level: 9 });
  writeFileSync(join(outDir, jsonFile), gz);
  writeSqliteBundle(join(outDir, sqliteFile), bundle, version);

  const manifest: UsdaManifest = {
    version,
    created_at: now,
    food_count: foods.length,
    portion_count: portions.length,
    json_file: jsonFile,
    json_sha256: sha256(gz),
    sqlite_file: sqliteFile,
    sqlite_sha256: sha256(readFileSync(join(outDir, sqliteFile))),
  };
  const tmp = join(outDir, `${MANIFEST_FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  renameSync(tmp, join(outDir, MANIFEST_FILE));

  for (const file of readdirSync(outDir)) {
    if (/^usda-fdc-[0-9a-f]{12}\.(json\.gz|sqlite)$/.test(file) && file !== jsonFile && file !== sqliteFile) {
      rmSync(join(outDir, file));
    }
  }
  return manifest;
}

export function readManifest(dir: string): UsdaManifest | null {
  const path = join(dir, MANIFEST_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as UsdaManifest) : null;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/usda-bundle.test.ts`
Expected: `Tests  3 passed (3)`

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/usda/bundle.ts server/test/usda-bundle.test.ts
git commit -m "feat(server): versioned USDA bundles (gzip JSON + SQLite)"
```

---

### Task 11: USDA endpoints and `carbbook import-usda`

**Files:**
- Create: `server/src/routes/usda.ts`
- Modify: `server/src/app.ts` (import + register), `server/src/cli.ts` (three edits)
- Test: `server/test/usda-routes.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/usda-routes.test.ts`:
```ts
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli';
import { USDA_FIXTURES } from './fixtures';
import { addUser, loginCookie, makeTestApp } from './helpers';

describe('carbbook import-usda + /api/usda', () => {
  it('404s before import, then serves the manifest and both bundle files', async () => {
    const usdaDir = mkdtempSync(join(tmpdir(), 'carbbook-usda-routes-'));
    const { app, db } = await makeTestApp({ env: { USDA_DIR: usdaDir } });
    await addUser(db, 'brett', 'owner');
    const cookie = await loginCookie(app, 'brett');

    const before = await app.inject({ url: '/api/usda/manifest', headers: { cookie } });
    expect(before.statusCode).toBe(404);
    expect(before.json().error).toBe('usda_not_imported');

    const out: string[] = [];
    const code = await runCli(['import-usda', ...USDA_FIXTURES], {
      env: { USDA_DIR: usdaDir },
      stdout: (line) => out.push(line),
      stderr: (line) => out.push(line),
      readPassword: async () => '',
      db,
      now: () => 7,
    });
    expect(code).toBe(0);
    expect(out[0]).toBe('Imported 12 foods and 28 portions (3 skipped) from 3 datasets');
    expect(out[1]).toMatch(/^USDA bundle fdc-[0-9a-f]{12} written to /);

    const manifest = (await app.inject({ url: '/api/usda/manifest', headers: { cookie } })).json();
    expect(manifest).toMatchObject({ food_count: 12, portion_count: 28, created_at: 7 });
    expect(manifest.json_url).toBe(`/api/usda/files/${manifest.json_file}`);

    const json = await app.inject({ url: manifest.json_url, headers: { cookie } });
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-type']).toBe('application/gzip');
    expect(json.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(createHash('sha256').update(json.rawPayload).digest('hex')).toBe(manifest.json_sha256);

    const sqlite = await app.inject({ url: manifest.sqlite_url, headers: { cookie } });
    expect(sqlite.headers['content-type']).toBe('application/vnd.sqlite3');
    expect(createHash('sha256').update(sqlite.rawPayload).digest('hex')).toBe(manifest.sqlite_sha256);

    for (const name of ['manifest.json', '..%2Fcarbbook.db', 'usda-fdc-000000000000.sqlite']) {
      expect((await app.inject({ url: `/api/usda/files/${name}`, headers: { cookie } })).statusCode).toBe(404);
    }
  });

  it('prints usage when no directory is given', async () => {
    const err: string[] = [];
    const code = await runCli(['import-usda'], {
      env: {},
      stdout: () => {},
      stderr: (line) => err.push(line),
      readPassword: async () => '',
    });
    expect(code).toBe(2);
    expect(err[0]).toMatch(/import-usda <csv-dir>/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/usda-routes.test.ts`
Expected: FAIL — `expected 'not_found' to be 'usda_not_imported'` and `expected 'Usage:\n  carbbook user add …' to match /import-usda <csv-dir>/`.

- [ ] **Step 3: Implement the routes**

`server/src/routes/usda.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../context';
import { ApiError } from '../errors';
import { readManifest } from '../usda/bundle';

export const USDA_FILES_PREFIX = '/api/usda/files/';

export async function usdaRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  function manifestOr404() {
    const manifest = readManifest(ctx.config.usdaDir);
    if (!manifest) throw new ApiError(404, 'usda_not_imported', 'Run `carbbook import-usda` on the server first');
    return manifest;
  }

  app.get('/api/usda/manifest', async () => {
    const manifest = manifestOr404();
    return {
      ...manifest,
      json_url: USDA_FILES_PREFIX + manifest.json_file,
      sqlite_url: USDA_FILES_PREFIX + manifest.sqlite_file,
    };
  });

  app.get<{ Params: { name: string } }>('/api/usda/files/:name', async (request, reply) => {
    const manifest = manifestOr404();
    const { name } = request.params;
    if (name !== manifest.json_file && name !== manifest.sqlite_file) {
      throw new ApiError(404, 'not_found', `No USDA bundle named ${name}`);
    }
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    reply.type(name.endsWith('.sqlite') ? 'application/vnd.sqlite3' : 'application/gzip');
    return reply.send(createReadStream(join(ctx.config.usdaDir, name)));
  });
}
```

In `server/src/app.ts` add the import:
```ts
import { usdaRoutes } from './routes/usda';
```
and inside the authenticated scope, after `await api.register(syncRoutes, ctx);`, add:
```ts
    await api.register(usdaRoutes, ctx);
```

- [ ] **Step 4: Add the CLI command**

In `server/src/cli.ts`, add after `import { initDatabase } from './init';`:
```ts
import { buildUsdaBundles } from './usda/bundle';
import { importUsda } from './usda/import';
```

Replace the `USAGE` constant with:
```ts
const USAGE = `Usage:
  carbbook user add <username> [--role owner|viewer]   (password from CARBBOOK_PASSWORD or prompt)
  carbbook import-usda <csv-dir> [<csv-dir>...]        (extracted FoodData Central CSV folders)`;
```

In `runCli`, insert this block immediately before the final `io.stderr(USAGE);` / `return 2;`:
```ts
  if (group === 'import-usda') {
    const dirs = [command, ...rest].filter((d): d is string => Boolean(d));
    if (dirs.length === 0) {
      io.stderr(USAGE);
      return 2;
    }
    const config = loadConfig(io.env);
    const db = io.db ?? initDatabase(config.databasePath);
    try {
      const stats = await importUsda(db, dirs);
      const manifest = buildUsdaBundles(db, config.usdaDir, (io.now ?? Date.now)());
      io.stdout(
        `Imported ${stats.foods} foods and ${stats.portions} portions (${stats.skipped_portions} skipped) from ${stats.datasets} datasets`,
      );
      io.stdout(`USDA bundle ${manifest.version} written to ${config.usdaDir}`);
      return 0;
    } finally {
      if (!io.db) db.close();
    }
  }
```

- [ ] **Step 5: Run the USDA route and CLI tests**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/usda-routes.test.ts test/cli.test.ts`
Expected: `Test Files  2 passed (2)` and `Tests  5 passed (5)`

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/routes/usda.ts server/src/app.ts server/src/cli.ts server/test/usda-routes.test.ts
git commit -m "feat(server): USDA bundle endpoints and import-usda command"
```

---

### Task 12: FTS5 search

**Files:**
- Create: `server/src/search/search.ts`, `server/src/routes/search.ts`
- Modify: `server/src/app.ts` (import + register)
- Test: `server/test/search.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/search.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { initDatabase } from '../src/init';
import { search, toFtsQuery } from '../src/search/search';
import { applyPush } from '../src/sync/push';
import { importUsda } from '../src/usda/import';
import { USDA_FIXTURES } from './fixtures';
import { addUser, loginCookie, makeTestApp } from './helpers';
import { food, meal } from './sync-helpers';

const logEntry = (id: string, eatenAt: number) => ({
  id, eaten_at: eatenAt, window_name: 'Lunch', bg_mgdl: null, bg_source: 'none', bg_trend: null, total_carbs_g: 20,
  suggested_units: null, taken_units: null, settings_version_id: null, notes: null, updated_at: 1, updated_by: 'phone', deleted: 0,
});
const logItem = (id: string, entryId: string, refId: string) => ({
  id, log_entry_id: entryId, ref_type: 'food', ref_id: refId, display_name: 'x', amount: 1, unit: 'g', carbs_g: 1,
  updated_at: 1, updated_by: 'phone', deleted: 0,
});

async function seededDb() {
  const db = initDatabase(':memory:');
  await importUsda(db, USDA_FIXTURES);
  applyPush(db, 'owner', [
    { table: 'food', record: food({ id: 'off-old', name: 'Peanut butter crunchy', source: 'off', brand: 'Jif' }) },
    { table: 'food', record: food({ id: 'off-recent', name: 'Peanut butter cups', source: 'off', brand: "Reese's" }) },
    { table: 'food', record: food({ id: 'custom-pb', name: 'Peanut butter cookies', source: 'custom' }) },
    { table: 'meal', record: meal({ id: 'meal-pb', name: 'PB toast with peanut butter' }) },
    { table: 'food', record: food({ id: 'gone', name: 'Peanut brittle', source: 'custom', deleted: 1 }) },
    { table: 'food', record: food({ id: 'creme', name: 'Crème fraîche', source: 'custom' }) },
    { table: 'log_entry', record: logEntry('e1', 5000) },
    { table: 'log_item', record: logItem('i1', 'e1', 'off-recent') },
  ]);
  return db;
}

describe('toFtsQuery', () => {
  it('builds prefix queries and ignores punctuation', () => {
    expect(toFtsQuery('Peanut  but')).toBe('"peanut"* "but"*');
    expect(toFtsQuery(`"); DROP TABLE food; --`)).toBe('"drop"* "table"* "food"*');
    expect(toFtsQuery('  !! ')).toBeNull();
  });
});

describe('search', () => {
  it('ranks meals + custom foods, then recently logged saved foods, then other saved foods, then USDA', async () => {
    const db = await seededDb();
    const hits = search(db, 'peanut butter', 20);
    expect(hits).toHaveLength(5);
    expect(new Set(hits.slice(0, 2).map((h) => h.id))).toEqual(new Set(['meal-pb', 'custom-pb']));
    expect(hits.slice(2).map((h) => h.id)).toEqual(['off-recent', 'off-old', 'usda:324860']);
    expect(hits[4]).toEqual({ kind: 'usda', id: 'usda:324860', name: 'Peanut butter, smooth style, with salt', brand: null, source: 'usda', carbs_per_100g: 22.3 });
    expect(hits.find((h) => h.id === 'off-old')).toMatchObject({ kind: 'food', brand: 'Jif', source: 'off' });
  });

  it('excludes deleted records, matches prefixes and ignores diacritics', async () => {
    const db = await seededDb();
    expect(search(db, 'brittle', 10)).toEqual([]);
    expect(search(db, 'creme fra', 10).map((h) => h.id)).toEqual(['creme']);
    expect(search(db, 'nugg', 10).map((h) => h.id)).toEqual(['usda:2706093']);
  });

  it('reflects renames and deletes pushed later', async () => {
    const db = await seededDb();
    applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'custom-pb', name: 'Oatmeal cookies', source: 'custom', updated_at: 2000 }) }]);
    expect(search(db, 'oatmeal', 10).map((h) => h.id)).toEqual(['custom-pb']);
    expect(search(db, 'peanut', 10).map((h) => h.id)).not.toContain('custom-pb');
  });

  it('honours the limit across tiers', async () => {
    const db = await seededDb();
    expect(search(db, 'peanut', 3)).toHaveLength(3);
  });
});

describe('GET /api/search', () => {
  it('returns results for an authenticated user and validates q', async () => {
    const { app, db } = await makeTestApp();
    await importUsda(db, USDA_FIXTURES);
    await addUser(db, 'kim', 'viewer');
    const cookie = await loginCookie(app, 'kim');
    const response = await app.inject({ url: '/api/search?q=kale', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().results.map((h: { id: string }) => h.id)).toEqual(['usda:323505']);
    expect((await app.inject({ url: '/api/search', headers: { cookie } })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/search.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/search/search' imported from …/server/test/search.test.ts`

- [ ] **Step 3: Implement search**

`server/src/search/search.ts`:
```ts
import type { Db } from '../db';

export interface SearchHit {
  kind: 'meal' | 'food' | 'usda';
  /** food/meal UUID, or "usda:<fdc_id>". */
  id: string;
  name: string;
  brand: string | null;
  source: 'usda' | 'off' | 'custom' | null;
  carbs_per_100g: number | null;
}

/** Turns user input into an FTS5 prefix query: `pea but` → `"pea"* "but"*`. */
export function toFtsQuery(input: string): string | null {
  const tokens = input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return null;
  return tokens
    .slice(0, 8)
    .map((token) => `"${token}"*`)
    .join(' ');
}

/**
 * Ranking (spec §6): meals and custom foods, then other saved foods (most recently logged first),
 * then the USDA library. bm25 breaks ties inside a tier.
 */
export function search(db: Db, input: string, limit: number): SearchHit[] {
  const query = toFtsQuery(input);
  if (!query) return [];
  const userHits = db
    .prepare(
      `SELECT catalog_fts.kind AS kind, catalog_fts.ref_id AS id, catalog_fts.name AS name,
              nullif(catalog_fts.brand, '') AS brand, food.source AS source, food.carbs_per_100g AS carbs_per_100g,
              CASE WHEN catalog_fts.kind = 'meal' OR food.source = 'custom' THEN 0 ELSE 1 END AS tier,
              (SELECT max(log_entry.eaten_at) FROM log_item
                 JOIN log_entry ON log_entry.id = log_item.log_entry_id
                WHERE log_item.ref_id = catalog_fts.ref_id AND log_item.deleted = 0 AND log_entry.deleted = 0
              ) AS last_logged
         FROM catalog_fts
         LEFT JOIN food ON catalog_fts.kind = 'food' AND food.id = catalog_fts.ref_id
        WHERE catalog_fts MATCH ?
        ORDER BY tier, last_logged DESC NULLS LAST, bm25(catalog_fts)
        LIMIT ?`,
    )
    .all(query, limit) as (SearchHit & { tier: number; last_logged: number | null })[];

  const hits: SearchHit[] = userHits.map(({ tier: _tier, last_logged: _last, ...hit }) => hit);
  const remaining = limit - hits.length;
  if (remaining > 0) {
    const usdaHits = db
      .prepare(
        `SELECT 'usda' AS kind, 'usda:' || usda_food.fdc_id AS id, usda_food.name AS name, NULL AS brand,
                'usda' AS source, usda_food.carbs_per_100g AS carbs_per_100g
           FROM usda_fts JOIN usda_food ON usda_food.fdc_id = usda_fts.rowid
          WHERE usda_fts MATCH ?
          ORDER BY bm25(usda_fts)
          LIMIT ?`,
      )
      .all(query, remaining) as SearchHit[];
    hits.push(...usdaHits);
  }
  return hits;
}
```

`server/src/routes/search.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { search } from '../search/search';

export async function searchRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Querystring: { q: string; limit: number } }>(
    '/api/search',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['q'],
          properties: {
            q: { type: 'string', maxLength: 200 },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
        },
      },
    },
    async (request) => ({ results: search(ctx.db, request.query.q, request.query.limit) }),
  );
}
```

In `server/src/app.ts` add the import:
```ts
import { searchRoutes } from './routes/search';
```
and inside the authenticated scope, after `await api.register(usdaRoutes, ctx);`, add:
```ts
    await api.register(searchRoutes, ctx);
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/search.test.ts`
Expected: `Tests  6 passed (6)`

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/search/search.ts server/src/routes/search.ts server/src/app.ts server/test/search.test.ts
git commit -m "feat(server): FTS5 search across meals, foods and USDA"
```

---

### Task 13: Open Food Facts client and draft normalization

**Files:**
- Create: `server/src/off/client.ts`, `server/src/off/normalize.ts`
- Test: `server/test/off.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/off.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createOffClient, OFF_FIELDS, OffUnavailableError } from '../src/off/client';
import { barcodeCandidates, normalizeOffProduct } from '../src/off/normalize';

/** Trimmed from a live response for 0737628064502 (2026-09-14). */
const THAI_KITCHEN = {
  code: '0737628064502',
  status: 1,
  status_verbose: 'product found',
  product: {
    brands: 'Simply Asia, Thai Kitchen',
    code: '0737628064502',
    product_name: 'Thai peanut noodle kit includes stir-fry rice noodles & thai peanut seasoning',
    serving_quantity: 52,
    serving_quantity_unit: 'g',
    serving_size: '0.333 PACKAGE (52 g)',
    nutriments: { carbohydrates_100g: 71.15, carbohydrates_serving: 37, fiber_100g: 1.9, fiber_serving: 0.988 },
  },
};

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const options = (fetch: typeof globalThis.fetch) => ({
  baseUrl: 'https://world.openfoodfacts.org',
  userAgent: 'CarbBook/0.1 (owner@example.com)',
  timeoutMs: 5000,
  fetch,
});

describe('createOffClient', () => {
  it('calls API v2 with the field list and a custom User-Agent', async () => {
    const { fetch, calls } = stubFetch(() => Response.json(THAI_KITCHEN));
    const product = await createOffClient(options(fetch)).lookup('737628064502');
    expect(product?.code).toBe('0737628064502');
    expect(calls[0]!.url).toBe(`https://world.openfoodfacts.org/api/v2/product/737628064502?fields=${OFF_FIELDS}`);
    expect(new Headers(calls[0]!.init?.headers).get('user-agent')).toBe('CarbBook/0.1 (owner@example.com)');
  });

  it('returns null for HTTP 404 and for status 0', async () => {
    const notFound = stubFetch(() => Response.json({ code: '3017624010070', status: 0, status_verbose: 'product not found' }, { status: 404 }));
    expect(await createOffClient(options(notFound.fetch)).lookup('3017624010070')).toBeNull();
    const invalid = stubFetch(() => Response.json({ code: '00000000', status: 0, status_verbose: 'no code or invalid code' }));
    expect(await createOffClient(options(invalid.fetch)).lookup('00000000')).toBeNull();
  });

  it('throws OffUnavailableError on network errors, timeouts and 5xx', async () => {
    const failures = [
      stubFetch(() => {
        throw new TypeError('fetch failed');
      }),
      stubFetch(() => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }),
      stubFetch(() => new Response('busy', { status: 503 })),
    ];
    for (const { fetch } of failures) {
      await expect(createOffClient(options(fetch)).lookup('123456')).rejects.toBeInstanceOf(OffUnavailableError);
    }
  });
});

describe('normalizeOffProduct', () => {
  it('builds a food draft with a label-serving portion', () => {
    expect(normalizeOffProduct({ ...THAI_KITCHEN.product }, '737628064502')).toEqual({
      food: {
        name: 'Thai peanut noodle kit includes stir-fry rice noodles & thai peanut seasoning',
        brand: 'Simply Asia',
        source: 'off',
        source_ref: '0737628064502',
        carbs_per_100g: 71.15,
        fiber_per_100g: 1.9,
      },
      portions: [{ label: 'label serving', kind: 'serving', quantity: 1, grams: 52 }],
      barcode: '0737628064502',
      serving_size: '0.333 PACKAGE (52 g)',
    });
  });

  it('handles missing names, missing nutrients, string quantities and non-gram servings', () => {
    const draft = normalizeOffProduct({ code: '3017620422003', serving_quantity: '15', nutriments: {} }, '3017620422003');
    expect(draft.food).toMatchObject({ name: 'Barcode 3017620422003', brand: null, carbs_per_100g: null, fiber_per_100g: null });
    expect(draft.portions).toEqual([{ label: 'label serving', kind: 'serving', quantity: 1, grams: 15 }]);
    expect(normalizeOffProduct({ code: '1', serving_quantity: 330, serving_quantity_unit: 'ml' }, '1').portions).toEqual([]);
  });
});

describe('barcodeCandidates', () => {
  it('covers UPC-A and EAN-13 spellings', () => {
    expect(barcodeCandidates('737628064502')).toEqual(['737628064502', '0737628064502']);
    expect(barcodeCandidates('0737628064502')).toEqual(['0737628064502', '737628064502']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/off.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/off/client' imported from …/server/test/off.test.ts`

- [ ] **Step 3: Implement the client**

`server/src/off/client.ts`:
```ts
/** Fields requested from Open Food Facts API v2 (verified against world.openfoodfacts.org 2026-09-14). */
export const OFF_FIELDS = 'code,product_name,brands,serving_size,serving_quantity,serving_quantity_unit,nutriments';

export interface OffProduct {
  code: string;
  product_name?: string;
  brands?: string;
  serving_size?: string;
  serving_quantity?: number | string;
  serving_quantity_unit?: string;
  nutriments?: Record<string, unknown>;
}

export interface OffClient {
  /** Resolves null when OFF does not know the code; rejects with OffUnavailableError on failure. */
  lookup(code: string): Promise<OffProduct | null>;
}

export class OffUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OffUnavailableError';
  }
}

export interface OffClientOptions {
  baseUrl: string;
  /** OFF asks for "AppName/Version (ContactEmail)". */
  userAgent: string;
  timeoutMs: number;
  fetch: typeof globalThis.fetch;
}

export function createOffClient(options: OffClientOptions): OffClient {
  return {
    async lookup(code) {
      const url = `${options.baseUrl}/api/v2/product/${encodeURIComponent(code)}?fields=${OFF_FIELDS}`;
      let response: Response;
      try {
        response = await options.fetch(url, {
          headers: { 'user-agent': options.userAgent, accept: 'application/json' },
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error) {
        throw new OffUnavailableError(`Open Food Facts unreachable: ${(error as Error).message}`);
      }
      // Unknown products come back as HTTP 404 with {"status":0,"status_verbose":"product not found"}.
      if (response.status === 404) return null;
      if (!response.ok) throw new OffUnavailableError(`Open Food Facts responded ${response.status}`);
      const body = (await response.json()) as { code?: string; status?: number; product?: Omit<OffProduct, 'code'> };
      if (body.status !== 1 || !body.product) return null;
      return { ...body.product, code: body.code ?? code };
    },
  };
}
```

- [ ] **Step 4: Implement normalization**

`server/src/off/normalize.ts`:
```ts
import type { OffProduct } from './client';

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
  /** OFF's free-text serving size, shown so the user can sanity-check the portion. */
  serving_size: string | null;
}

function nonNegative(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/** Draft the user confirms before it is saved as a food with source "off" (spec §6). */
export function normalizeOffProduct(product: OffProduct, scannedCode: string): FoodDraft {
  const code = product.code || scannedCode;
  const brand = product.brands?.split(',')[0]?.trim() || null;
  const grams = nonNegative(product.serving_quantity);
  const unit = (product.serving_quantity_unit ?? 'g').trim().toLowerCase();
  return {
    food: {
      name: product.product_name?.trim() || `Barcode ${code}`,
      brand,
      source: 'off',
      source_ref: code,
      carbs_per_100g: nonNegative(product.nutriments?.carbohydrates_100g),
      fiber_per_100g: nonNegative(product.nutriments?.fiber_100g),
    },
    portions: grams !== null && grams > 0 && unit === 'g' ? [{ label: 'label serving', kind: 'serving', quantity: 1, grams }] : [],
    barcode: code,
    serving_size: product.serving_size?.trim() || null,
  };
}

/** UPC-A/EAN-13 variants so "737628064502" finds a stored "0737628064502" and vice versa. */
export function barcodeCandidates(code: string): string[] {
  const stripped = code.replace(/^0+/, '') || '0';
  return [...new Set([code, stripped, stripped.padStart(12, '0'), stripped.padStart(13, '0')])];
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/off.test.ts`
Expected: `Tests  6 passed (6)`

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/off/client.ts server/src/off/normalize.ts server/test/off.test.ts
git commit -m "feat(server): Open Food Facts v2 client and food draft normalization"
```

---

### Task 14: `GET /api/barcode/:code`

**Files:**
- Create: `server/src/routes/barcode.ts`
- Modify: `server/src/context.ts` (full replacement), `server/src/app.ts` (full replacement), `server/test/helpers.ts` (three edits)
- Test: `server/test/barcode.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/barcode.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { OffUnavailableError, type OffClient } from '../src/off/client';
import { applyPush } from '../src/sync/push';
import { addUser, loginCookie, makeTestApp } from './helpers';
import { food } from './sync-helpers';

async function appWithOff(off: OffClient) {
  const t = await makeTestApp({ deps: { off } });
  await addUser(t.db, 'brett', 'owner');
  const cookie = await loginCookie(t.app, 'brett');
  const get = (code: string) => t.app.inject({ url: `/api/barcode/${code}`, headers: { cookie } });
  return { ...t, get };
}

const neverCalled: OffClient = { lookup: () => Promise.reject(new Error('OFF must not be called for known barcodes')) };

describe('GET /api/barcode/:code', () => {
  it('resolves a locally saved barcode (either UPC-A or EAN-13 spelling) without calling OFF', async () => {
    const { db, get } = await appWithOff(neverCalled);
    applyPush(db, 'owner', [
      { table: 'food', record: food({ id: 'f1', name: 'Thai peanut noodle kit', source: 'off', source_ref: '0737628064502' }) },
      { table: 'portion', record: { id: 'p1', food_id: 'f1', label: 'label serving', kind: 'serving', quantity: 1, grams: 52, updated_at: 1, updated_by: 'phone', deleted: 0 } },
      { table: 'barcode', record: { id: 'b1', code: '0737628064502', food_id: 'f1', updated_at: 1, updated_by: 'phone', deleted: 0 } },
    ]);
    const response = await get('737628064502');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'known',
      food: { id: 'f1', name: 'Thai peanut noodle kit' },
      portions: [{ id: 'p1', grams: 52 }],
    });
  });

  it('ignores deleted barcodes and returns an OFF draft', async () => {
    const off: OffClient = {
      lookup: async (code) => ({ code: `0${code}`, product_name: 'Noodle kit', brands: 'Thai Kitchen', serving_quantity: 52, nutriments: { carbohydrates_100g: 71.15 } }),
    };
    const { db, get } = await appWithOff(off);
    applyPush(db, 'owner', [
      { table: 'food', record: food({ id: 'f1' }) },
      { table: 'barcode', record: { id: 'b1', code: '737628064502', food_id: 'f1', updated_at: 1, updated_by: 'phone', deleted: 1 } },
    ]);
    const response = await get('737628064502');
    expect(response.json()).toEqual({
      status: 'draft',
      draft: {
        food: { name: 'Noodle kit', brand: 'Thai Kitchen', source: 'off', source_ref: '0737628064502', carbs_per_100g: 71.15, fiber_per_100g: null },
        portions: [{ label: 'label serving', kind: 'serving', quantity: 1, grams: 52 }],
        barcode: '0737628064502',
        serving_size: null,
      },
    });
  });

  it('reports not_found and unavailable so the client can prefill manual entry', async () => {
    const missing = await appWithOff({ lookup: async () => null });
    expect((await missing.get('3017624010070')).json()).toEqual({ status: 'not_found', code: '3017624010070' });

    const down = await appWithOff({ lookup: () => Promise.reject(new OffUnavailableError('Open Food Facts responded 503')) });
    const response = await down.get('3017624010070');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'unavailable', code: '3017624010070', message: 'Open Food Facts responded 503' });
  });

  it('rejects malformed codes', async () => {
    const { get } = await appWithOff(neverCalled);
    expect((await get('abc')).statusCode).toBe(400);
    expect((await get('12345')).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/barcode.test.ts`
Expected: FAIL — 4 failed: `expected 404 to be 200`, `expected { error: 'not_found', … } to deeply equal { status: 'draft', … }`, `expected 404 to be 400`.

- [ ] **Step 3: Implement the route**

`server/src/routes/barcode.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { OffUnavailableError } from '../off/client';
import { barcodeCandidates, normalizeOffProduct } from '../off/normalize';
import { TABLE_SPECS } from '../sync/tables';
import { decodeRow } from '../sync/validate';

export async function barcodeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Params: { code: string } }>(
    '/api/barcode/:code',
    {
      schema: {
        params: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', pattern: '^[0-9]{6,14}$' } },
        },
      },
    },
    async (request) => {
      const { code } = request.params;
      const candidates = barcodeCandidates(code);
      const food = ctx.db
        .prepare(
          `SELECT food.* FROM barcode JOIN food ON food.id = barcode.food_id
            WHERE barcode.deleted = 0 AND food.deleted = 0
              AND barcode.code IN (${candidates.map(() => '?').join(', ')})
            ORDER BY barcode.updated_at DESC LIMIT 1`,
        )
        .get(...candidates) as Record<string, unknown> | undefined;
      if (food) {
        const portions = ctx.db
          .prepare('SELECT * FROM portion WHERE food_id = ? AND deleted = 0 ORDER BY grams')
          .all(food.id) as Record<string, unknown>[];
        return {
          status: 'known' as const,
          food: decodeRow(TABLE_SPECS.food, food),
          portions: portions.map((p) => decodeRow(TABLE_SPECS.portion, p)),
        };
      }
      try {
        const product = await ctx.deps.off.lookup(code);
        if (!product) return { status: 'not_found' as const, code };
        return { status: 'draft' as const, draft: normalizeOffProduct(product, code) };
      } catch (error) {
        if (error instanceof OffUnavailableError) {
          request.log.warn({ err: error, code }, 'Open Food Facts lookup failed');
          return { status: 'unavailable' as const, code, message: error.message };
        }
        throw error;
      }
    },
  );
}
```

- [ ] **Step 4: Inject the OFF client and register the route**

Replace `server/src/context.ts` with:
```ts
import type { BgClient } from './bg/client';
import type { Config } from './config';
import type { Db } from './db';
import type { OffClient } from './off/client';

/** External HTTP services and the clock, injected so tests never touch the network. */
export interface AppDeps {
  now: () => number;
  bg: BgClient;
  off: OffClient;
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
import { createOffClient } from './off/client';
import { loginRoutes, sessionRoutes } from './routes/auth';
import { barcodeRoutes } from './routes/barcode';
import { bgRoutes } from './routes/bg';
import { searchRoutes } from './routes/search';
import { syncRoutes } from './routes/sync';
import { usdaRoutes } from './routes/usda';
import { registerWebApp } from './static';

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
    off: createOffClient({
      baseUrl: config.offBaseUrl,
      userAgent: config.offUserAgent,
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
    await api.register(syncRoutes, ctx);
    await api.register(usdaRoutes, ctx);
    await api.register(searchRoutes, ctx);
    await api.register(barcodeRoutes, ctx);
  });

  await registerWebApp(app, options.config.webDir);
  return app;
}
```

In `server/test/helpers.ts`, add the import:
```ts
import type { OffClient } from '../src/off/client';
```
add after `unusedBg`:
```ts
export const unusedOff: OffClient = {
  lookup: () => Promise.reject(new Error('off client not stubbed in this test')),
};
```
and change the `buildApp` call in `makeTestApp` to:
```ts
  const app = await buildApp({ db, config, deps: { now: clock.now, bg: unusedBg, off: unusedOff, ...options.deps } });
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd ~/Projects/CarbBook/server && pnpm exec vitest run test/barcode.test.ts`
Expected: `Tests  4 passed (4)`

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add server/src/routes/barcode.ts server/src/context.ts server/src/app.ts server/test/helpers.ts server/test/barcode.test.ts
git commit -m "feat(server): barcode lookup via local library then Open Food Facts"
```

---

### Task 15: Full verification and real-data import

**Files:** none (verification only)

- [ ] **Step 1: Full server suite and typecheck**

Run: `cd ~/Projects/CarbBook/server && pnpm test && pnpm typecheck`
Expected: `Test Files  28 passed (28)`, `Tests  142 passed (142)`, then `tsc` exits 0.

- [ ] **Step 2: Workspace-wide**

Run: `cd ~/Projects/CarbBook && pnpm test && pnpm typecheck`
Expected: core and server both pass; no type errors.

- [ ] **Step 3: Import the real FoodData Central downloads (network, ~13 MB)**

Run:
```bash
F=$(mktemp -d) && cd $F \
&& for z in FoodData_Central_foundation_food_csv_2026-04-30 FoodData_Central_sr_legacy_food_csv_2018-04 FoodData_Central_survey_food_csv_2024-10-31; do
     curl -sSfLO https://fdc.nal.usda.gov/fdc-datasets/$z.zip && unzip -q $z.zip; done \
&& cd ~/Projects/CarbBook/server \
&& DATABASE_PATH=$F/carbbook.db USDA_DIR=$F/usda pnpm -s carbbook import-usda \
     $F/FoodData_Central_foundation_food_csv_2026-04-30 $F/FoodData_Central_sr_legacy_food_csv_2018-04 $F/FoodData_Central_survey_food_csv_2024-10-31 \
&& ls -l $F/usda
```
Expected:
```
Imported 13694 foods and 32505 portions (4177 skipped) from 3 datasets
USDA bundle fdc-a5f82e4f92a5 written to /tmp/…/usda
```
and `ls` shows `manifest.json`, `usda-fdc-a5f82e4f92a5.json.gz` (~474 KB) and `usda-fdc-a5f82e4f92a5.sqlite` (~3.6 MB). (The version hash is content-derived; if USDA republishes a dataset at the same URL the hash and counts change — that is fine, the counts above are for the 2026-04-30 / 2018-04 / 2024-10-31 files.)

- [ ] **Step 4: Spot-check real search and portions**

Run in the **same shell** as Step 3 (it reuses `$F`):
```bash
cd ~/Projects/CarbBook/server && node -e '
const Database = require("better-sqlite3");
const db = new Database(process.argv[1], { readonly: true });
console.log(db.prepare("SELECT u.fdc_id, u.name, u.carbs_per_100g FROM usda_fts JOIN usda_food u ON u.fdc_id = usda_fts.rowid WHERE usda_fts MATCH ? ORDER BY bm25(usda_fts) LIMIT 3").all("\"rice\"* \"cooked\"*"));
console.log(db.prepare("SELECT kind, count(*) n FROM usda_portion GROUP BY kind").all());
' $F/carbbook.db
```
Expected:
```
[
  { fdc_id: 168897, name: 'Wild rice, cooked', carbs_per_100g: 21.34 },
  { fdc_id: 168914, name: 'Rice noodles, cooked', carbs_per_100g: 24.01 },
  { fdc_id: 2708356, name: 'Rice noodles, cooked', carbs_per_100g: 23.87 }
]
[ { kind: 'count', n: 16618 }, { kind: 'serving', n: 6361 }, { kind: 'volume', n: 9526 } ]
```

- [ ] **Step 5: Commit (only if anything changed)**

```bash
cd ~/Projects/CarbBook && git status --short
```
Expected: clean working tree.

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| §3 usda_food / usda_portion, read-only, bundle not per-row sync | 7, 9, 10 |
| §5 push: LWW (`updated_at`, tie → higher `updated_by`) via core `isNewer`, new `server_seq` | 2 |
| §5 pull `?since=` paged | 4, 5 |
| §5 soft deletes only | 2, 4, 6 |
| §5 USDA versioned bundle: SQLite (iOS) + compressed JSON (web) | 10, 11 |
| §3 meal cycles rejected on save (core `wouldCreateCycle`) | 3 |
| §6 USDA Foundation + SR Legacy + FNDDS CSV import, branded excluded | 9 |
| Carry-over: portion labels → core volume ids (`ml l tsp tbsp floz cup`) + kind volume, else count/serving | 8 |
| §6 OFF lookup: local barcode first, normalize carbs/fiber/serving → portion, draft | 13, 14 |
| §6 FTS5 search, ranking meals/custom → recent → USDA | 7, 12 |
| §7 viewer cannot write dose_settings, reported per record | 3, 5, 6 |
| dose_settings append-only: reject delete or field edit of an existing version | 3 |
| §9 OFF failure/timeout (5 s) → manual entry prefilled with code | 13, 14 (`unavailable` + code; timeout from `HTTP_TIMEOUT_MS` = 5000) |
| §9 per-record push validation failures returned | 1, 2, 5 |
| §10 sync tests: two offline clients, LWW ties, deletes, viewer rejections | 6 |

Placeholder scan: no TBD/TODO; every code step has full code; every command has expected output. Type consistency: `PushChange`/`PushResult` (Tasks 2–3) match `routes/sync.ts` and the scenarios; `TABLE_SPECS`/`decodeRow` (Task 1) are reused by pull (4) and barcode (14); `USDA_FIXTURES` is defined in Task 9 before Tasks 10–12 import it; `OffClient` (13) is added to `AppDeps` in 14, after which `helpers.ts` supplies `unusedOff`.
