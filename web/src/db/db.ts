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
