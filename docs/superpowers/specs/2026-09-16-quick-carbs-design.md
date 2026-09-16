# Quick carbs rows and per-meal goals only — design spec

Date: 2026-09-16
Status: approved by the user (2026-09-16)
Amends `2026-09-13-carbbook-design.md` §3/§4 and `2026-09-16-meal-planning-design.md` §3.

## 1. Why

The user logged dinner as "4.3 taquitos" to cover ~7 g of ranch and salad that weren't worth
creating foods for. They want to add carbs without a food. They also want goal colours only per
meal/snack — no whole-day goal.

## 2. Quick carbs rows

- New item kind `ref_type: 'quick'` for `meal_item`, `log_item` and `plan_item`.
  - `amount` = grams of carbs (finite, `0 <= amount <= DOSE_LIMITS.maxCarbsG`), `unit` = `'carbs'`,
    `ref_id` = the item's own id (kept non-null so existing constraints hold), optional
    `label` (≤ 80 chars, e.g. "ranch & salad"; blank shows as "Extra carbs").
  - `log_item` keeps using `display_name` for the label and `carbs_g` = `amount`.
- Core: `itemCarbs(catalog, 'quick', _, amount, 'carbs')` → `{ carbs_g: amount, complete: true }`
  when valid, otherwise incomplete (fail closed). Unit list for a quick row is `['carbs']`.
  Shared vectors in `testdata/units-vectors.json` gain quick cases (0, 7, 2000, 2001, negative,
  wrong unit, NaN-free JSON only).
- Amount entry uses the decimal parser (grams of carbs), not the fraction parser.
- UI (web + iOS): an **+ Carbs** button next to "add food" in the Calculator, meal editor and
  plan slot editor; the row shows "label — N g carbs" and can be edited/removed like any row.
  Totals, dose estimate and goal colours include quick rows exactly like food rows.
- Server: migration `005_quick_carbs.sql` rebuilds `meal_item`, `log_item` and `plan_item` to
  widen the `ref_type` CHECK to include `'quick'` and adds `label TEXT NULL` to `meal_item` and
  `plan_item` (atomic; preserves rows, indexes and `server_seq`; aborts on unexpected data).
  Sync validation accepts `quick` with the rules above and ignores `ref_id` resolution for it.
- Compatibility: the currently released iOS app (0.2.0) can't decode `ref_type: 'quick'`.
  Deploy order: ship the iOS update and the web/server change together, and tell the user to
  update the iPhone app before using **+ Carbs**. The server does not need to hide quick rows.

## 3. Goals per meal/snack only

- Remove the day-total goal colour and goal text from the Plan screen (web + iOS). Day totals
  still show planned grams, with no colour.
- Per-slot, Calculator and Log goal colours are unchanged. Core `dayGoal` may stay but no UI
  uses it; its vectors stay.

## 4. Data fixes after deploy (user-approved)

- **Tonight's dinner (2026-09-16 18:02, Dinner):** change the taquito row from 4.3 to 4
  (68 g) and add a quick row "Ranch & salad" 7 g, so the entry total is 75 g. `taken_units`
  (9) and `suggested_units` (9, what was shown at the time) stay unchanged.
- **Backfill the meal plan from the log:** for every live log entry, create a `plan_entry`
  for (local date of `eaten_at`, `window_name`) with `status: 'logged'`, `log_entry_id` set,
  and `plan_item`s copied from the entry's log items (same ref/amount/unit; quick rows keep
  their label). Skip a slot that already has a live plan entry. All writes go through the
  server's own push path as the owner so validation and `server_seq` apply.

## 5. Testing

Core vectors + unit tests (quick rows, incomplete cases); migration 005 on a copy of the live
DB; sync validation; web/iOS tests for adding/editing/removing quick rows in Calculator, meals
and plans and for the day total having no goal colour; e2e: add 4 taquitos + 7 g quick row →
75 g → log → plan slot shows logged with both rows.
