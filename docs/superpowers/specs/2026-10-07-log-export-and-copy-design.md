# Log export (PDF) and copy/paste from the log — 2026-10-07

## Export
- Log screen → **Export PDF…** (web) / share icon (iOS). Pick From/To (presets 7/14/30/90 days;
  default the week ending on the day being viewed).
- Built from the device's local log (works offline, includes unsynced entries).
- Core `buildLogReport` (TS + Swift, vectors `testdata/log-report-vectors.json`) groups entries onto
  the range's days and totals them. The platform supplies day keys, times and headings.
- Summary: entries, days logged, carbs (avg per *logged* day — an unlogged day is missing data, not
  0 g), insulin taken, BG avg/range, carb-goal counts. Per day: time, window, BG, carbs vs. the
  window goal (colour + words), suggested, taken (bold), items with amounts, notes. Empty days read
  "Nothing logged".
- Rendering: one HTML layout, `web/src/log/reportHtml.ts` ⇄ `CarbBookKit/LogReportHtml.swift` (keep in
  step). Web prints it from a hidden iframe ("Save as PDF"); iOS renders a US Letter PDF with
  `UIPrintPageRenderer` and offers Preview + Share.

## Copy / paste
- Log entry editor: **Copy meal** (all rows) or Copy on one row (web button; iOS swipe or long-press).
- In-app clipboard, per device, never synced (web localStorage `carbbook.clipboard`, iOS UserDefaults
  `log.clipboard`). One clipboard; a new copy replaces it. A text list also goes on the system clipboard.
- Core `clipItemsFromLog`: ref/amount/unit/label only. A quick row's label is its logged name unless
  that is the default name.
- Calculator and plan-slot editor show "Copied: … · N items — Paste / Clear". Paste appends fresh
  rows (new ids; quick rows point at their own new id) and keeps the clipboard. Pasted carbs
  recompute from today's foods, like a loaded plan — a food that no longer resolves is incomplete
  and refuses a dose.
