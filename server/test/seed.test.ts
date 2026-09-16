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
  it('inserts both versions, idempotently', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(seedDoseSettings(db)).toBe(2);
    expect(seedDoseSettings(db)).toBe(0);
    const seqs = db.prepare('SELECT server_seq FROM dose_settings ORDER BY effective_from').pluck().all();
    expect(seqs).toEqual([1, 2]);
  });

  it('adds only the missing version to a database that already has the older one', () => {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare(
      `INSERT INTO dose_settings (id, effective_from, windows, correction, rounding, updated_at, updated_by, deleted, server_seq)
       VALUES (?, ?, ?, ?, ?, ?, 'pi', 0, 1)`,
    ).run(
      SEED_DOSE_SETTINGS[0]!.id,
      SEED_DOSE_SETTINGS[0]!.effective_from,
      JSON.stringify(SEED_DOSE_SETTINGS[0]!.windows),
      JSON.stringify(SEED_DOSE_SETTINGS[0]!.correction),
      JSON.stringify(SEED_DOSE_SETTINGS[0]!.rounding),
      SEED_DOSE_SETTINGS[0]!.effective_from,
    );
    expect(seedDoseSettings(db)).toBe(1);
    expect(db.prepare('SELECT updated_by FROM dose_settings WHERE id = ?').pluck().get(SEED_DOSE_SETTINGS[0]!.id)).toBe('pi');
  });

  it('stores the owner history exactly as specified', () => {
    const db = initDatabase(':memory:');
    const byDate = Object.fromEntries(
      loadSettings(db).map((s) => [new Date(s.effective_from).toISOString(), s.correction]),
    );
    expect(byDate).toEqual({
      '2026-08-12T05:00:00.000Z': { threshold: 200, step: 50, units_per_step: 1, mode: 'started' },
      '2026-09-16T05:00:00.000Z': { threshold: 200, step: 50, units_per_step: 1, mode: 'started' },
    });
  });

  it('gives the 2026-09-16 version the owner carb goals and leaves the older one without any', () => {
    const db = initDatabase(':memory:');
    const [older, newer] = loadSettings(db).sort((a, b) => a.effective_from - b.effective_from);
    expect(older!.windows.map((w) => w.carb_goal)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(newer!.windows.map((w) => [w.name, w.carb_goal])).toEqual([
      ['Breakfast', { min: 30, max: 50 }],
      ['AM Snack', { min: 10, max: 30 }],
      ['Lunch', { min: 50, max: 80 }],
      ['PM Snack', { min: 10, max: 30 }],
      ['Dinner', { min: 50, max: 80 }],
      ['HS Snack', { min: 10, max: 30 }],
    ]);
  });

  it('keeps the goal version driving dosing identically to the older one', () => {
    const db = initDatabase(':memory:');
    const settings = loadSettings(db);
    const older = activeSettings(settings, Date.parse('2026-09-01T12:00:00Z'))!;
    const newer = activeSettings(settings, Date.parse('2026-09-20T12:00:00Z'))!;
    expect(newer.id).not.toBe(older.id);
    const dose = (s: DoseSettingsData) =>
      estimateDose({ settings: s, minutes: 12 * 60, carbs: { carbs_g: 72, complete: true }, bg: 263 });
    expect(dose(newer)).toMatchObject({ ok: true, units: (dose(older) as { units: number }).units });
  });

  it('makes the 2026-08-12 row drive dosing today (spec §10 vectors)', () => {
    const db = initDatabase(':memory:');
    const active = activeSettings(loadSettings(db), Date.parse('2026-09-14T12:00:00Z'));
    expect(active?.id).toBe(SEED_DOSE_SETTINGS[0]!.id);
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
