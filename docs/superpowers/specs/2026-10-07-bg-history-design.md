# BG history, charts and trends — 2026-10-07

Display only. Nothing here reaches the dose estimate.

## Storage (pi-infra `dexcom-api`)
- Every reading Dexcom Share returns goes into SQLite `/opt/dexcom-data/readings.db` (`readings`: epoch PK,
  mgdl, trend, source), deduplicated by timestamp. Outside `/opt/pi-infra`, which deploy rsyncs with `--delete`.
- Share serves at most the last 24 h (pydexcom: 1440 min / 288 readings). The first poll, and any poll after a
  gap, asks for enough to cover the gap (up to 24 h), so an outage under a day loses nothing.
- Older history: Dexcom Clarity CSV export →
  `ssh pi 'docker exec -i dexcom-api python app.py import-clarity' < export.csv`. EGV rows only; local times
  read in the container's TZ; "Low"/"High" stored as 40/400.
- `GET /readings?from&to` (epoch s, token, ≤120 days). Backed up nightly with the CarbBook backup
  (`dexcom-readings-*.db.gz`, keep 7, pulled to the desktop).

## CarbBook
- Server `GET /api/bg/readings?from&to` (ms, ≤92 days, any signed-in user) proxies dexcom-api.
- Core `bgStats`, `mealResponse`, `dailyPattern` (TS + Swift, `testdata/bg-stats-vectors.json`). Consensus
  bands: <54, 54–69, 70–180, 181–250, >250. GMI = 3.31 + 0.02392 × mean. Coverage counts only the part of
  the range the history covers.
- Meal response: "before" = latest reading −15…+5 min; peak = highest in the 3 h after; 2 h = closest reading
  within ±10 min of +2 h. A peak no higher than before reads "no rise".
- Log: day chart (target band, line broken over 15-min gaps, out-of-range dots, meal markers) + stats line;
  entry: after-meal chart and line; BG trends: TIR bar, average, GMI, CV, sensor data, daily pattern, per-window
  after-meal averages. PDF: CGM summary block, chart per day, "After:" line per entry; offline it prints a note
  instead.
- Charts: web SVG `web/src/bg/chart.ts` (screen + PDF) ⇄ `CarbBookKit/BgChartSvg.swift` (iOS PDF). iOS
  screens use Swift Charts.
