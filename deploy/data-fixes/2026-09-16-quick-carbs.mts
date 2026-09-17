// One-off data fix for the quick-carbs release (docs/superpowers/specs/2026-09-16-quick-carbs-design.md §4).
// Every write goes through the server's own push path (applyPush as the owner role), so sync
// validation, last-write-wins and server_seq all apply exactly as for a device push.
//
//   node --import tsx 2026-09-16-quick-carbs.mts            # dry run: prints the plan, writes nothing
//   node --import tsx 2026-09-16-quick-carbs.mts --apply    # writes, then verifies
//
// Env: CARBBOOK_APP (default /app, the image layout), DATABASE_PATH (set in the container).
// Run with the working directory at <app>/server so `--import tsx` resolves.
import { randomUUID } from 'node:crypto';

const APP = process.env.CARBBOOK_APP ?? '/app';
const DB_PATH = process.env.DATABASE_PATH ?? '/data/carbbook.db';
const APPLY = process.argv.includes('--apply');
const TZ = 'America/Chicago';
const OWNER = 'sbruschke';
const DEVICE = 'admin-quick-carbs-2026-09-16';
const TOLERANCE_G = 0.01;

const { openDb } = await import(`${APP}/server/src/db.ts`);
const { applyPush } = await import(`${APP}/server/src/sync/push.ts`);
const core = await import(`${APP}/packages/core/src/index.ts`);

type Row = Record<string, any>;
type Change = { table: string; record: Row };

const db = openDb(DB_PATH);
const version = db.pragma('user_version', { simple: true }) as number;
if (version < 5) throw new Error(`user_version is ${version}; deploy migration 005 first`);
const owner = db.prepare('SELECT role FROM user WHERE username = ?').get(OWNER) as { role: string } | undefined;
if (owner?.role !== 'owner') throw new Error(`${OWNER} is not an owner account (found ${owner?.role ?? 'nothing'})`);

const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const localDate = (ms: number): string => day.format(new Date(ms)); // "YYYY-MM-DD"
const localTime = (ms: number): string =>
  new Date(ms).toLocaleString('en-US', { timeZone: TZ, hour12: false, dateStyle: 'short', timeStyle: 'medium' });

let clock = Date.now();
/** Strictly increasing updated_at, always newer than the stored row (last-write-wins). */
const stamp = (stored?: Row): number => {
  clock = Math.max(clock + 1, (stored?.updated_at ?? 0) + 1);
  return clock;
};
const meta = (stored?: Row) => ({ updated_at: stamp(stored), updated_by: DEVICE, deleted: 0 });
const withoutSeq = (row: Row): Row => {
  const { server_seq: _seq, ...rest } = row;
  return rest;
};

function catalog() {
  const live = (table: string) => db.prepare(`SELECT * FROM ${table} WHERE deleted = 0`).all() as Row[];
  return core.createCatalog({ foods: live('food'), portions: live('portion'), meals: live('meal'), meal_items: live('meal_item') });
}

function push(label: string, changes: Change[]): void {
  console.log(`\n${label}: ${changes.length} change(s)`);
  for (const c of changes) console.log(`  ${c.table} ${c.record.id} ${JSON.stringify(withoutSeq(c.record))}`);
  if (!APPLY || changes.length === 0) return;
  // One outer transaction: any non-accepted record rolls back the whole step.
  db.transaction(() => {
    const results = applyPush(db, 'owner', changes) as { status: string; id: string | null; message?: string }[];
    const bad = results.filter((r) => r.status !== 'accepted');
    if (bad.length > 0) throw new Error(`${label}: push not accepted: ${JSON.stringify(bad)}`);
  })();
  console.log(`  applied`);
}

// ---- 1. Tonight's dinner: 4.3 taquitos (73.1 g) → 4 taquitos (68 g) + "Ranch & salad" 7 g = 75 g ----
function dinnerFix(): Change[] {
  const from = Date.parse('2026-09-16T23:02:00Z'); // 18:02 CDT
  const to = Date.parse('2026-09-16T23:03:00Z');
  const entries = db
    .prepare(`SELECT * FROM log_entry WHERE deleted = 0 AND window_name = 'Dinner' AND eaten_at >= ? AND eaten_at < ?`)
    .all(from, to) as Row[];
  if (entries.length !== 1) throw new Error(`expected 1 dinner entry at 18:02 CDT, found ${entries.length}`);
  const entry = entries[0]!;
  console.log(`dinner entry ${entry.id} at ${localTime(entry.eaten_at)}: total ${entry.total_carbs_g}, suggested ${entry.suggested_units}, taken ${entry.taken_units}`);
  const items = db.prepare('SELECT * FROM log_item WHERE deleted = 0 AND log_entry_id = ? ORDER BY rowid').all(entry.id) as Row[];

  const already = items.length === 2 && items.some((i) => i.ref_type === 'quick') && entry.total_carbs_g === 75;
  if (already) {
    console.log('dinner already fixed; skipping');
    return [];
  }
  if (entry.suggested_units !== 9 || entry.taken_units !== 9) throw new Error('dinner units are not 9/9; stop and ask');
  if (items.length !== 1) throw new Error(`expected 1 dinner item, found ${items.length}`);
  const taquito = items[0]!;
  const looksRight =
    taquito.ref_type === 'food' &&
    /taquito/i.test(taquito.display_name) &&
    Math.abs(taquito.amount - 4.3) < 1e-9 &&
    String(taquito.unit).startsWith('p:') &&
    Math.abs(taquito.carbs_g - 73.1) < TOLERANCE_G &&
    Math.abs(entry.total_carbs_g - 73.1) < TOLERANCE_G;
  if (!looksRight) throw new Error(`dinner item is not "4.3 taquitos = 73.1 g": ${JSON.stringify(taquito)}`);

  const four = core.itemCarbs(catalog(), 'food', taquito.ref_id, 4, taquito.unit);
  if (!four.complete || Math.abs(four.carbs_g - 68) > TOLERANCE_G) {
    throw new Error(`4 taquitos should be 68 g now, core says ${JSON.stringify(four)}`);
  }
  const quickId = randomUUID();
  const quick = {
    id: quickId,
    log_entry_id: entry.id,
    ref_type: 'quick',
    ref_id: quickId,
    display_name: 'Ranch & salad',
    amount: 7,
    unit: core.QUICK_UNIT,
    carbs_g: 7,
  };
  return [
    { table: 'log_item', record: { ...withoutSeq(taquito), amount: 4, carbs_g: four.carbs_g, ...meta(taquito) } },
    { table: 'log_item', record: { ...quick, ...meta() } },
    // Only the total changes: suggested_units and taken_units stay 9 (what was shown and taken).
    { table: 'log_entry', record: { ...withoutSeq(entry), total_carbs_g: four.carbs_g + 7, ...meta(entry) } },
  ];
}

// ---- 2. Backfill plan slots from every live log entry ----
function backfill(): { changes: Change[]; skipped: string[] } {
  const entries = db.prepare('SELECT * FROM log_entry WHERE deleted = 0 ORDER BY eaten_at, id').all() as Row[];
  const liveSlot = db.prepare(
    'SELECT id FROM plan_entry WHERE deleted = 0 AND date = ? AND window_name = ? COLLATE NOCASE',
  );
  const linked = db.prepare('SELECT id FROM plan_entry WHERE deleted = 0 AND log_entry_id = ?');
  const itemsOf = db.prepare('SELECT * FROM log_item WHERE deleted = 0 AND log_entry_id = ? ORDER BY rowid');
  const claimed = new Set<string>();
  const changes: Change[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    const when = `${localTime(entry.eaten_at)} ${entry.window_name ?? '(no window)'}`;
    if (!entry.window_name) {
      skipped.push(`${entry.id} ${when}: no window`);
      continue;
    }
    const date = localDate(entry.eaten_at);
    const key = `${date}|${String(entry.window_name).trim().toLowerCase()}`;
    if (liveSlot.get(date, String(entry.window_name).trim()) || claimed.has(key)) {
      skipped.push(`${entry.id} ${when}: slot ${date} ${entry.window_name} already has a live plan entry`);
      continue;
    }
    if (linked.get(entry.id)) {
      skipped.push(`${entry.id} ${when}: already linked to a plan entry`);
      continue;
    }
    claimed.add(key);
    const planId = randomUUID();
    changes.push({
      table: 'plan_entry',
      record: {
        id: planId,
        date,
        window_name: entry.window_name,
        status: 'logged',
        note: null,
        log_entry_id: entry.id,
        ...meta(),
      },
    });
    (itemsOf.all(entry.id) as Row[]).forEach((item, position) => {
      const id = randomUUID();
      const quick = item.ref_type === 'quick';
      changes.push({
        table: 'plan_item',
        record: {
          id,
          plan_entry_id: planId,
          ref_type: item.ref_type,
          ref_id: core.itemRefId(item.ref_type, item.ref_id, id),
          amount: item.amount,
          unit: item.unit,
          position,
          label: quick ? core.normalizeQuickLabel(item.display_name === core.QUICK_DEFAULT_LABEL ? null : item.display_name) : null,
          ...meta(),
        },
      });
    });
  }
  return { changes, skipped };
}

// ---- 3. Verify ----
function verify(): number {
  const cat = catalog();
  const logged = db.prepare('SELECT * FROM log_entry WHERE deleted = 0 AND window_name IS NOT NULL').all() as Row[];
  const slots = db.prepare("SELECT * FROM plan_entry WHERE deleted = 0 AND status = 'logged' AND log_entry_id IS NOT NULL").all() as Row[];
  const itemsOf = db.prepare('SELECT * FROM plan_item WHERE deleted = 0 AND plan_entry_id = ? ORDER BY position');
  const nameOf = (i: Row): string =>
    i.ref_type === 'quick'
      ? core.quickDisplayName(i.label)
      : ((i.ref_type === 'food' ? cat.food(i.ref_id)?.name : cat.meal(i.ref_id)?.name) ?? `missing ${i.ref_id}`);
  console.log(`\nverify: ${logged.length} live log entries with a window, ${slots.length} logged plan slots`);
  let differences = 0;
  for (const entry of logged) {
    const slot = slots.find((s) => s.log_entry_id === entry.id);
    if (!slot) {
      console.log(`  NO SLOT  ${localTime(entry.eaten_at)} ${entry.window_name} (${entry.id})`);
      differences++;
      continue;
    }
    const items = itemsOf.all(slot.id) as Row[];
    const carbs = core.sumCarbs(items.map((i) => core.itemCarbs(cat, i.ref_type, i.ref_id, i.amount, i.unit)));
    const diff = carbs.carbs_g - entry.total_carbs_g;
    const ok = carbs.complete && Math.abs(diff) <= TOLERANCE_G;
    if (!ok) differences++;
    console.log(
      `  ${ok ? 'ok      ' : 'DIFFERS '} ${slot.date} ${slot.window_name}: plan ${carbs.carbs_g.toFixed(2)} g` +
        `${carbs.complete ? '' : ' (incomplete)'} vs log ${Number(entry.total_carbs_g).toFixed(2)} g` +
        `${ok ? '' : ` (diff ${diff.toFixed(2)} g; a food changed since logging — log left as is)`}` +
        ` · ${items.map((i) => `${i.amount} ${i.unit} ${nameOf(i)}`).join(', ')}`,
    );
  }
  return differences;
}

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} on ${DB_PATH} (user_version ${version})`);
push('dinner fix', dinnerFix());
const plan = backfill();
for (const s of plan.skipped) console.log(`skip ${s}`);
push('plan backfill', plan.changes);
if (APPLY) {
  const differences = verify();
  console.log(differences === 0 ? '\nall slots match their log totals' : `\n${differences} slot(s) differ — report them, do not edit logs`);
}
db.close();
