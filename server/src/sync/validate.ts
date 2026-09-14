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
