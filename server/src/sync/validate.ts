import type { FieldSpec, TableSpec } from './tables';

/** A row ready for SQLite: JSON fields are serialized, server_seq is not assigned yet. */
export type SqlRow = Record<string, string | number | null>;

export type ValidationResult = { ok: true; row: SqlRow } | { ok: false; message: string };

const MAX_ID_LENGTH = 64;
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

function checkField(name: string, spec: FieldSpec, value: unknown): { value: string | number | null } | { error: string } {
  if (spec.type === 'json') {
    const problem = spec.check(value);
    if (problem) return { error: problem };
    const canonical = spec.canonicalize ? spec.canonicalize(value) : value;
    return { value: JSON.stringify(canonical) };
  }
  if (value === undefined || value === null) {
    if ((spec.type === 'text' || spec.type === 'number') && spec.nullable) return { value: null };
    return { error: `${name} is required` };
  }
  switch (spec.type) {
    case 'text': {
      if (typeof value !== 'string') return { error: `${name} must be a string` };
      const trimmed = spec.trim ? value.trim() : value;
      if (!spec.nullable && trimmed.trim() === '') return { error: `${name} must not be empty` };
      if (trimmed.length > (spec.max ?? 200)) return { error: `${name} is longer than ${spec.max ?? 200} characters` };
      return { value: trimmed };
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `${name} must be a finite number` };
      if (spec.integer && !Number.isSafeInteger(value)) return { error: `${name} must be an integer` };
      if (spec.positive && value <= 0) return { error: `${name} must be > 0` };
      if (spec.min !== undefined && value < spec.min) return { error: `${name} must be >= ${spec.min}` };
      if (spec.max !== undefined && value > spec.max) return { error: `${name} must be <= ${spec.max}` };
      return { value };
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        return { error: `${name} must be one of ${spec.values.join(', ')}` };
      }
      return { value };
  }
}

/** Validates one pushed record against its table spec. Unknown fields are ignored.
 * `now` is injectable for tests; production callers rely on the Date.now() default. */
export function validateRecord(spec: TableSpec, record: unknown, now: number = Date.now()): ValidationResult {
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
  if (r.updated_at > now + MAX_FUTURE_SKEW_MS) {
    return { ok: false, message: 'updated_at is too far in the future' };
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

/**
 * Fills data fields the incoming record does not mention with the stored row's values, so a client
 * that predates a column (e.g. food.carbs_per_100ml, portion.carbs_g) cannot erase it by omission.
 * A key that is present — including an explicit null — wins. With no stored row (an insert) the
 * record is returned as-is, so missing nullable fields default to null in validateRecord. The
 * result is what gets validated, so cross-field checks see the merged record.
 */
export function mergeMissingFields(spec: TableSpec, record: unknown, stored: Record<string, unknown> | undefined): unknown {
  if (stored === undefined || typeof record !== 'object' || record === null || Array.isArray(record)) return record;
  const decoded = decodeRow(spec, stored);
  const merged: Record<string, unknown> = { ...(record as Record<string, unknown>) };
  for (const name of Object.keys(spec.fields)) {
    if (!Object.hasOwn(merged, name)) merged[name] = decoded[name];
  }
  return merged;
}

/** Converts a stored row back to the wire shape (JSON columns parsed). */
export function decodeRow(spec: TableSpec, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const [name, fieldSpec] of Object.entries(spec.fields)) {
    if (fieldSpec.type === 'json' && typeof out[name] === 'string') out[name] = JSON.parse(out[name] as string);
  }
  return out;
}
