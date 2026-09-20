# Apple Health writes + meal-plan week controls

2026-09-20. Two independent features, specced together because they ship in one round.

## 1. Apple Health writes

### Goal

Saving a log entry on the iPhone records that meal's carbs and the insulin actually taken as Apple
Health samples, so Health holds the shared record other apps and the user's care team read. Nothing
is read back: BG already comes from the Dexcom endpoint.

### Feasibility gate (do this first)

CarbBook is sideloaded inside LiveContainer, and a guest app inherits **LiveContainer's**
entitlements, not its own — its own `com.apple.developer.healthkit` would be ignored. LiveContainer's
`entitlements.xml` does request `com.apple.developer.healthkit`, `…healthkit.access` and
`…healthkit.background-delivery`, but whether the installed copy kept them depends on the certificate
it was signed with.

Implementation therefore starts with a throwaway build that does nothing but request Health
authorization and write one carb sample under LiveContainer. If that fails, the native path is dead
and the fallback is the Shortcuts bridge (below) — decided before any real code is written.

### Architecture

Pure decision logic in `CarbBookKit`, a thin adapter in the app:

- `healthSamples(for entry: LogEntryData) -> [HealthSample]` in `CarbBookKit`. Plain Swift, no
  HealthKit import, so it compiles and is tested on Linux like the rest of the core.
  `HealthSample` is `{ kind: .carbohydrates | .insulinBolus, value: Double, at: Int64, externalId: String }`.
- `HealthWriter` in `ios/CarbBook/Health/`. Converts `HealthSample` to `HKQuantitySample`, owns
  authorization and the written-entry record. The only untestable code, and it holds no rules.

### Rules

Both samples are timestamped at the entry's `eaten_at` (start == end):

| condition | sample |
|---|---|
| total carbs > 0 | `dietaryCarbohydrates`, grams |
| taken units > 0 | `insulinDelivery`, IU, `HKMetadataKeyInsulinDeliveryReason = .bolus` |

- Only the **taken** dose is ever written. A blank taken dose writes no insulin sample; its carbs
  still write. The suggested estimate is never written — Health must not record insulin that may not
  have been injected.
- Every sample carries `HKMetadataKeyExternalUUID = <log entry id>`.
- Zero or missing values write no sample rather than a zero sample.

### Sync model: write once at save time

- Only entries saved **on this iPhone** write, at the moment of saving. Entries created on the web or
  another device are never written.
- A written entry's id is recorded locally; re-saving it writes nothing, so an edit cannot duplicate
  samples. Accepted consequence: an edited entry's Health samples keep the old numbers, and a deleted
  entry's samples remain. Both are fixed in the Health app by hand.

### Settings and failure

- A "Write to Apple Health" switch in Settings, **off by default**, per device (`UserDefaults`), that
  requests authorization on first enable. This is a device capability, not an account preference, so
  it is deliberately not synced.
- The switch's row shows the last write's status, so a silent failure is visible.
- A Health failure never blocks or fails a log save: the CarbBook log is the record of truth. The
  error is surfaced, not thrown.

### Rejected alternatives

- **Writing from `LogEntryView`'s save path directly.** Fewer files, but every rule above would live
  where no test can reach it.
- **Shortcuts bridge** (App Intent + a Shortcut that writes Health samples). Sidesteps entitlements
  entirely, but needs an automation per meal and cannot run unattended. Held in reserve for a failed
  feasibility gate.
- **Mirroring the log continuously** (rewriting and deleting samples to match edits). More faithful,
  but needs reconciliation on every sync and delete-tracking for samples this device may not own.

## 2. Meal-plan week controls

### Week start

The platforms currently disagree: web hardcodes Monday (`web/src/ui/format.ts` `startOfWeek`), iOS
follows `calendar.firstWeekday` (Sunday in the US). One synced setting fixes the inconsistency and
makes the day configurable.

- New sync table `preference`: `id` (the key) + `value` TEXT, on the existing push/pull machinery —
  a table spec, not new sync code. Server migration `007_preferences.sql`, GRDB migration
  `v6-preferences`, Dexie version 5.
- One row: `week_start` = `sun` | `mon` | `tue` | `wed` | `thu` | `fri` | `sat`. Default `sun`,
  matching what the iPhone shows today. Web users' grid shifts once, which is the point.
- `startOfWeek` (web) and `PlanDate.week(containing:)` (iOS) take the first day as a parameter
  instead of hardcoding Monday or reading the device calendar. Shared JSON vectors cover the 7×7
  day × week-start grid so both cores agree.
- A "Week starts on" picker in Settings on both platforms.
- Plan rows are keyed by date, not by week, so changing the setting re-slices the grid with no data
  migration.

Rejected: storing it on `dose_settings`, which is append-only and dosing-relevant — a UI preference
does not belong in medical settings versions. Rejected: per-device storage, which would not follow
the user to a new device and would leave the platforms free to disagree again.

### Today

- Web gets a "Today" button beside the week arrows that snaps to the week containing the current day.
  iOS already has one (`PlanWeekView.swift`, bottom bar).
- Both platforms mark the current day in the grid: web highlights the day column header, iOS the day
  section header.
- The date comes from the injected `now()` (web) and the existing clock (iOS), so tests pin it.

## Testing

- `healthSamples(for:)`: shared JSON vectors — carbs only, carbs + bolus, blank taken dose, zero
  carbs, correction-only entry.
- Week start: shared JSON vectors over all 7 week-start values, including year boundaries and DST
  days, asserting web and iOS produce identical weeks.
- Web: a Plan test that "Today" snaps to the right week and that the current day is marked.
- `HealthWriter` itself is verified on-device, not by tests: the feasibility gate build, then one
  real meal checked in the Health app.
