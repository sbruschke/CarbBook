# Meal planning and carb goals — design spec

Date: 2026-09-16
Status: approved; delivery step 1 (core goalStatus + vectors, server migration/validation, seeded goals) implemented
Amends `2026-09-13-carbbook-design.md` (adds §12 planning) and `2026-09-14-any-unit-foods.md` (unchanged).

## 1. Purpose

Plan meals ahead — up to a week or more — and have a planned slot offered in the Calculator
at the right time, without ever being forced on the user. Plus per-window carb goals with
colour feedback on planned, in-progress and logged carbs.

User decisions (2026-09-16):
- A planned slot holds the same rows as the Calculator (foods and/or saved meals with amounts).
- Real dates, with copy day/week actions (no recurrence engine).
- The Calculator *suggests* a plan; one tap loads it; loaded items are fully editable.
- Slots track planned vs actually eaten.
- Goals: Breakfast 30–50 g; Lunch 50–80 g; Dinner 50–80 g; AM/PM/HS Snack 10–30 g.

Non-goals: shopping lists, recurrence rules, reminders/notifications, calorie or macro targets,
automatic matching of an unplanned log to a planned slot.

## 2. Data model (synced, same metadata as every other synced table)

- **plan_entry** — `date` (`YYYY-MM-DD`, local), `window_name` (matches a dose-settings window
  name), `status` (`planned` | `logged` | `skipped`), `note?`, `log_entry_id?` (set when logged
  from this slot).
  At most one non-deleted entry per (date, window_name); a second one is rejected as
  `duplicate_slot`.
- **plan_item** — `plan_entry_id`, `ref_type` (`food` | `meal`), `ref_id`, `amount`, `unit`,
  `position`. Same shape as `log_item` minus the snapshot fields.
- Carbs for a plan are computed live with core `itemCarbs`/`sumCarbs`. Plans never snapshot;
  logging snapshots as it does today. An item whose food no longer resolves shows as incomplete
  (existing rule), and the slot shows "missing data" rather than a number.
- Migration `004_meal_plan.sql` creates both tables with the usual indexes, CHECKs
  (`status` enum, `ref_type` enum, `amount >= 0`) and the partial unique index for the slot rule.

### Carb goals
`dose_settings.windows[]` gains `carb_goal: { min, max } | null`. Rules: both finite, `0 <= min
<= max <= DOSE_LIMITS.maxCarbsG` (2000); `null` means no goal for that window. Seeded from the
user's numbers above on first run after the migration, as a **new** dose-settings version
(append-only, effective now) — existing versions are untouched, and dose math ignores the field.

## 3. Colour feedback (core, shared by web and iOS)

`goalStatus(carbs, goal)` returns `none` (no goal or incomplete carbs), `in` (green),
`near` (yellow), `off` (orange) or `out` (red):

```
d = 0 if goal.min <= carbs <= goal.max
    else min(|carbs - goal.min|, |carbs - goal.max|)
d == 0 → in;  d <= 5 → near;  d <= 10 → off;  else out
```

Shown with the numbers in text ("68 g · goal 50–80"), never colour alone; each state also has a
short label for screen readers. Day totals use the sum of that day's window goals (windows
without a goal contribute nothing to either side, and the day total is `none` if no window in
the day has a goal).

Applied to: plan slots and day totals (Plan screen), the Calculator's running total for the
current window, and each Log entry against its entry's window.

## 4. Plan screen (web and iOS)

- Week grid: days as rows, that day's windows as columns (phone: day list, windows stacked).
- A cell shows its items, total carbs with goal colour, and status; empty cells show "+".
- Editing a cell uses the existing item picker (search foods/meals, amount + unit, fractions).
- **Copy day → date**, **copy week → next week**. When the target has entries, ask: replace,
  merge (append items) or skip.
- Week navigation; past weeks readable as history.
- Owner and viewers can both edit plans (same rule as meals and logs).

## 5. Calculator integration

- When the current date+window has a `planned` slot, a line appears above the items:
  "Planned: <items>, N g — Load / Skip / Dismiss".
- **Load** appends the slot's items to the Calculator (editable, removable like any row) and
  remembers the slot for this session.
- **Skip** sets the slot's status to `skipped` (syncs).
- **Dismiss** hides the suggestion for that slot on this device only (local storage, keyed by
  date+window; never synced).
- Logging while a slot is loaded sets that slot to `logged` and stores `log_entry_id`.
  Logging without loading changes nothing about the plan.
- Deleting a log entry that a slot points at returns the slot to `planned` and clears the link.

## 6. Sync and validation

- Server validates: date format, `window_name` non-empty (≤ 64 chars), status enum, at most one
  live entry per slot, `log_entry_id` (when set) references an existing log entry row id,
  item `ref_type`/`ref_id`/`amount`/`unit` like log items, `carb_goal` bounds inside
  `dose_settings`.
- Per-record rejection reasons as today (`invalid`, `duplicate_slot`, `forbidden`).
- No referential integrity enforcement (offline-first): a plan item whose food hasn't synced yet
  renders as incomplete.

## 7. Testing

- Core: `goalStatus` boundary cases (exactly min/max, 5.0, 10.0, just past each, no goal,
  incomplete carbs) as shared vectors in `testdata/goal-vectors.json`, run by Vitest and XCTest.
- Server: migration 004 on a copy of the live DB shape; slot uniqueness; goal bounds; viewer
  writes allowed; `log_entry_id` validation.
- Web/iOS: plan a day, copy it to the next day, load in the Calculator, edit, log → slot shows
  logged; skip → slot skipped; dismiss → hidden on that device only, still there on the other.
- Playwright: plan → load → log flow offline, then sync.

## 8. Delivery order

1. Core `goalStatus` + vectors, server migration/validation, seeded goals.
2. Web: Plan screen, Calculator suggestion, goal colours in Calculator and Log.
3. iOS: same, then a release through ipa-hub.
