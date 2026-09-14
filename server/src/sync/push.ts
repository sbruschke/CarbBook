import { createCatalog, isNewer, type MealItemData, wouldCreateCycle } from '@carbbook/core';
import type { Role } from '../auth/users';
import { type Db, nextServerSeq } from '../db';
import { columnsOf, isSyncTable, type TableSpec, TABLE_SPECS } from './tables';
import { mergeMissingFields, type SqlRow, validateRecord } from './validate';

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

/** All non-deleted meal_items, loaded once per push batch rather than requeried per record. */
function loadMealItems(db: Db): MealItemData[] {
  return db
    .prepare(`SELECT id, meal_id, ref_type, ref_id, amount, unit, position FROM meal_item WHERE deleted = 0`)
    .all() as MealItemData[];
}

/**
 * Would saving this meal_item make a meal contain itself? Uses core's wouldCreateCycle against
 * the batch's live meal_item snapshot, which the caller keeps in sync as earlier records in the
 * same push are accepted (so later checks in the batch see them without a re-query).
 */
function createsCycle(mealItems: MealItemData[], row: SqlRow): boolean {
  const others = mealItems.filter((item) => item.id !== row.id);
  const candidate = {
    id: row.id,
    meal_id: row.meal_id,
    ref_type: row.ref_type,
    ref_id: row.ref_id,
    amount: row.amount,
    unit: row.unit,
    position: row.position,
  } as MealItemData;
  const catalog = createCatalog({ meal_items: [...others, candidate] });
  return wouldCreateCycle(catalog, candidate.meal_id, candidate.ref_id);
}

/** Reflects an accepted meal_item write into the batch's live snapshot for later cycle checks. */
function updateMealItemsSnapshot(mealItems: MealItemData[], row: SqlRow): void {
  const index = mealItems.findIndex((item) => item.id === row.id);
  if (index !== -1) mealItems.splice(index, 1);
  if (row.deleted === 0) {
    mealItems.push({
      id: row.id,
      meal_id: row.meal_id,
      ref_type: row.ref_type,
      ref_id: row.ref_id,
      amount: row.amount,
      unit: row.unit,
      position: row.position,
    } as MealItemData);
  }
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

function applyOne(db: Db, role: Role, change: PushChange, mealItems: MealItemData[]): PushResult {
  const id = recordId(change.record);
  const table = String(change.table);
  if (!isSyncTable(change.table)) {
    return { table, id, status: 'rejected', reason: 'unknown_table', message: `Unknown table "${table}"` };
  }
  const spec = TABLE_SPECS[change.table];
  // Missing keys keep the stored values (old clients don't know newer columns); validate the merge.
  const storedRow =
    id === null ? undefined : (db.prepare(`SELECT * FROM ${spec.name} WHERE id = ?`).get(id) as Record<string, unknown> | undefined);
  const validation = validateRecord(spec, mergeMissingFields(spec, change.record, storedRow));
  if (!validation.ok) return { table, id, status: 'rejected', reason: 'invalid', message: validation.message };
  const row = validation.row;
  const rowId = row.id as string;

  if (spec.ownerOnly && role !== 'owner') {
    return { table, id: rowId, status: 'rejected', reason: 'forbidden', message: `Only the owner can change ${table}` };
  }

  // Append-only safety must hold regardless of LWW freshness: an older or stale attempt to
  // delete/edit an existing dose_settings version is rejected, not silently ignored, so the
  // client learns the write is forbidden rather than merely stale.
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

  const stored = storedRow as { updated_at: number; updated_by: string; server_seq: number } | undefined;
  const incoming = { updated_at: row.updated_at as number, updated_by: row.updated_by as string };
  if (stored && !isNewer(incoming, stored)) {
    return { table, id: rowId, status: 'ignored', server_seq: stored.server_seq };
  }

  if (spec.name === 'meal_item' && row.deleted === 0 && row.ref_type === 'meal' && createsCycle(mealItems, row)) {
    return { table, id: rowId, status: 'rejected', reason: 'cycle', message: 'A meal cannot contain itself' };
  }

  const serverSeq = nextServerSeq(db);
  upsert(db, spec, { ...row, server_seq: serverSeq });
  if (spec.name === 'meal_item') updateMealItemsSnapshot(mealItems, row);
  return { table, id: rowId, status: 'accepted', server_seq: serverSeq };
}

/** Applies pushed records in order inside one transaction; each record gets its own result. */
export function applyPush(db: Db, role: Role, changes: PushChange[]): PushResult[] {
  return db.transaction(() => {
    const mealItems = loadMealItems(db);
    return changes.map((change) => applyOne(db, role, change, mealItems));
  })();
}
