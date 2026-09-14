import type { DoseSettingsData, DoseWindow, RoundingRule } from '@carbbook/core';
import { type Db, nextServerSeq } from './db';

export const SEED_DEVICE_ID = 'server-seed';

/** Owner's ratio windows (spec §3). Historical versions reuse the same windows. */
export const SEED_WINDOWS: DoseWindow[] = [
  { name: 'Breakfast', start: '05:00', ratio_g_per_unit: 8 },
  { name: 'AM Snack', start: '09:00', ratio_g_per_unit: 10 },
  { name: 'Lunch', start: '11:00', ratio_g_per_unit: 8 },
  { name: 'PM Snack', start: '14:00', ratio_g_per_unit: 10 },
  { name: 'Dinner', start: '16:30', ratio_g_per_unit: 8 },
  { name: 'HS Snack', start: '19:30', ratio_g_per_unit: 12 },
];

const SEED_ROUNDING: RoundingRule = { increment: 1, round_down_below_bg: 130 };

/** Local midnight in America/Chicago (CDT, UTC-5) on each effective date. */
const at = (isoDate: string) => Date.parse(`${isoDate}T00:00:00-05:00`);

/**
 * Oldest first. The two 2025 rows from the owner's sliding-scale file ("BG fix" stored as
 * units_per_step, "iteration" as step) are deliberately NOT seeded here: their meaning is
 * unconfirmed, and as transcribed they would suggest dangerous doses if a client ever picked
 * them as the active version. Pending clarification from the owner — only the confirmed
 * 2026-08-12 row is seeded.
 */
export const SEED_DOSE_SETTINGS: DoseSettingsData[] = [
  {
    id: '019ff457-7480-7000-8000-000000000003',
    effective_from: at('2026-08-12'),
    windows: SEED_WINDOWS,
    correction: { threshold: 200, step: 50, units_per_step: 1, mode: 'started' },
    rounding: SEED_ROUNDING,
  },
];

/** Inserts seed versions whose id is not present yet (a deleted seed row is never resurrected). */
export function seedDoseSettings(db: Db): number {
  const exists = db.prepare('SELECT 1 FROM dose_settings WHERE id = ?');
  const insert = db.prepare(
    `INSERT INTO dose_settings
       (id, effective_from, windows, correction, rounding, updated_at, updated_by, deleted, server_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  );
  return db.transaction(() => {
    let inserted = 0;
    for (const s of SEED_DOSE_SETTINGS) {
      if (exists.get(s.id)) continue;
      insert.run(
        s.id,
        s.effective_from,
        JSON.stringify(s.windows),
        JSON.stringify(s.correction),
        JSON.stringify(s.rounding),
        s.effective_from,
        SEED_DEVICE_ID,
        nextServerSeq(db),
      );
      inserted++;
    }
    return inserted;
  })();
}
