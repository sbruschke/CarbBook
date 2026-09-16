import { createCatalog, isNewer, type MealItemData, wouldCreateCycle } from '@carbbook/core';
import type { Role } from '../auth/users';
import { type Db, nextServerSeq } from '../db';
import { columnsOf, isSyncTable, type TableSpec, TABLE_SPECS } from './tables';
import { mergeMissingFields, type SqlRow, validateRecord } from './validate';

export interface PushChange {
  table: string;
  record: unknown;
}

export type RejectReason = 'unknown_table' | 'invalid' | 'forbidden' | 'cycle' | 'append_only' | 'duplicate_slot';

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

/**
 * Spec §2: at most one non-deleted plan_entry per (date, window_name), case-insensitively ("Lunch"
 * and "lunch" are the same slot). Checked here rather than relying solely on the partial unique
 * index so the offending record gets a per-record rejection instead of the whole push batch
 * failing. Rows accepted earlier in the same batch are already written inside this transaction, so
 * they are visible to this query. window_name is already trimmed by validateRecord before this
 * runs, so only casing needs handling here (mirrored by the migration's COLLATE NOCASE index as a
 * backstop).
 */
function duplicateSlot(db: Db, row: SqlRow): boolean {
  if (row.deleted === 1) return false;
  const clash = db
    .prepare('SELECT 1 FROM plan_entry WHERE date = ? AND window_name = ? COLLATE NOCASE AND deleted = 0 AND id <> ?')
    .get(row.date, row.window_name, row.id);
  return clash !== undefined;
}

/**
 * Spec §6: when a plan entry claims a log entry, that row must already exist on the server AND
 * still be live. Unlike ref_id on items (which may legitimately race ahead of its food),
 * log_entry_id is only ever set by the same client in the same breath as the log entry itself, so
 * a dangling or deleted link means a bug or a stale client, not an out-of-order sync. A soft-deleted
 * log entry must be treated the same as a missing one: the Task 13 revert rule only fires when the
 * delete itself is accepted by this push, so an offline device's later push of a plan entry that
 * still claims an already-deleted log entry is never touched by that rule and must be rejected here
 * instead of silently blessed forever.
 */
function unknownLogEntry(db: Db, row: SqlRow): boolean {
  if (row.log_entry_id == null) return false;
  return db.prepare('SELECT 1 FROM log_entry WHERE id = ? AND deleted = 0').get(row.log_entry_id) === undefined;
}

/**
 * Spec §5: deleting a log entry returns any slot that points at it to `planned` and clears the
 * link. Done server-side, not on the client: the deleting device may never have held the plan row,
 * and doing it here means the repair happens exactly once and reaches every device on the next
 * pull. Each reverted row gets a fresh server_seq, and an updated_at at least one millisecond past
 * its own previous value so a client's stale copy cannot win the next last-write-wins comparison.
 */
function revertPlanEntriesForDeletedLog(db: Db, row: SqlRow): void {
  const affected = db
    .prepare('SELECT id, updated_at FROM plan_entry WHERE log_entry_id = ? AND deleted = 0')
    .all(row.id) as { id: string; updated_at: number }[];
  if (affected.length === 0) return;
  const update = db.prepare(
    `UPDATE plan_entry
        SET status = 'planned', log_entry_id = NULL, updated_at = ?, updated_by = ?, server_seq = ?
      WHERE id = ?`,
  );
  for (const entry of affected) {
    const updatedAt = Math.max(row.updated_at as number, entry.updated_at + 1);
    update.run(updatedAt, row.updated_by, nextServerSeq(db), entry.id);
  }
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

  if (spec.name === 'plan_entry') {
    if (unknownLogEntry(db, row)) {
      return {
        table, id: rowId, status: 'rejected', reason: 'invalid',
        message: `log_entry_id "${String(row.log_entry_id)}" does not reference a known log entry`,
      };
    }
    if (duplicateSlot(db, row)) {
      return {
        table, id: rowId, status: 'rejected', reason: 'duplicate_slot',
        message: `Another plan entry already exists for ${String(row.date)} ${String(row.window_name)}`,
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
  if (spec.name === 'log_entry' && row.deleted === 1) revertPlanEntriesForDeletedLog(db, row);
  return { table, id: rowId, status: 'accepted', server_seq: serverSeq };
}

/** Applies pushed records in order inside one transaction; each record gets its own result. */
export function applyPush(db: Db, role: Role, changes: PushChange[]): PushResult[] {
  return db.transaction(() => {
    const mealItems = loadMealItems(db);
    return changes.map((change) => applyOne(db, role, change, mealItems));
  })();
}
