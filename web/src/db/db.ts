import type {
  BarcodeData,
  DoseSettingsData,
  FoodData,
  ImageData,
  LogEntryData,
  LogItemData,
  MealData,
  MealItemData,
  PlanEntryData,
  PlanItemData,
  PortionData,
  PortionKind,
  Synced,
} from '@carbbook/core';
import Dexie, { type Table } from 'dexie';
import type { User } from '../lib/wire';

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
  'plan_entry',
  'plan_item',
  'image',
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
  plan_entry: Synced<PlanEntryData>;
  plan_item: Synced<PlanItemData>;
  image: Synced<ImageData>;
}

export type AnySyncRecord = SyncRecords[SyncTable];

/** One pending local change per record; survives reloads because it lives in IndexedDB. */
export interface OutboxRow {
  key: string;
  table: SyncTable;
  id: string;
  /** updated_at of the local write that queued it. */
  updated_at: number;
  /** Last server-acknowledged copy of the record, or null if it was never synced. Restored on rejection. */
  snapshot: AnySyncRecord | null;
  /**
   * Id of the signed-in user who queued this entry (unindexed: only ever read via a full-table
   * scan of the outbox, which stays small). `null` for rows migrated in before this field existed
   * whose owner could not be determined (no cached user at migration time) — treated as owned by
   * whoever is currently signed in, never stranded as foreign. Never mutated after being queued:
   * ownership travels with the entry so a later `restoreSession` overwriting the cached user can't
   * make it look like the current session's own change (spec: sync-integrity, multi-user device).
   */
  ownerId: number | null;
  /** Username of `ownerId` at queue time, kept only for display (e.g. "held from brett"). */
  ownerUsername: string | null;
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
  /**
   * `updated_at` of the record version that was pushed and rejected. Used to tell a successfully
   * restored/deleted row (safe to use again) from one where the restore itself failed (still at
   * the rejected version — keep excluding it as a backstop).
   */
  rejectedUpdatedAt: number;
  /**
   * Set once a pull applies a server row for this key, proving the id is live and synced again.
   * The row stays for history (Settings → Sync) but no longer affects selection.
   */
  resolved: boolean;
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
  declare plan_entry: Table<SyncRecords['plan_entry'], string>;
  declare plan_item: Table<SyncRecords['plan_item'], string>;
  declare image: Table<SyncRecords['image'], string>;
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
    // v2 adds `ownerId`/`ownerUsername` to outbox rows (data-only change: `ownerId` stays
    // unindexed, so the store definition below is unchanged from v1). Existing rows queued before
    // this field existed are backfilled from whichever user was cached locally at migration time —
    // the only user those pre-existing entries could have belonged to, since per-entry ownership
    // didn't exist yet.
    this.version(2)
      .stores({
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
      })
      .upgrade(async (tx) => {
        const cached = (await tx.table('meta').get('user')) as { value: User } | undefined;
        const owner = cached?.value;
        await tx
          .table('outbox')
          .toCollection()
          .modify((row: OutboxRow) => {
            row.ownerId = owner?.id ?? null;
            row.ownerUsername = owner?.username ?? null;
          });
      });
    // v3 adds the two meal-planning tables (spec 2026-09-16 §2). Pure additions: no existing
    // store definition changes and no data migration is needed.
    this.version(3).stores({
      food: 'id, source_ref',
      portion: 'id, food_id',
      barcode: 'id, code, food_id',
      meal: 'id',
      meal_item: 'id, meal_id, ref_id',
      log_entry: 'id, eaten_at',
      log_item: 'id, log_entry_id, ref_id',
      dose_settings: 'id, effective_from',
      plan_entry: 'id, date, window_name, log_entry_id',
      plan_item: 'id, plan_entry_id, ref_id',
      outbox: 'key',
      meta: 'key',
      sync_error: 'key, at',
      usda_food: 'fdc_id',
      usda_portion: 'id, fdc_id',
      pending_barcode: 'code',
    });
    // v4 adds the `image` metadata table and an `image_id` index on `food` and `meal` (images
    // spec 2026-09-18). A pure addition: no existing store definition changes, no data migration
    // is needed, and the pull cursor is left alone — the rows are new on the server too, so they
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
  }

  /** Every synced table, for read-write transactions that touch records and the outbox. */
  syncTables(): Table[] {
    return SYNC_TABLES.map((name) => this.table(name));
  }
}
