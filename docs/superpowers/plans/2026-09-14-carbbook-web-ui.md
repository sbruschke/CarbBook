# CarbBook Web UI and PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the CarbBook web screens (Calculator, Foods with barcode scanning, Meals, Log with "Recalculate from current meal", Settings with the dose-settings version editor and sync status), the signed-in app shell, the installable offline PWA, and the Playwright end-to-end test including offline → reconnect.

**Architecture:** React 19 function components over the data layer from the first web plan. Screens get everything through a `Services` context (`db`, `api`, `store`, `engine`, `user`, `now`, `startScanner`, `signOut`) so tests render them with fakes. Live data comes from `useLiveQuery` (dexie-react-hooks); every carb number comes from core `itemCarbs`/`sumCarbs`, every dose from core `estimateDose` + `formatBreakdown`, units from `foodUnits`/`mealUnits`, cycles from `wouldCreateCycle`, versions from `activeSettings`, the 4-hour warning from `recentDoseWarning`. No UI kit: one mobile-first stylesheet with 48 px touch targets that works at 375 px. vite-plugin-pwa (generateSW) precaches the app shell; a history-API router is enough for five tabs.

**Tech Stack:** as the data plan (React 19.3.0, Vite 8.3.0, Dexie 4.4.6 + dexie-react-hooks 4.4.0, Vitest ^5 + jsdom 30.0.1 + Testing Library, vite-plugin-pwa 1.3.0 with Workbox 7.4, @zxing/browser 0.2.1, @playwright/test 1.63.0).

**Spec:** `docs/superpowers/specs/2026-09-13-carbbook-design.md` §4.3 step 7 (dose display), §4.4 (BG entry), §8 (screens; the Users screen is out of scope, accounts stay CLI-only), §9 (client errors), §10 (Playwright e2e). **Prerequisite:** `docs/superpowers/plans/2026-09-14-carbbook-web-data.md` fully implemented (13 files / 64 tests green). **Branch:** `feat/web`.

---

## Verified facts this plan relies on (2026-09-14)

- Everything in this plan was written into a scratch copy of the workspace on top of the data plan and run: **23 test files / 120 tests passing, `tsc` clean**. `pnpm build` produced `dist/sw.js` with `precache 13 entries (859.99 KiB)` (index.html, CSS, main JS, the lazily loaded ZXing chunk, icons, manifest, registerSW.js) and `NavigationRoute(createHandlerBoundToURL("/index.html"), {denylist:[/^\/api\//]})`; `dist/index.html` gets `<link rel="manifest" href="/manifest.webmanifest">` and `<script id="vite-plugin-pwa:register-sw" src="/registerSW.js">`.
- **Not run:** the Playwright e2e (Task 12) and real-camera scanning. The server was merged after these checks; the e2e start script uses the server's real scripts (`pnpm start`, `pnpm carbbook user add <name> --role owner`, `pnpm carbbook import-usda <dirs…>`) and its test fixtures in `server/test/fixtures/usda/{foundation,sr_legacy,survey}`.
- `<output>` has the implicit ARIA role `status`; item carbs therefore use a labelled `<span>` so the screen's single `role="status"` message stays unambiguous in tests.
- Testing Library builds a button's accessible name from its child spans without separators (`Burritos34 g per serving`), so tests match names with a regex and check the rest with `toHaveTextContent`.
- `useLiveQuery` returns `undefined` on the first render; assertions on live values wait with `findByText`, not `findByTestId`.
- `BarcodeDetector` is not in TypeScript 7's DOM lib; `src/barcode/scanner.ts` declares the small shape it uses. ZXing is imported dynamically only when `BarcodeDetector` is missing or lacks retail formats (Safari/Firefox), and `BrowserMultiFormatReader.decodeFromConstraints(constraints, video, callback)` returns controls with `stop()` (checked in `@zxing/browser/esm/readers/BrowserCodeReader.d.ts`).
- Server contract points used by the UI (see the data plan): food carbs/fiber must be 0..100 (null from drafts means "missing"), dose settings are append-only (always save a new id), references may dangle (show "missing data"), `index.html` is `Cache-Control: no-cache` so an `autoUpdate` service worker picks up new builds on the next load.

## Decisions and open questions for the owner

1. The food editor **requires** carbs per 100 g (0–100) before saving, including Open Food Facts drafts and edited USDA foods that had none; a null value shows "Carbs missing: enter them from the label".
2. Window override is implemented by passing core `estimateDose` settings that contain only the chosen window, so core still does all ratio/correction/rounding math.
3. The 4-hour warning uses the most recent log entry with `taken_units > 0`.
4. Editing a log entry recomputes `suggested_units` with the entry's own settings version (or the version active at its time) and keeps `window_name`. "Recalculate from current meal" keeps an item's old carbs when its food/meal now has incomplete data and says so.
5. "Save as meal" from the calculator keeps the items so the same food can still be logged; it gives meal items fresh ids.
6. Sign out keeps IndexedDB (meals, foods, log and any unsynced changes). With pending changes, the first tap explains that they stay on the device and sync after the next sign-in.
7. Camera scanning can only be checked by hand (Task 13 Step 4): Android Chrome uses `BarcodeDetector`, iPhone Safari uses ZXing. A typed barcode is always available in the scan dialog.
8. The search index is rebuilt whenever saved data changes (it includes ~13.7k USDA names). If that is slow on the phone, split the USDA part into its own memo — not done here to keep it simple.

---

## File structure

```
web/index.html                       app shell HTML (manifest + SW script injected at build)
web/public/icon.svg                  favicon
web/public/icon-192.png, icon-512.png, apple-touch-icon.png   generated by scripts/make-icons.mjs
web/scripts/make-icons.mjs           dependency-free PNG icon generator
web/vite.config.ts                   + VitePWA (manifest, generateSW precache, navigate fallback)
web/playwright.config.ts             Pixel 7 Chromium, webServer = build + e2e/start-server.mjs
web/e2e/start-server.mjs             temp DB, owner user, USDA fixtures, carbs-server on :3998
web/e2e/carbbook.spec.ts             login → search → units → log → save/edit meal → offline log → reconnect → server state
web/src/main.tsx                     createRoot(<App db api/>)
web/src/App.tsx                      boot (device id + session), SyncEngine lifecycle, login gate, Services
web/src/styles.css                   mobile-first styles
web/src/app/services.tsx             Services context
web/src/app/hooks.ts                 live queries (catalog, dose versions, log, search index), USDA picks, BG status, clock
web/src/app/Login.tsx                sign-in form
web/src/app/Shell.tsx                top bar sync badge, routes, bottom tab bar
web/src/barcode/scanner.ts           startScanner (BarcodeDetector or ZXing), isBarcodeCode
web/src/ui/format.ts                 unit labels, carbs/units, local days, datetime-local, number parsing
web/src/ui/UnitPicker.tsx            unit <select> from core units
web/src/ui/ItemEditor.tsx            draft item rows: amount, unit, live carbs, flags, reorder/remove
web/src/ui/SearchPanel.tsx           recents + ranked results
web/src/ui/DoseCard.tsx              estimate + breakdown, refusal messages, 4-hour warning
web/src/ui/BgField.tsx               Dexcom prefill or manual entry with reason
web/src/ui/ScannerDialog.tsx         camera preview + typed code
web/src/dose/dose.ts                 REFUSAL_MESSAGES, settingsForWindow, estimateFor, validateDoseSettings
web/src/foods/label.ts               carbsPer100gFromLabel, FoodPrefill, prefillFromDraft
web/src/foods/FoodEditor.tsx         create/edit food + portions; USDA edit → custom copy
web/src/meals/saveMeal.ts            saveMeal, withDraftMeal
web/src/meals/MealEditor.tsx         meal editor with components and cycle check
web/src/log/LogEntryEditor.tsx       edit entry, recalculate, delete
web/src/settings/DoseSettingsEditor.tsx   new dose-settings version editor
web/src/screens/Calculator.tsx, Foods.tsx, Meals.tsx, Log.tsx, Settings.tsx
web/test/render.tsx                  makeServices, renderWith, seed settings, users
web/test/*.test.ts(x)                one file per task
.gitignore                           + Playwright output folders
```

---

### Task 1: Services, hooks, formatting and the scanner module

**Files:**
- Create: `web/src/app/services.tsx`, `web/src/app/hooks.ts`, `web/src/ui/format.ts`, `web/src/barcode/scanner.ts`, `web/test/render.tsx`
- Test: `web/test/format.test.ts`

- [ ] **Step 1: Write the failing test**

`web/test/format.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isBarcodeCode } from '../src/barcode/scanner';
import {
  dayKey,
  dayRange,
  formatAge,
  formatCarbs,
  formatUnits,
  fromDateTimeLocal,
  parseNonNegative,
  shiftDay,
  toDateTimeLocal,
  unitLabel,
} from '../src/ui/format';

describe('format helpers', () => {
  it('labels core unit ids', () => {
    const portions = [
      { id: 'p1', food_id: 'f', label: 'slice', kind: 'count' as const, quantity: 1, grams: 30 },
      { id: 'p2', food_id: 'f', label: 'cookies', kind: 'serving' as const, quantity: 2, grams: 28 },
    ];
    expect(unitLabel('p:p1', portions)).toBe('slice (30 g)');
    expect(unitLabel('p:p2', portions)).toBe('cookies (14 g)');
    expect(unitLabel('p:gone', portions)).toBe('unknown portion');
    expect(unitLabel('floz', [])).toBe('fl oz');
    expect(unitLabel('serving', [])).toBe('servings');
  });

  it('formats numbers and ages', () => {
    expect(formatCarbs(35.68)).toBe('35.7 g');
    expect(formatCarbs(72)).toBe('72 g');
    expect(formatUnits(4.5)).toBe('4.5 u');
    expect(formatAge(30_000)).toBe('just now');
    expect(formatAge(6 * 60_000)).toBe('6 min ago');
  });

  it('handles local days and datetime-local values', () => {
    const t = new Date(2026, 8, 14, 7, 5).getTime();
    expect(dayKey(t)).toBe('2026-09-14');
    expect(dayRange('2026-09-14')).toEqual([new Date(2026, 8, 14).getTime(), new Date(2026, 8, 15).getTime()]);
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(toDateTimeLocal(t)).toBe('2026-09-14T07:05');
    expect(fromDateTimeLocal('2026-09-14T07:05')).toBe(t);
    expect(fromDateTimeLocal('')).toBeNull();
  });

  it('parses non-negative numbers', () => {
    expect(parseNonNegative(' 12.5 ')).toBe(12.5);
    expect(parseNonNegative('0')).toBe(0);
    expect(parseNonNegative('')).toBeNull();
    expect(parseNonNegative('-1')).toBeNull();
    expect(parseNonNegative('abc')).toBeNull();
  });

  it('accepts only the barcode codes the server looks up', () => {
    expect(isBarcodeCode('0737628064502')).toBe(true);
    expect(isBarcodeCode('12345')).toBe(false);
    expect(isBarcodeCode('https://example.com')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/format.test.ts`
Expected: FAIL — `Error: Failed to resolve import "../src/barcode/scanner" from "test/format.test.ts". Does the file exist?`

- [ ] **Step 3: Implement the formatting helpers**

`web/src/ui/format.ts`:
```ts
import { PORTION_PREFIX, type PortionData } from '@carbbook/core';

const UNIT_NAMES: Record<string, string> = {
  g: 'g',
  kg: 'kg',
  oz: 'oz',
  lb: 'lb',
  ml: 'ml',
  l: 'l',
  tsp: 'tsp',
  tbsp: 'tbsp',
  floz: 'fl oz',
  cup: 'cup',
  serving: 'servings',
};

const trim = (n: number, digits: number) => String(Number(n.toFixed(digits)));

/** Display name for a unit id from core's foodUnits/mealUnits (`p:<portion id>` → "slice (30 g)"). */
export function unitLabel(unit: string, portions: PortionData[]): string {
  if (unit.startsWith(PORTION_PREFIX)) {
    const portion = portions.find((p) => p.id === unit.slice(PORTION_PREFIX.length));
    return portion ? `${portion.label} (${trim(portion.grams / portion.quantity, 1)} g)` : 'unknown portion';
  }
  return UNIT_NAMES[unit] ?? unit;
}

export const formatCarbs = (grams: number): string => `${trim(grams, 1)} g`;

export const formatUnits = (units: number): string => `${trim(units, 2)} u`;

const pad = (n: number) => String(n).padStart(2, '0');

/** Local "HH:MM". */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local "YYYY-MM-DD". */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** [start, end) of a local day in ms. */
export function dayRange(key: string): [number, number] {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

export function shiftDay(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return dayKey(new Date(y, m - 1, d + days).getTime());
}

/** Value for `<input type="datetime-local">`. */
export function toDateTimeLocal(ms: number): string {
  const d = new Date(ms);
  return `${dayKey(ms)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parses a `datetime-local` value as local time; null when empty or invalid. */
export function fromDateTimeLocal(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  return new Date(y, mo - 1, d, h, mi).getTime();
}

export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? 'just now' : `${minutes} min ago`;
}

/** A non-negative finite number from a text field, or null. */
export function parseNonNegative(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
```

- [ ] **Step 4: Implement the scanner module**

`web/src/barcode/scanner.ts`:
```ts
export interface ScanSession {
  stop(): void;
}

/** Starts the camera in `video` and calls `onCode` for each retail barcode seen. */
export type StartScanner = (video: HTMLVideoElement, onCode: (code: string) => void) => Promise<ScanSession>;

/** Shape of the Barcode Detection API (not in TypeScript's DOM lib). */
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorClass {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

export const RETAIL_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
const CAMERA: MediaStreamConstraints = { video: { facingMode: 'environment' }, audio: false };

/** Codes the server accepts at /api/barcode/:code. */
export const isBarcodeCode = (text: string): boolean => /^\d{6,14}$/.test(text);

async function startNative(Detector: BarcodeDetectorClass, formats: string[], video: HTMLVideoElement, onCode: (code: string) => void): Promise<ScanSession> {
  const stream = await navigator.mediaDevices.getUserMedia(CAMERA);
  video.srcObject = stream;
  await video.play();
  const detector = new Detector({ formats });
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const code = (await detector.detect(video)).map((b) => b.rawValue).find(isBarcodeCode);
      if (code) onCode(code);
    } catch {
      // The video frame was not ready yet; try the next tick.
    }
    if (!stopped) setTimeout(() => void tick(), 250);
  };
  void tick();
  return {
    stop() {
      stopped = true;
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    },
  };
}

async function startZxing(video: HTMLVideoElement, onCode: (code: string) => void): Promise<ScanSession> {
  // Loaded only when BarcodeDetector is missing (Safari, Firefox), keeping it out of the main bundle.
  const { BrowserMultiFormatReader } = await import('@zxing/browser');
  const controls = await new BrowserMultiFormatReader().decodeFromConstraints(CAMERA, video, (result) => {
    const text = result?.getText();
    if (text && isBarcodeCode(text)) onCode(text);
  });
  return { stop: () => controls.stop() };
}

/** BarcodeDetector where it supports retail formats (spec §8), ZXing otherwise. */
export const startScanner: StartScanner = async (video, onCode) => {
  const Detector = (globalThis as { BarcodeDetector?: BarcodeDetectorClass }).BarcodeDetector;
  if (Detector) {
    const formats = (await Detector.getSupportedFormats()).filter((f) => RETAIL_FORMATS.includes(f));
    if (formats.length > 0) return startNative(Detector, formats, video, onCode);
  }
  return startZxing(video, onCode);
};
```

- [ ] **Step 5: Implement the services context and hooks**

`web/src/app/services.tsx`:
```tsx
import { createContext, type ReactNode, useContext } from 'react';
import type { StartScanner } from '../barcode/scanner';
import type { CarbBookDb } from '../db/db';
import type { Store } from '../db/store';
import type { Api } from '../lib/api';
import type { User } from '../lib/wire';
import type { SyncEngine } from '../sync/engine';

/** Everything a signed-in screen needs; tests pass fakes. */
export interface Services {
  db: CarbBookDb;
  api: Api;
  store: Store;
  engine: SyncEngine;
  user: User;
  now: () => number;
  startScanner: StartScanner;
  /** Signs out (Settings); App swaps to the login screen. */
  signOut: () => Promise<void>;
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices must be used inside <ServicesProvider>');
  return services;
}
```

`web/src/app/hooks.ts`:
```ts
import type { DoseSettingsData, LogEntryData, LogItemData, Synced } from '@carbbook/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type BgResult, fetchBg } from '../bg/bg';
import { type CatalogData, loadCatalogData, loadUsdaFood, type UsdaFoodEntry } from '../db/catalog';
import { isLive } from '../db/db';
import { buildSearchIndex, lastLoggedByRef, type SearchIndex } from '../search/search';
import { useServices } from './services';

export function useCatalogData(): CatalogData | undefined {
  const { db } = useServices();
  return useLiveQuery(() => loadCatalogData(db), [db]);
}

export function useDoseVersions(): Synced<DoseSettingsData>[] | undefined {
  const { db } = useServices();
  return useLiveQuery(() => db.dose_settings.filter(isLive).toArray(), [db]);
}

export function useLogData(): { entries: Synced<LogEntryData>[]; items: Synced<LogItemData>[] } | undefined {
  const { db } = useServices();
  return useLiveQuery(async () => {
    const [entries, items] = await Promise.all([db.log_entry.filter(isLive).toArray(), db.log_item.filter(isLive).toArray()]);
    return { entries, items };
  }, [db]);
}

/** Most recent eaten_at of a logged entry with a taken dose (spec §4.3 step 6 warning). */
export function lastDoseAt(entries: Synced<LogEntryData>[]): number | null {
  let last: number | null = null;
  for (const entry of entries) {
    if (entry.deleted === 0 && entry.taken_units != null && entry.taken_units > 0 && (last === null || entry.eaten_at > last)) {
      last = entry.eaten_at;
    }
  }
  return last;
}

export function useSearchIndex(): SearchIndex | undefined {
  const { db } = useServices();
  const usdaFoods = useLiveQuery(() => db.usda_food.toArray(), [db]);
  const saved = useLiveQuery(async () => {
    const [foods, meals, entries, items] = await Promise.all([
      db.food.toArray(),
      db.meal.toArray(),
      db.log_entry.toArray(),
      db.log_item.toArray(),
    ]);
    return { foods, meals, entries, items };
  }, [db]);
  return useMemo(
    () =>
      usdaFoods && saved
        ? buildSearchIndex({ foods: saved.foods, meals: saved.meals, usdaFoods, lastLogged: lastLoggedByRef(saved.entries, saved.items) })
        : undefined,
    [usdaFoods, saved],
  );
}

/** USDA library foods picked into a draft (calculator or meal) but not saved yet. */
export function useUsdaPicks(): { entries: UsdaFoodEntry[]; add: (fdcId: number) => Promise<UsdaFoodEntry | null> } {
  const { db } = useServices();
  const [entries, setEntries] = useState<UsdaFoodEntry[]>([]);
  const add = useCallback(
    async (fdcId: number) => {
      const entry = await loadUsdaFood(db, fdcId);
      if (entry) setEntries((current) => (current.some((e) => e.food.id === entry.food.id) ? current : [...current, entry]));
      return entry;
    },
    [db],
  );
  return { entries, add };
}

/** services.now(), refreshed every `intervalMs` so ages and warnings stay current. */
export function useNow(intervalMs = 30_000): number {
  const { now } = useServices();
  const [value, setValue] = useState(now);
  useEffect(() => {
    const handle = setInterval(() => setValue(now()), intervalMs);
    return () => clearInterval(handle);
  }, [now, intervalMs]);
  return value;
}

export const BG_REFRESH_MS = 5 * 60_000;

/** Latest `/api/bg` result; refetched every 5 minutes and when the browser comes back online. */
export function useBgStatus(): BgResult | null {
  const { api, now } = useServices();
  const [result, setResult] = useState<BgResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetchBg(api, now).then((next) => {
        if (!cancelled) setResult(next);
      });
    };
    load();
    const handle = setInterval(load, BG_REFRESH_MS);
    window.addEventListener('online', load);
    return () => {
      cancelled = true;
      clearInterval(handle);
      window.removeEventListener('online', load);
    };
  }, [api, now]);
  return result;
}
```

- [ ] **Step 6: Add the render helper used by later UI tests**

`web/test/render.tsx`:
```tsx
import type { DoseSettingsData } from '@carbbook/core';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { type Services, ServicesProvider } from '../src/app/services';
import type { StartScanner } from '../src/barcode/scanner';
import type { CarbBookDb } from '../src/db/db';
import { createStore } from '../src/db/store';
import type { User } from '../src/lib/wire';
import { SyncEngine } from '../src/sync/engine';
import { FakeApi, openTestDb, synced } from './helpers';
import { FakeEvents, ManualTimers } from './timers';

/** Local noon on 2026-09-14 (Lunch window, ratio 1:8). */
export const NOW = new Date(2026, 8, 14, 12, 0).getTime();

export const OWNER: User = { id: 1, username: 'brett', role: 'owner' };
export const VIEWER: User = { id: 2, username: 'kim', role: 'viewer' };

export const SEED_SETTINGS: DoseSettingsData = {
  id: 'dose-2026-08-12',
  effective_from: new Date(2026, 7, 12).getTime(),
  windows: [
    { name: 'Breakfast', start: '05:00', ratio_g_per_unit: 8 },
    { name: 'AM Snack', start: '09:00', ratio_g_per_unit: 10 },
    { name: 'Lunch', start: '11:00', ratio_g_per_unit: 8 },
    { name: 'PM Snack', start: '14:00', ratio_g_per_unit: 10 },
    { name: 'Dinner', start: '16:30', ratio_g_per_unit: 8 },
    { name: 'HS Snack', start: '19:30', ratio_g_per_unit: 12 },
  ],
  correction: { threshold: 200, step: 50, units_per_step: 1, mode: 'started' },
  rounding: { increment: 1, round_down_below_bg: 130 },
};

export async function seedSettings(db: CarbBookDb): Promise<void> {
  await db.dose_settings.put(synced(SEED_SETTINGS, { server_seq: 3 }));
}

export const noScanner: StartScanner = () => Promise.reject(new Error('camera not available in tests'));

export interface TestServices extends Services {
  api: FakeApi;
  signOuts: number;
}

export function makeServices(overrides: Partial<Omit<TestServices, 'signOuts'>> = {}): TestServices {
  const db = overrides.db ?? openTestDb();
  const api = overrides.api ?? new FakeApi();
  const now = overrides.now ?? (() => NOW);
  const engine =
    overrides.engine ??
    new SyncEngine({ run: async () => {}, isOnline: () => true, events: new FakeEvents(), timers: new ManualTimers(), now });
  const services: TestServices = {
    db,
    api,
    now,
    engine,
    store: overrides.store ?? createStore(db, 'device-test', { now }),
    user: overrides.user ?? OWNER,
    startScanner: overrides.startScanner ?? noScanner,
    signOuts: 0,
    signOut: async () => {
      services.signOuts++;
    },
  };
  return services;
}

export function renderWith(ui: ReactElement, services: Services) {
  return render(<ServicesProvider services={services}>{ui}</ServicesProvider>);
}
```

- [ ] **Step 7: Run the test and typecheck**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/format.test.ts && pnpm typecheck`
Expected: `Tests  5 passed (5)`, then `tsc` exits 0.

- [ ] **Step 8: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/app/services.tsx web/src/app/hooks.ts web/src/ui/format.ts web/src/barcode/scanner.ts web/test/render.tsx web/test/format.test.ts
git commit -m "feat(web): services context, live-query hooks, formatting and scanner module"
```

---

### Task 2: Item rows, unit picker and search panel

**Files:**
- Create: `web/src/ui/UnitPicker.tsx`, `web/src/ui/ItemEditor.tsx`, `web/src/ui/SearchPanel.tsx`
- Test: `web/test/components.test.tsx`

- [ ] **Step 1: Write the failing test**

`web/test/components.test.tsx`:
```tsx
import { createCatalog, type LogEntryData, type LogItemData } from '@carbbook/core';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { type DraftItem, ItemEditor, newDraftItem } from '../src/ui/ItemEditor';
import { SearchPanel } from '../src/ui/SearchPanel';
import { foodData, mealData, mealItemData, portionData, synced } from './helpers';
import { makeServices, renderWith, type TestServices } from './render';

const catalog = createCatalog({
  foods: [foodData({ id: 'bread', name: 'Bread', carbs_per_100g: 50 }), foodData({ id: 'mystery', name: 'Mystery', carbs_per_100g: null })],
  portions: [portionData({ id: 'slice', food_id: 'bread', label: 'slice', kind: 'count', quantity: 1, grams: 30 })],
  meals: [mealData({ id: 'toast', name: 'Toast', yield_servings: 2 })],
  meal_items: [mealItemData({ id: 't1', meal_id: 'toast', ref_id: 'bread', amount: 2, unit: 'p:slice' })],
});

function Harness(props: { initial: DraftItem[]; reorderable?: boolean }) {
  const [items, setItems] = useState(props.initial);
  return (
    <>
      <ItemEditor items={items} catalog={catalog} onChange={setItems} reorderable={props.reorderable} />
      <p data-testid="order">{items.map((i) => i.ref_id).join(',')}</p>
    </>
  );
}

describe('ItemEditor', () => {
  it('defaults foods to their first count portion and meals to servings', () => {
    expect(newDraftItem(catalog, 'food', 'bread', 'k1')).toEqual({ key: 'k1', ref_type: 'food', ref_id: 'bread', amount: '1', unit: 'p:slice' });
    expect(newDraftItem(catalog, 'food', 'mystery', 'k2')).toMatchObject({ amount: '100', unit: 'g' });
    expect(newDraftItem(catalog, 'meal', 'toast', 'k3')).toMatchObject({ amount: '1', unit: 'serving' });
  });

  it('offers only valid units and shows live carbs from core', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[newDraftItem(catalog, 'food', 'bread', 'k1')]} />);
    const unit = screen.getByLabelText('Unit for Bread') as HTMLSelectElement;
    expect([...unit.options].map((o) => o.textContent)).toEqual(['g', 'kg', 'oz', 'lb', 'slice (30 g)']);
    expect(screen.getByLabelText('Carbs in Bread')).toHaveTextContent('15 g');
    const amount = screen.getByLabelText('Amount of Bread');
    await user.clear(amount);
    await user.type(amount, '3');
    expect(screen.getByLabelText('Carbs in Bread')).toHaveTextContent('45 g');
    await user.selectOptions(unit, 'g');
    expect(screen.getByLabelText('Carbs in Bread')).toHaveTextContent('1.5 g');
  });

  it('flags missing amounts, missing carb data and references that have not synced yet', () => {
    render(
      <Harness
        initial={[
          { key: 'a', ref_type: 'food', ref_id: 'bread', amount: '', unit: 'g' },
          { key: 'b', ref_type: 'food', ref_id: 'mystery', amount: '1', unit: 'g' },
          { key: 'c', ref_type: 'meal', ref_id: 'not-synced-yet', amount: '1', unit: 'serving' },
        ]}
      />,
    );
    expect(screen.getByText('enter an amount')).toBeInTheDocument();
    expect(screen.getAllByText('missing data')).toHaveLength(2);
    expect(screen.getByLabelText('Carbs in (missing item)')).toHaveTextContent('—');
  });

  it('reorders and removes items', async () => {
    const user = userEvent.setup();
    render(<Harness reorderable initial={[newDraftItem(catalog, 'food', 'bread', 'a'), newDraftItem(catalog, 'meal', 'toast', 'b')]} />);
    await user.click(screen.getByRole('button', { name: 'Move Toast up' }));
    expect(screen.getByTestId('order')).toHaveTextContent('toast,bread');
    await user.click(screen.getByRole('button', { name: 'Remove Bread' }));
    expect(screen.getByTestId('order')).toHaveTextContent('toast');
  });
});

describe('SearchPanel', () => {
  let services: TestServices;
  afterEach(async () => {
    await services.db.delete();
  });

  it('shows recent items before typing, then ranked results, and reports the pick', async () => {
    services = makeServices();
    await services.db.food.bulkPut([
      synced(foodData({ id: 'bread', name: 'Bread', carbs_per_100g: 50 })),
      synced(foodData({ id: 'brie', name: 'Brie', source: 'off', brand: 'Président', carbs_per_100g: 0.5 })),
    ]);
    await services.db.usda_food.put({ fdc_id: 1, name: 'Bread, wheat', carbs_per_100g: 43, fiber_per_100g: 6 });
    await services.db.log_entry.put(
      synced<LogEntryData>({ id: 'e1', eaten_at: 1, window_name: null, bg_mgdl: null, bg_source: 'none', total_carbs_g: 1, suggested_units: null, taken_units: null, settings_version_id: null }),
    );
    await services.db.log_item.put(
      synced<LogItemData>({ id: 'i1', log_entry_id: 'e1', ref_type: 'food', ref_id: 'brie', display_name: 'Brie', amount: 1, unit: 'g', carbs_g: 0 }),
    );
    const picks: string[] = [];
    const user = userEvent.setup();
    renderWith(<SearchPanel onPick={(result) => picks.push(result.id)} />, services);

    expect(await screen.findByRole('heading', { name: 'Recent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Brie/ })).toHaveTextContent('Président · Open Food Facts · 0.5 g carbs / 100 g');
    await user.type(screen.getByLabelText('Search foods and meals'), 'bre');
    const results = within(screen.getByRole('list', { name: 'Search results' })).getAllByRole('button');
    expect(results.map((b) => b.querySelector('.result-name')?.textContent)).toEqual(['Bread', 'Bread, wheat']);
    await user.click(results[1]!);
    expect(picks).toEqual(['usda-1']);
    expect(screen.getByLabelText('Search foods and meals')).toHaveValue('');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/components.test.tsx`
Expected: FAIL — `Error: Failed to resolve import "../src/ui/ItemEditor" from "test/components.test.tsx". Does the file exist?`

- [ ] **Step 3: Implement the unit picker**

`web/src/ui/UnitPicker.tsx`:
```tsx
import type { PortionData } from '@carbbook/core';
import { unitLabel } from './format';

export function UnitPicker(props: {
  label: string;
  units: string[];
  portions: PortionData[];
  value: string;
  onChange: (unit: string) => void;
}) {
  const units = props.units.includes(props.value) ? props.units : [props.value, ...props.units];
  return (
    <select aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      {units.map((unit) => (
        <option key={unit} value={unit}>
          {props.units.includes(unit) ? unitLabel(unit, props.portions) : `${unitLabel(unit, props.portions)} (not valid)`}
        </option>
      ))}
    </select>
  );
}
```

- [ ] **Step 4: Implement the item rows**

`web/src/ui/ItemEditor.tsx`:
```tsx
import {
  type Catalog,
  type CarbResult,
  foodUnits,
  itemCarbs,
  mealUnits,
  PORTION_PREFIX,
  type RefType,
} from '@carbbook/core';
import { formatCarbs, parseNonNegative } from './format';
import { UnitPicker } from './UnitPicker';

/** An item being edited: amount is the raw text so half-typed numbers survive. */
export interface DraftItem {
  key: string;
  ref_type: RefType;
  ref_id: string;
  amount: string;
  unit: string;
}

export function itemName(catalog: Catalog, refType: RefType, refId: string): string {
  const name = refType === 'food' ? catalog.food(refId)?.name : catalog.meal(refId)?.name;
  // The server does not enforce references: a synced item can point at a row that has not arrived.
  return name ?? '(missing item)';
}

export function unitsFor(catalog: Catalog, refType: RefType, refId: string): string[] {
  if (refType === 'meal') {
    const meal = catalog.meal(refId);
    return meal ? mealUnits(meal) : [];
  }
  const food = catalog.food(refId);
  return food ? foodUnits(food, catalog.portions(refId)) : [];
}

/** Carbs for a draft item via core; a missing or invalid amount counts as incomplete. */
export function draftItemCarbs(catalog: Catalog, item: DraftItem): CarbResult {
  const amount = parseNonNegative(item.amount);
  return amount === null ? { carbs_g: 0, complete: false } : itemCarbs(catalog, item.ref_type, item.ref_id, amount, item.unit);
}

/** Meals default to 1 serving; foods to their first count/serving portion, else 100 g. */
export function newDraftItem(catalog: Catalog, refType: RefType, refId: string, key: string): DraftItem {
  if (refType === 'meal') return { key, ref_type: refType, ref_id: refId, amount: '1', unit: 'serving' };
  const portionUnit = unitsFor(catalog, 'food', refId).find((u) => u.startsWith(PORTION_PREFIX));
  return portionUnit
    ? { key, ref_type: refType, ref_id: refId, amount: '1', unit: portionUnit }
    : { key, ref_type: refType, ref_id: refId, amount: '100', unit: 'g' };
}

export function ItemEditor(props: {
  items: DraftItem[];
  catalog: Catalog;
  onChange: (items: DraftItem[]) => void;
  reorderable?: boolean;
}) {
  const { items, catalog, onChange } = props;
  const update = (key: string, patch: Partial<DraftItem>) =>
    onChange(items.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  const move = (index: number, delta: number) => {
    const next = [...items];
    const [moved] = next.splice(index, 1);
    next.splice(index + delta, 0, moved!);
    onChange(next);
  };

  return (
    <ul className="items" aria-label="Items">
      {items.map((item, index) => {
        const name = itemName(catalog, item.ref_type, item.ref_id);
        const result = draftItemCarbs(catalog, item);
        const amountMissing = parseNonNegative(item.amount) === null;
        return (
          <li key={item.key} className="item-row" data-testid="item-row">
            <div className="item-name">
              {name}
              {!result.complete && <span className="flag">{amountMissing ? 'enter an amount' : 'missing data'}</span>}
            </div>
            <div className="item-controls">
              <input
                aria-label={`Amount of ${name}`}
                inputMode="decimal"
                value={item.amount}
                onChange={(e) => update(item.key, { amount: e.target.value })}
              />
              <UnitPicker
                label={`Unit for ${name}`}
                units={unitsFor(catalog, item.ref_type, item.ref_id)}
                portions={item.ref_type === 'food' ? catalog.portions(item.ref_id) : []}
                value={item.unit}
                onChange={(unit) => update(item.key, { unit })}
              />
              <span className="item-carbs" aria-label={`Carbs in ${name}`}>
                {result.complete ? formatCarbs(result.carbs_g) : '—'}
              </span>
              {props.reorderable && (
                <>
                  <button type="button" aria-label={`Move ${name} up`} disabled={index === 0} onClick={() => move(index, -1)}>
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${name} down`}
                    disabled={index === items.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </button>
                </>
              )}
              <button type="button" aria-label={`Remove ${name}`} onClick={() => onChange(items.filter((i) => i.key !== item.key))}>
                ✕
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 5: Implement the search panel**

`web/src/ui/SearchPanel.tsx`:
```tsx
import { useState } from 'react';
import { useSearchIndex } from '../app/hooks';
import type { SearchResult } from '../search/search';
import { formatCarbs } from './format';

const SOURCE_LABELS = { custom: 'My food', off: 'Open Food Facts', usda: 'USDA' } as const;

function describe(result: SearchResult): string {
  if (result.kind === 'meal') return 'Meal';
  const parts = [result.brand, result.source ? SOURCE_LABELS[result.source] : null];
  parts.push(result.carbs_per_100g === null ? 'no carb data' : `${formatCarbs(result.carbs_per_100g)} carbs / 100 g`);
  return parts.filter(Boolean).join(' · ');
}

/** Unified search (spec §8): recents before typing, then ranked local results. */
export function SearchPanel(props: { onPick: (result: SearchResult) => void; onScan?: () => void; label?: string }) {
  const index = useSearchIndex();
  const [query, setQuery] = useState('');
  const typing = query.trim() !== '';
  const results = index ? (typing ? index.search(query, 25) : index.recent(8)) : [];

  return (
    <div className="search">
      <div className="search-bar">
        <input
          type="search"
          aria-label={props.label ?? 'Search foods and meals'}
          placeholder="Meals, foods, USDA…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {props.onScan && (
          <button type="button" onClick={props.onScan}>
            Scan
          </button>
        )}
      </div>
      {!typing && results.length > 0 && <h3>Recent</h3>}
      <ul className="results" aria-label="Search results">
        {results.map((result) => (
          <li key={result.id}>
            <button
              type="button"
              className="result"
              onClick={() => {
                props.onPick(result);
                setQuery('');
              }}
            >
              <span className="result-name">{result.name}</span>
              <span className="result-meta">{describe(result)}</span>
            </button>
          </li>
        ))}
      </ul>
      {typing && index && results.length === 0 && <p className="muted">No matches.</p>}
    </div>
  );
}
```

- [ ] **Step 6: Run the test and typecheck**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/components.test.tsx && pnpm typecheck`
Expected: `Tests  5 passed (5)`, then `tsc` exits 0.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/ui/UnitPicker.tsx web/src/ui/ItemEditor.tsx web/src/ui/SearchPanel.tsx web/test/components.test.tsx
git commit -m "feat(web): item rows with core units and carbs, unified search panel"
```

---

### Task 3: Dose display and BG entry

**Files:**
- Create: `web/src/dose/dose.ts`, `web/src/ui/DoseCard.tsx`, `web/src/ui/BgField.tsx`
- Test: `web/test/dose.test.tsx`

- [ ] **Step 1: Write the failing test**

`web/test/dose.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { estimateFor, REFUSAL_MESSAGES, type RefusalReason, validateDoseSettings } from '../src/dose/dose';
import { BgField, resolveBg } from '../src/ui/BgField';
import { DoseCard } from '../src/ui/DoseCard';
import { NOW, SEED_SETTINGS } from './render';

const carbs72 = { carbs_g: 72, complete: true };
const noop = () => {};

describe('estimateFor', () => {
  it('uses core window selection unless the user picks a window', () => {
    const auto = estimateFor({ settings: SEED_SETTINGS, windowName: null, eatenAt: NOW, carbs: carbs72, bg: 263 });
    expect(auto).toMatchObject({ ok: true, window: { name: 'Lunch' }, units: 11 });
    const chosen = estimateFor({ settings: SEED_SETTINGS, windowName: 'HS Snack', eatenAt: NOW, carbs: carbs72, bg: 263 });
    expect(chosen).toMatchObject({ ok: true, window: { name: 'HS Snack' }, meal_units: 6, units: 8 });
    expect(estimateFor({ settings: SEED_SETTINGS, windowName: 'Brunch', eatenAt: NOW, carbs: carbs72, bg: null })).toMatchObject({
      window: { name: 'Lunch' },
    });
  });

  it('has a message for every core refusal reason', () => {
    expect(Object.keys(REFUSAL_MESSAGES).sort()).toEqual(['incomplete_carbs', 'invalid_input', 'invalid_ratio', 'invalid_settings', 'no_window']);
    expect(estimateFor({ settings: SEED_SETTINGS, windowName: null, eatenAt: Number.NaN, carbs: carbs72, bg: null })).toMatchObject({
      ok: false,
      reason: 'invalid_input',
    });
  });
});

describe('validateDoseSettings', () => {
  it('accepts the seed settings', () => {
    expect(validateDoseSettings(SEED_SETTINGS)).toEqual([]);
  });

  it('reports missing windows, names, ratios and invalid rules', () => {
    expect(validateDoseSettings({ ...SEED_SETTINGS, windows: [] })).toContain('Add at least one time window.');
    const windows = SEED_SETTINGS.windows.map((w) => (w.name === 'Lunch' ? { ...w, ratio_g_per_unit: 0 } : w));
    expect(validateDoseSettings({ ...SEED_SETTINGS, windows })).toEqual(['Lunch: carb ratio must be greater than 0.']);
    expect(validateDoseSettings({ ...SEED_SETTINGS, windows: [{ name: ' ', start: '05:00', ratio_g_per_unit: 8 }] })).toEqual([
      'Every time window needs a name.',
    ]);
    const generic = 'Check window start times (HH:MM, no duplicates), correction step (> 0), units per step (0 or more) and rounding increment (> 0).';
    expect(validateDoseSettings({ ...SEED_SETTINGS, correction: { ...SEED_SETTINGS.correction, step: 0 } })).toEqual([generic]);
    const duplicate = [SEED_SETTINGS.windows[0]!, { ...SEED_SETTINGS.windows[1]!, start: '05:00' }];
    expect(validateDoseSettings({ ...SEED_SETTINGS, windows: duplicate })).toEqual([generic]);
  });
});

describe('DoseCard', () => {
  it('labels the dose an estimate and always shows the breakdown', () => {
    const estimate = estimateFor({ settings: SEED_SETTINGS, windowName: null, eatenAt: NOW, carbs: carbs72, bg: null });
    render(<DoseCard estimate={estimate} hasItems bg={null} lastDoseAt={null} now={NOW} />);
    expect(screen.getByTestId('dose-units')).toHaveTextContent('9 u');
    expect(screen.getByText('estimate')).toBeInTheDocument();
    expect(screen.getByTestId('dose-breakdown')).toHaveTextContent('72g ÷ 8 = 9.0 → 9u');
    expect(screen.getByText('No BG entered: correction not included.')).toBeInTheDocument();
  });

  it.each(Object.entries(REFUSAL_MESSAGES))('shows %s as a message and never a number', (reason, message) => {
    render(<DoseCard estimate={{ ok: false, reason: reason as RefusalReason, window: null }} hasItems bg={null} lastDoseAt={null} now={NOW} />);
    expect(screen.getByTestId('dose-refusal')).toHaveTextContent(message);
    expect(screen.queryByTestId('dose-units')).toBeNull();
    expect(screen.queryByTestId('dose-breakdown')).toBeNull();
  });

  it('explains missing settings and warns about a recent dose', () => {
    render(<DoseCard estimate={null} hasItems bg={null} lastDoseAt={NOW - 3 * 3_600_000} now={NOW} />);
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual([
      'No dose estimate: no dose settings apply at this time. Sync, or add settings in Settings.',
      'A dose was logged at 09:00, within the last 4 hours. This estimate does not subtract insulin on board.',
    ]);
  });
});

describe('BG entry', () => {
  const prefill = { mgdl: 180, trend: 'Flat', arrow: '→', age_ms: 4 * 60_000 };

  it('uses the Dexcom prefill until the user switches to manual entry', () => {
    expect(resolveBg(prefill, false, '')).toEqual({ mgdl: 180, source: 'dexcom', trend: 'Flat' });
    expect(resolveBg(prefill, true, '140')).toEqual({ mgdl: 140, source: 'manual', trend: null });
    expect(resolveBg(null, false, '')).toEqual({ mgdl: null, source: 'none', trend: null });
    expect(resolveBg(null, false, 'abc')).toEqual({ mgdl: null, source: 'none', trend: null });
  });

  it('asks for manual entry and says why', () => {
    const props = { manualMode: false, manualText: '', onManualModeChange: noop, onManualTextChange: noop };
    const { rerender } = render(<BgField status={{ kind: 'offline' }} prefill={null} {...props} />);
    expect(screen.getByText('Offline: enter BG manually.')).toBeInTheDocument();
    rerender(<BgField status={{ kind: 'unavailable', message: 'dexcom-api responded 500' }} prefill={null} {...props} />);
    expect(screen.getByText('Dexcom unavailable (dexcom-api responded 500): enter BG manually.')).toBeInTheDocument();
    rerender(<BgField status={null} prefill={prefill} {...props} />);
    expect(screen.getByTestId('bg-reading')).toHaveTextContent('BG 180 → · 4 min ago (Dexcom)');
    expect(screen.queryByLabelText('BG (mg/dL)')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/dose.test.tsx`
Expected: FAIL — `Error: Failed to resolve import "../src/dose/dose" from "test/dose.test.tsx". Does the file exist?`

- [ ] **Step 3: Implement the dose helpers (core does the math)**

`web/src/dose/dose.ts`:
```ts
import {
  type CarbResult,
  type DoseEstimate,
  type DoseSettingsData,
  estimateDose,
  minutesOfDay,
  parseHHMM,
} from '@carbbook/core';

export type RefusalReason = Extract<DoseEstimate, { ok: false }>['reason'];

/** Why core refused to estimate (spec §9) — shown instead of any number. */
export const REFUSAL_MESSAGES: Record<RefusalReason, string> = {
  incomplete_carbs: 'No dose estimate: an item is missing carb data or an amount.',
  invalid_input: 'No dose estimate: check the time, carbs and BG values.',
  invalid_settings: 'No dose estimate: the dose settings are invalid. Fix them in Settings.',
  no_window: 'No dose estimate: the dose settings have no time windows.',
  invalid_ratio: 'No dose estimate: this time window has no valid carb ratio.',
};

/**
 * A manual window choice is passed to core as settings with only that window, so core's own
 * window pick and ratio math still run. `null` (or an unknown name) keeps the automatic window.
 */
export function settingsForWindow(settings: DoseSettingsData, windowName: string | null): DoseSettingsData {
  const chosen = windowName ? settings.windows.find((w) => w.name === windowName) : undefined;
  return chosen ? { ...settings, windows: [chosen] } : settings;
}

export function estimateFor(input: {
  settings: DoseSettingsData;
  windowName: string | null;
  eatenAt: number;
  carbs: CarbResult;
  bg: number | null;
}): DoseEstimate {
  return estimateDose({
    settings: settingsForWindow(input.settings, input.windowName),
    minutes: minutesOfDay(new Date(input.eatenAt)),
    carbs: input.carbs,
    bg: input.bg,
  });
}

/** Problems that would stop core (or the server) from using a dose-settings draft. */
export function validateDoseSettings(draft: DoseSettingsData): string[] {
  const errors: string[] = [];
  if (draft.windows.length === 0) errors.push('Add at least one time window.');
  if (draft.windows.length > 24) errors.push('Use at most 24 time windows.');
  if (draft.windows.some((w) => w.name.trim() === '')) errors.push('Every time window needs a name.');
  if (!(draft.correction.threshold >= 0)) errors.push('Correction threshold must be 0 or more.');
  if (draft.rounding.round_down_below_bg !== null && !(draft.rounding.round_down_below_bg >= 0)) {
    errors.push('Round-down BG must be empty or 0 or more.');
  }
  const probe = (minutes: number) => estimateDose({ settings: draft, minutes, carbs: { carbs_g: 0, complete: true }, bg: null });
  const first = probe(0);
  if (!first.ok && first.reason === 'invalid_settings') {
    errors.push('Check window start times (HH:MM, no duplicates), correction step (> 0), units per step (0 or more) and rounding increment (> 0).');
    return errors;
  }
  for (const window of draft.windows) {
    const result = probe(parseHHMM(window.start));
    if (!result.ok && result.reason === 'invalid_ratio') errors.push(`${window.name || 'A window'}: carb ratio must be greater than 0.`);
  }
  return errors;
}
```

- [ ] **Step 4: Implement the dose card**

`web/src/ui/DoseCard.tsx`:
```tsx
import { type DoseEstimate, formatBreakdown, recentDoseWarning } from '@carbbook/core';
import { REFUSAL_MESSAGES } from '../dose/dose';
import { formatTime, formatUnits } from './format';

/**
 * Dose display (spec §4.3 step 7, §9): always labelled an estimate with core's breakdown;
 * a refusal shows its reason and never a number.
 */
export function DoseCard(props: {
  /** null when no dose settings apply at this time. */
  estimate: DoseEstimate | null;
  hasItems: boolean;
  bg: number | null;
  lastDoseAt: number | null;
  now: number;
}) {
  const { estimate } = props;
  return (
    <section className="card dose" aria-label="Dose estimate">
      <h2>Dose estimate</h2>
      {!props.hasItems ? (
        <p className="muted">Add foods or meals to estimate a dose.</p>
      ) : estimate === null ? (
        <p role="alert">No dose estimate: no dose settings apply at this time. Sync, or add settings in Settings.</p>
      ) : estimate.ok ? (
        <>
          <p className="dose-units">
            <span data-testid="dose-units">{formatUnits(estimate.units)}</span> <span className="tag">estimate</span>
          </p>
          <p className="breakdown" data-testid="dose-breakdown">
            {formatBreakdown(estimate)}
          </p>
          {props.bg === null && <p className="note">No BG entered: correction not included.</p>}
        </>
      ) : (
        <p role="alert" data-testid="dose-refusal">
          {REFUSAL_MESSAGES[estimate.reason]}
        </p>
      )}
      {props.lastDoseAt !== null && recentDoseWarning(props.lastDoseAt, props.now) && (
        <p role="alert" className="warning">
          A dose was logged at {formatTime(props.lastDoseAt)}, within the last 4 hours. This estimate does not subtract
          insulin on board.
        </p>
      )}
      <p className="fineprint">Estimate only. Check it before dosing.</p>
    </section>
  );
}
```

- [ ] **Step 5: Implement the BG field**

`web/src/ui/BgField.tsx`:
```tsx
import type { BgSource } from '@carbbook/core';
import type { BgPrefill, BgResult } from '../bg/bg';
import { formatAge, parseNonNegative } from './format';

export interface BgEntry {
  mgdl: number | null;
  source: BgSource;
  trend: string | null;
}

/** Dexcom prefill unless the user switched to manual entry; manual text otherwise (spec §4.4). */
export function resolveBg(prefill: BgPrefill | null, manualMode: boolean, manualText: string): BgEntry {
  if (prefill && !manualMode) return { mgdl: prefill.mgdl, source: 'dexcom', trend: prefill.trend };
  const mgdl = parseNonNegative(manualText);
  return mgdl === null ? { mgdl: null, source: 'none', trend: null } : { mgdl, source: 'manual', trend: null };
}

function statusNote(status: BgResult | null): string {
  if (status === null) return 'Loading Dexcom…';
  if (status.kind === 'offline') return 'Offline: enter BG manually.';
  if (status.kind === 'unavailable') return `Dexcom unavailable (${status.message}): enter BG manually.`;
  return 'No Dexcom reading from the last 15 minutes: enter BG manually.';
}

export function BgField(props: {
  status: BgResult | null;
  prefill: BgPrefill | null;
  manualMode: boolean;
  manualText: string;
  onManualModeChange: (manual: boolean) => void;
  onManualTextChange: (text: string) => void;
}) {
  const { prefill } = props;
  if (prefill && !props.manualMode) {
    return (
      <div className="bg-field">
        <p data-testid="bg-reading">
          BG <strong>{prefill.mgdl}</strong> {prefill.arrow ?? ''} · {formatAge(prefill.age_ms)} (Dexcom)
        </p>
        <button type="button" onClick={() => props.onManualModeChange(true)}>
          Enter BG manually
        </button>
      </div>
    );
  }
  return (
    <div className="bg-field">
      <label>
        BG (mg/dL)
        <input inputMode="numeric" value={props.manualText} onChange={(e) => props.onManualTextChange(e.target.value)} />
      </label>
      {prefill ? (
        <button type="button" onClick={() => props.onManualModeChange(false)}>
          Use Dexcom {prefill.mgdl}
        </button>
      ) : (
        <p className="note">{statusNote(props.status)}</p>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run the test and typecheck**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/dose.test.tsx && pnpm typecheck`
Expected: `Tests  13 passed (13)`, then `tsc` exits 0.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/dose/dose.ts web/src/ui/DoseCard.tsx web/src/ui/BgField.tsx web/test/dose.test.tsx
git commit -m "feat(web): dose estimate card with refusal messages and BG entry"
```

---

### Task 4: Food editor

**Files:**
- Create: `web/src/foods/label.ts`, `web/src/foods/FoodEditor.tsx`
- Test: `web/test/food-editor.test.tsx`

- [ ] **Step 1: Write the failing test**

`web/test/food-editor.test.tsx`:
```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { FoodEditor } from '../src/foods/FoodEditor';
import { carbsPer100gFromLabel, type FoodPrefill, prefillFromDraft } from '../src/foods/label';
import type { FoodDraft } from '../src/lib/wire';
import { foodData, portionData, synced } from './helpers';
import { makeServices, renderWith, type TestServices } from './render';

let services: TestServices;
afterEach(async () => {
  await services?.db.delete();
});

const NOODLE_DRAFT: FoodDraft = {
  food: { name: 'Noodle kit', brand: 'Thai Kitchen', source: 'off', source_ref: '0737628064502', carbs_per_100g: null, fiber_per_100g: null },
  portions: [{ label: 'label serving', kind: 'serving', quantity: 1, grams: 52 }],
  barcode: '0737628064502',
  serving_size: '1 pouch (52 g)',
};

function renderEditor(props: { existing?: Parameters<typeof FoodEditor>[0]['existing']; prefill?: FoodPrefill } = {}) {
  const done: (string | null)[] = [];
  renderWith(<FoodEditor {...props} onDone={(id) => done.push(id)} />, services);
  return done;
}

describe('label helpers', () => {
  it('converts a label serving to carbs per 100 g', () => {
    expect(carbsPer100gFromLabel(40, 20)).toBe(50);
    expect(carbsPer100gFromLabel(30, 7)).toBe(23.33);
    expect(carbsPer100gFromLabel(0, 5)).toBeNull();
    expect(carbsPer100gFromLabel(null, 5)).toBeNull();
  });

  it('turns an Open Food Facts draft into editor prefill', () => {
    expect(prefillFromDraft(NOODLE_DRAFT)).toEqual({
      name: 'Noodle kit',
      brand: 'Thai Kitchen',
      carbs_per_100g: null,
      fiber_per_100g: null,
      source: 'off',
      source_ref: '0737628064502',
      portions: NOODLE_DRAFT.portions,
      barcode: '0737628064502',
      note: 'From Open Food Facts. Check against the label: serving size "1 pouch (52 g)".',
    });
  });
});

describe('FoodEditor', () => {
  it('creates a food from the nutrition label', async () => {
    services = makeServices();
    const user = userEvent.setup();
    const done = renderEditor();
    await user.type(screen.getByLabelText('Name'), 'Granola bar');
    await user.click(screen.getByLabelText('From label'));
    await user.type(screen.getByLabelText('Serving size (g)'), '40');
    await user.type(screen.getByLabelText('Carbs per serving (g)'), '20');
    expect(screen.getByTestId('label-result')).toHaveTextContent('= 50 g carbs per 100 g');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(done).toHaveLength(1));
    const food = await services.db.food.get(done[0]!);
    expect(food).toMatchObject({ name: 'Granola bar', source: 'custom', carbs_per_100g: 50, updated_by: 'device-test' });
    expect(await services.db.portion.toArray()).toEqual([
      expect.objectContaining({ food_id: food!.id, label: 'label serving', kind: 'serving', quantity: 1, grams: 40 }),
    ]);
  });

  it('requires carbs and keeps carbs and fiber within 0 to 100 g per 100 g', async () => {
    services = makeServices();
    const user = userEvent.setup();
    renderEditor();
    await user.type(screen.getByLabelText('Name'), 'Syrup');
    expect(screen.getByTestId('carbs-missing')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Carbs are missing: enter them from the label.');
    await user.type(screen.getByLabelText('Carbs per 100 g'), '120');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Carbs per 100 g must be a number from 0 to 100.');
    await user.clear(screen.getByLabelText('Carbs per 100 g'));
    await user.type(screen.getByLabelText('Carbs per 100 g'), '60');
    await user.type(screen.getByLabelText('Fiber per 100 g'), '150');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Fiber per 100 g must be a number from 0 to 100.');
    expect(await services.db.food.count()).toBe(0);
  });

  it('saves edits to a USDA food as a custom copy and leaves the original alone', async () => {
    services = makeServices();
    const original = synced(foodData({ id: 'usda-324860', name: 'Peanut butter, smooth style, with salt', source: 'usda', source_ref: '324860', carbs_per_100g: 22.3 }));
    const portion = synced(portionData({ id: 'usda-portion-119207', food_id: 'usda-324860', label: 'tbsp', kind: 'volume', quantity: 2, grams: 32 }));
    await services.db.food.put(original);
    await services.db.portion.put(portion);
    const user = userEvent.setup();
    const done = renderEditor({ existing: { food: original, portions: [portion] } });
    expect(screen.getByText(/saving creates your own copy/)).toBeInTheDocument();
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'My peanut butter');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(done).toHaveLength(1));
    expect(done[0]).not.toBe('usda-324860');
    expect(await services.db.food.get('usda-324860')).toEqual(original);
    expect(await services.db.food.get(done[0]!)).toMatchObject({ name: 'My peanut butter', source: 'custom', source_ref: null, derived_from: 'usda-324860' });
    const copies = await services.db.portion.where('food_id').equals(done[0]!).toArray();
    expect(copies).toEqual([expect.objectContaining({ label: 'tbsp', kind: 'volume', quantity: 2, grams: 32 })]);
    expect(copies[0]!.id).not.toBe('usda-portion-119207');
  });

  it('edits a saved food and removes a deleted portion', async () => {
    services = makeServices();
    const bread = synced(foodData({ id: 'bread', name: 'Bread', carbs_per_100g: 50 }));
    const slice = synced(portionData({ id: 'slice', food_id: 'bread', label: 'slice', grams: 30 }));
    await services.db.food.put(bread);
    await services.db.portion.put(slice);
    const user = userEvent.setup();
    const done = renderEditor({ existing: { food: bread, portions: [slice] } });
    await user.click(screen.getByRole('button', { name: 'Remove portion 1' }));
    await user.click(screen.getByRole('button', { name: 'Add portion' }));
    await user.type(screen.getByLabelText('Portion 1 label'), 'roll');
    await user.type(screen.getByLabelText('Portion 1 grams'), '60');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(done).toEqual(['bread']));
    expect(await services.db.portion.get('slice')).toMatchObject({ deleted: 1 });
    expect((await services.db.portion.where('food_id').equals('bread').toArray()).filter((p) => p.deleted === 0)).toEqual([
      expect.objectContaining({ label: 'roll', kind: 'count', quantity: 1, grams: 60 }),
    ]);
  });

  it('blocks saving an Open Food Facts draft until missing carbs are typed', async () => {
    services = makeServices();
    const user = userEvent.setup();
    const done = renderEditor({ prefill: prefillFromDraft(NOODLE_DRAFT) });
    expect(screen.getByLabelText('Name')).toHaveValue('Noodle kit');
    expect(screen.getByText(/serving size "1 pouch \(52 g\)"/)).toBeInTheDocument();
    expect(screen.getByTestId('carbs-missing')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Carbs are missing');
    expect(done).toEqual([]);

    await user.type(screen.getByLabelText('Carbs per 100 g'), '71.15');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(done).toHaveLength(1));
    expect(await services.db.food.get(done[0]!)).toMatchObject({ source: 'off', source_ref: '0737628064502', brand: 'Thai Kitchen', carbs_per_100g: 71.15 });
    expect(await services.db.barcode.toArray()).toEqual([expect.objectContaining({ code: '0737628064502', food_id: done[0] })]);
    expect(await services.db.portion.toArray()).toEqual([expect.objectContaining({ label: 'label serving', grams: 52 })]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/food-editor.test.tsx`
Expected: FAIL — `Error: Failed to resolve import "../src/foods/FoodEditor" from "test/food-editor.test.tsx". Does the file exist?`

- [ ] **Step 3: Implement the label helpers**

`web/src/foods/label.ts`:
```ts
import type { PortionKind } from '@carbbook/core';
import type { FoodDraft } from '../lib/wire';

/** Nutrition label → carbs per 100 g (spec §8 "create from label"), 2 decimals. */
export function carbsPer100gFromLabel(servingGrams: number | null, carbsPerServing: number | null): number | null {
  if (servingGrams === null || carbsPerServing === null || !(servingGrams > 0) || !(carbsPerServing >= 0)) return null;
  return Number(((carbsPerServing / servingGrams) * 100).toFixed(2));
}

/** Initial values for a new food (from a barcode draft or a typed/unknown code). */
export interface FoodPrefill {
  name?: string;
  brand?: string | null;
  carbs_per_100g?: number | null;
  fiber_per_100g?: number | null;
  source?: 'custom' | 'off';
  source_ref?: string | null;
  portions?: { label: string; kind: PortionKind; quantity: number; grams: number }[];
  barcode?: string | null;
  note?: string | null;
}

export function prefillFromDraft(draft: FoodDraft): FoodPrefill {
  return {
    name: draft.food.name,
    brand: draft.food.brand,
    carbs_per_100g: draft.food.carbs_per_100g,
    fiber_per_100g: draft.food.fiber_per_100g,
    source: 'off',
    source_ref: draft.food.source_ref,
    portions: draft.portions,
    barcode: draft.barcode,
    note: draft.serving_size
      ? `From Open Food Facts. Check against the label: serving size "${draft.serving_size}".`
      : 'From Open Food Facts. Check the values against the label.',
  };
}
```

- [ ] **Step 4: Implement the editor**

`web/src/foods/FoodEditor.tsx`:
```tsx
import { type FoodData, type PortionData, type PortionKind, type Synced, VOLUME_UNITS } from '@carbbook/core';
import { useState } from 'react';
import { useServices } from '../app/services';
import type { Change } from '../db/store';
import { uuidv7 } from '../lib/ids';
import { parseNonNegative, unitLabel } from '../ui/format';
import { carbsPer100gFromLabel, type FoodPrefill } from './label';

interface PortionDraft {
  key: string;
  id: string | null;
  label: string;
  kind: PortionKind;
  quantity: string;
  grams: string;
}

const VOLUME_LABELS = Object.keys(VOLUME_UNITS);
const LABEL_SERVING = 'label serving';
const numText = (n: number | null | undefined) => (n == null ? '' : String(n));

export function FoodEditor(props: {
  existing?: { food: Synced<FoodData>; portions: Synced<PortionData>[] };
  prefill?: FoodPrefill;
  /** Called with the saved food id, or null when cancelled or deleted. */
  onDone: (foodId: string | null) => void;
}) {
  const { store, now } = useServices();
  const base = props.existing?.food;
  const prefill = props.prefill ?? {};
  const isUsda = base?.source === 'usda';

  const [name, setName] = useState(base?.name ?? prefill.name ?? '');
  const [brand, setBrand] = useState(base?.brand ?? prefill.brand ?? '');
  const [carbsMode, setCarbsMode] = useState<'per100' | 'label'>('per100');
  const [carbsText, setCarbsText] = useState(numText(base ? base.carbs_per_100g : prefill.carbs_per_100g));
  const [servingText, setServingText] = useState('');
  const [labelCarbsText, setLabelCarbsText] = useState('');
  const [fiberText, setFiberText] = useState(numText(base ? base.fiber_per_100g : prefill.fiber_per_100g));
  const [densityText, setDensityText] = useState(numText(base?.density_g_per_ml));
  const [notes, setNotes] = useState(base?.notes ?? '');
  const [portions, setPortions] = useState<PortionDraft[]>(() =>
    (props.existing?.portions ?? prefill.portions ?? []).map((p) => ({
      key: uuidv7(),
      id: 'id' in p ? (p.id as string) : null,
      label: p.label,
      kind: p.kind,
      quantity: String(p.quantity),
      grams: String(p.grams),
    })),
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const labelPreview = carbsPer100gFromLabel(parseNonNegative(servingText), parseNonNegative(labelCarbsText));
  const updatePortion = (key: string, patch: Partial<PortionDraft>) =>
    setPortions((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  async function save() {
    const problems: string[] = [];
    if (!name.trim()) problems.push('Name is required.');
    let carbs: number | null = null;
    if (carbsMode === 'label') {
      carbs = labelPreview;
      if (carbs === null) problems.push('Enter the serving size (g) and carbs per serving from the label.');
      else if (carbs > 100) problems.push('Carbs per serving cannot be more than the serving size.');
    } else if (carbsText.trim() === '') {
      problems.push('Carbs are missing: enter them from the label.');
    } else {
      carbs = parseNonNegative(carbsText);
      if (carbs === null || carbs > 100) problems.push('Carbs per 100 g must be a number from 0 to 100.');
    }
    // The server rejects carbs/fiber outside 0..100 g per 100 g.
    const fiber = parseNonNegative(fiberText);
    if (fiberText.trim() !== '' && (fiber === null || fiber > 100)) problems.push('Fiber per 100 g must be a number from 0 to 100.');
    const density = parseNonNegative(densityText);
    if (densityText.trim() !== '' && !(density !== null && density > 0)) problems.push('Density must be greater than 0.');

    const rows = [...portions];
    const servingGrams = parseNonNegative(servingText);
    if (carbsMode === 'label' && servingGrams && !rows.some((p) => p.kind === 'serving' && p.label === LABEL_SERVING)) {
      rows.push({ key: 'label', id: null, label: LABEL_SERVING, kind: 'serving', quantity: '1', grams: String(servingGrams) });
    }
    rows.forEach((p, i) => {
      if (!p.label.trim()) problems.push(`Portion ${i + 1} needs a label.`);
      if (p.kind === 'volume' && !VOLUME_LABELS.includes(p.label)) problems.push(`Portion ${i + 1}: pick a volume unit.`);
      const quantity = parseNonNegative(p.quantity);
      const grams = parseNonNegative(p.grams);
      if (!(quantity && quantity > 0) || !(grams && grams > 0)) problems.push(`Portion ${i + 1} needs a quantity and grams above 0.`);
    });
    setErrors(problems);
    if (problems.length > 0) return;

    // Editing a USDA food makes a custom copy; the original stays untouched (spec §3).
    const keepId = base !== undefined && !isUsda;
    const foodId = keepId ? base.id : uuidv7(now());
    const food: FoodData = {
      id: foodId,
      name: name.trim(),
      brand: brand.trim() || null,
      source: keepId ? (base.source ?? 'custom') : isUsda ? 'custom' : (prefill.source ?? 'custom'),
      source_ref: keepId ? (base.source_ref ?? null) : isUsda ? null : (prefill.source_ref ?? null),
      derived_from: base && isUsda ? base.id : (base?.derived_from ?? null),
      carbs_per_100g: carbs,
      fiber_per_100g: fiber,
      density_g_per_ml: density,
      notes: notes.trim() || null,
    };
    const kept = new Set<string>();
    const changes: Change[] = [{ table: 'food', data: food }];
    for (const p of rows) {
      const id = keepId && p.id ? p.id : uuidv7(now());
      kept.add(id);
      changes.push({
        table: 'portion',
        data: { id, food_id: foodId, label: p.label.trim(), kind: p.kind, quantity: parseNonNegative(p.quantity)!, grams: parseNonNegative(p.grams)! },
      });
    }
    if (!base && prefill.barcode) changes.push({ table: 'barcode', data: { id: uuidv7(now()), code: prefill.barcode, food_id: foodId } });
    await store.saveMany(changes);
    if (keepId) {
      for (const p of props.existing!.portions) if (!kept.has(p.id)) await store.remove('portion', p.id);
    }
    props.onDone(foodId);
  }

  async function remove() {
    if (!base) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    for (const p of props.existing!.portions) await store.remove('portion', p.id);
    await store.remove('food', base.id);
    props.onDone(null);
  }

  return (
    <form
      className="screen editor"
      aria-label="Food"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h1>{base ? 'Edit food' : 'New food'}</h1>
      {isUsda && <p className="note">USDA food: saving creates your own copy. The USDA original stays unchanged.</p>}
      {prefill.note && <p className="note">{prefill.note}</p>}
      {prefill.barcode && (
        <p>
          Barcode <strong>{prefill.barcode}</strong>
        </p>
      )}
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Brand
        <input value={brand} onChange={(e) => setBrand(e.target.value)} />
      </label>
      <fieldset>
        <legend>Carbs</legend>
        <label className="inline">
          <input type="radio" name="carbs-mode" checked={carbsMode === 'per100'} onChange={() => setCarbsMode('per100')} />
          Per 100 g
        </label>
        <label className="inline">
          <input type="radio" name="carbs-mode" checked={carbsMode === 'label'} onChange={() => setCarbsMode('label')} />
          From label
        </label>
        {carbsMode === 'per100' ? (
          <>
            <label>
              Carbs per 100 g
              <input inputMode="decimal" value={carbsText} onChange={(e) => setCarbsText(e.target.value)} />
            </label>
            {carbsText.trim() === '' && (
              <p className="flag" data-testid="carbs-missing">
                Carbs missing: enter them from the label
              </p>
            )}
          </>
        ) : (
          <>
            <label>
              Serving size (g)
              <input inputMode="decimal" value={servingText} onChange={(e) => setServingText(e.target.value)} />
            </label>
            <label>
              Carbs per serving (g)
              <input inputMode="decimal" value={labelCarbsText} onChange={(e) => setLabelCarbsText(e.target.value)} />
            </label>
            <p className="note" data-testid="label-result">
              {labelPreview === null ? 'Enter both values.' : `= ${labelPreview} g carbs per 100 g`}
            </p>
          </>
        )}
      </fieldset>
      <label>
        Fiber per 100 g
        <input inputMode="decimal" value={fiberText} onChange={(e) => setFiberText(e.target.value)} />
      </label>
      <label>
        Density (g per ml)
        <input inputMode="decimal" value={densityText} onChange={(e) => setDensityText(e.target.value)} />
      </label>
      <fieldset>
        <legend>Portions</legend>
        {portions.map((p, i) => (
          <div className="portion-row" key={p.key}>
            <select
              aria-label={`Portion ${i + 1} kind`}
              value={p.kind}
              onChange={(e) => {
                const kind = e.target.value as PortionKind;
                updatePortion(p.key, { kind, label: kind === 'volume' ? 'cup' : p.kind === 'volume' ? '' : p.label });
              }}
            >
              <option value="count">count</option>
              <option value="serving">serving</option>
              <option value="volume">volume</option>
            </select>
            {p.kind === 'volume' ? (
              <select aria-label={`Portion ${i + 1} label`} value={p.label} onChange={(e) => updatePortion(p.key, { label: e.target.value })}>
                {VOLUME_LABELS.map((unit) => (
                  <option key={unit} value={unit}>
                    {unitLabel(unit, [])}
                  </option>
                ))}
              </select>
            ) : (
              <input
                aria-label={`Portion ${i + 1} label`}
                placeholder="slice"
                value={p.label}
                onChange={(e) => updatePortion(p.key, { label: e.target.value })}
              />
            )}
            <input
              aria-label={`Portion ${i + 1} quantity`}
              inputMode="decimal"
              value={p.quantity}
              onChange={(e) => updatePortion(p.key, { quantity: e.target.value })}
            />
            <input
              aria-label={`Portion ${i + 1} grams`}
              inputMode="decimal"
              value={p.grams}
              onChange={(e) => updatePortion(p.key, { grams: e.target.value })}
            />
            <button type="button" aria-label={`Remove portion ${i + 1}`} onClick={() => setPortions((rows) => rows.filter((r) => r.key !== p.key))}>
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setPortions((rows) => [...rows, { key: uuidv7(), id: null, label: '', kind: 'count', quantity: '1', grams: '' }])}
        >
          Add portion
        </button>
      </fieldset>
      <label>
        Notes
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {errors.length > 0 && (
        <ul role="alert" className="errors">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <div className="button-row">
        <button type="submit" className="primary">
          Save
        </button>
        <button type="button" onClick={() => props.onDone(null)}>
          Cancel
        </button>
        {base && (
          <button type="button" className="danger" onClick={() => void remove()}>
            {confirmDelete ? 'Tap again to delete' : 'Delete food'}
          </button>
        )}
      </div>
    </form>
  );
}
```

- [ ] **Step 5: Run the test and typecheck**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/food-editor.test.tsx && pnpm typecheck`
Expected: `Tests  7 passed (7)`, then `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/foods web/test/food-editor.test.tsx
git commit -m "feat(web): food editor with label entry, portions and USDA custom copies"
```

---

### Task 5: Foods screen with barcode scanning

**Files:**
- Create: `web/src/ui/ScannerDialog.tsx`, `web/src/screens/Foods.tsx`
- Test: `web/test/foods.test.tsx`

- [ ] **Step 1: Write the failing test**

`web/test/foods.test.tsx`:
```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { StartScanner } from '../src/barcode/scanner';
import { NetworkError } from '../src/lib/api';
import { Foods } from '../src/screens/Foods';
import { foodData, synced } from './helpers';
import { makeServices, renderWith, type TestServices } from './render';

let services: TestServices;
afterEach(async () => {
  await services.db.delete();
});

const scannerThatReads =
  (code: string): StartScanner =>
  async (_video, onCode) => {
    setTimeout(() => onCode(code), 0);
    return { stop() {} };
  };

describe('Foods screen', () => {
  it('lists and filters saved foods and opens one for editing', async () => {
    services = makeServices();
    await services.db.food.bulkPut([
      synced(foodData({ id: 'bread', name: 'Bread', carbs_per_100g: 50 })),
      synced(foodData({ id: 'brie', name: 'Brie', source: 'off', brand: 'Président', carbs_per_100g: 0.5 })),
      synced(foodData({ id: 'gone', name: 'Brittle' }), { deleted: 1 }),
    ]);
    const user = userEvent.setup();
    renderWith(<Foods />, services);
    expect(await screen.findByRole('button', { name: /Bread/ })).toHaveTextContent('My food · 50 g / 100 g');
    await user.type(screen.getByLabelText('Filter foods'), 'bri');
    expect(screen.queryByRole('button', { name: /Bread/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Brittle/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Brie/ }));
    expect(await screen.findByRole('heading', { name: 'Edit food' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Brie');
  });

  it('opens a scanned Open Food Facts product as a prefilled new food', async () => {
    services = makeServices({ startScanner: scannerThatReads('0737628064502') });
    services.api.on('GET', '/api/barcode/0737628064502', () => ({
      status: 'draft',
      draft: {
        food: { name: 'Noodle kit', brand: 'Thai Kitchen', source: 'off', source_ref: '0737628064502', carbs_per_100g: 71.15, fiber_per_100g: null },
        portions: [{ label: 'label serving', kind: 'serving', quantity: 1, grams: 52 }],
        barcode: '0737628064502',
        serving_size: null,
      },
    }));
    const user = userEvent.setup();
    renderWith(<Foods />, services);
    await user.click(await screen.findByRole('button', { name: 'Scan barcode' }));
    expect(await screen.findByRole('heading', { name: 'New food' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Noodle kit');
    expect(screen.getByLabelText('Carbs per 100 g')).toHaveValue('71.15');
    expect(screen.getByText('0737628064502')).toBeInTheDocument();
  });

  it('opens the saved food when a known barcode is scanned, without calling the server', async () => {
    services = makeServices({ startScanner: scannerThatReads('737628064502') });
    await services.db.food.put(synced(foodData({ id: 'noodles', name: 'Noodle kit', source: 'off' })));
    await services.db.barcode.put(synced({ id: 'b1', code: '0737628064502', food_id: 'noodles' }));
    const user = userEvent.setup();
    renderWith(<Foods />, services);
    await user.click(await screen.findByRole('button', { name: 'Scan barcode' }));
    expect(await screen.findByRole('heading', { name: 'Edit food' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Noodle kit');
    expect(services.api.calls).toEqual([]);
  });

  it('keeps a barcode scanned offline and falls back to manual entry when looked up later', async () => {
    services = makeServices({ startScanner: scannerThatReads('3017624010070') });
    services.api.on('GET', '/api/barcode/3017624010070', () => {
      throw new NetworkError('Failed to fetch');
    });
    const user = userEvent.setup();
    renderWith(<Foods />, services);
    await user.click(await screen.findByRole('button', { name: 'Scan barcode' }));
    expect(await screen.findByRole('status')).toHaveTextContent("No connection. Barcode 3017624010070 is saved to look up when you're back online.");
    expect(await screen.findByRole('region', { name: 'Barcodes to look up' })).toHaveTextContent('3017624010070');

    services.api.on('GET', '/api/barcode/3017624010070', () => ({ status: 'unavailable', code: '3017624010070', message: 'Open Food Facts responded 503' }));
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByRole('heading', { name: 'New food' })).toBeInTheDocument();
    expect(screen.getByText('Open Food Facts is unavailable (Open Food Facts responded 503). Enter the food from its label.')).toBeInTheDocument();
    expect(screen.getByText('3017624010070')).toBeInTheDocument();
    expect(await services.db.pending_barcode.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/foods.test.tsx`
Expected: FAIL — `Error: Failed to resolve import "../src/screens/Foods" from "test/foods.test.tsx". Does the file exist?`

- [ ] **Step 3: Implement the scanner dialog**

`web/src/ui/ScannerDialog.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react';
import { useServices } from '../app/services';
import { isBarcodeCode, type ScanSession } from '../barcode/scanner';

/** Camera scanner with a typed-code fallback (camera denied, no camera, damaged label). */
export function ScannerDialog(props: { onCode: (code: string) => void; onClose: () => void }) {
  const { startScanner } = useServices();
  const videoRef = useRef<HTMLVideoElement>(null);
  const onCodeRef = useRef(props.onCode);
  onCodeRef.current = props.onCode;
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let session: ScanSession | null = null;
    let done = false;
    startScanner(video, (code) => {
      if (done) return;
      done = true;
      session?.stop();
      onCodeRef.current(code);
    })
      .then((started) => {
        session = started;
        if (done) started.stop();
      })
      .catch((e: unknown) => {
        setError(`Camera unavailable (${e instanceof Error ? e.message : String(e)}). Type the barcode instead.`);
      });
    return () => {
      done = true;
      session?.stop();
    };
  }, [startScanner]);

  const code = typed.trim();
  return (
    <div className="overlay" role="dialog" aria-label="Scan barcode">
      <video ref={videoRef} className="scanner-video" muted playsInline />
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (isBarcodeCode(code)) onCodeRef.current(code);
        }}
      >
        <label>
          Barcode
          <input inputMode="numeric" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
        <div className="button-row">
          <button type="submit" className="primary" disabled={!isBarcodeCode(code)}>
            Look up
          </button>
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Implement the Foods screen**

`web/src/screens/Foods.tsx`:
```tsx
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useServices } from '../app/services';
import { type BarcodeResolution, resolveBarcode } from '../barcode/resolve';
import { isLive } from '../db/db';
import { FoodEditor } from '../foods/FoodEditor';
import { type FoodPrefill, prefillFromDraft } from '../foods/label';
import { formatCarbs, formatTime } from '../ui/format';
import { ScannerDialog } from '../ui/ScannerDialog';

type Mode = { kind: 'list' } | { kind: 'edit'; id: string } | { kind: 'new'; prefill?: FoodPrefill };

const SOURCE = { custom: 'My food', off: 'Open Food Facts', usda: 'USDA' } as const;

export function Foods() {
  const { db, api, now } = useServices();
  const foods = useLiveQuery(() => db.food.filter(isLive).toArray(), [db]);
  const pending = useLiveQuery(() => db.pending_barcode.toArray(), [db]);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [filter, setFilter] = useState('');
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const editId = mode.kind === 'edit' ? mode.id : null;
  const editing = useLiveQuery(
    async () =>
      editId
        ? { food: await db.food.get(editId), portions: await db.portion.where('food_id').equals(editId).filter(isLive).toArray() }
        : null,
    [db, editId],
  );

  function apply(result: BarcodeResolution) {
    switch (result.kind) {
      case 'local':
      case 'known':
        setMessage(`Already saved: ${result.food.name}`);
        setMode({ kind: 'edit', id: result.food.id });
        return;
      case 'draft':
        setMessage(null);
        setMode({ kind: 'new', prefill: prefillFromDraft(result.draft) });
        return;
      case 'manual':
        setMessage(null);
        setMode({ kind: 'new', prefill: { barcode: result.code, note: result.message } });
        return;
      case 'queued':
        setMessage(`No connection. Barcode ${result.code} is saved to look up when you're back online.`);
        return;
    }
  }

  async function lookUp(code: string) {
    setScanning(false);
    try {
      apply(await resolveBarcode(db, api, code, now));
    } catch (error) {
      setMessage(`Barcode lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const done = () => setMode({ kind: 'list' });
  if (mode.kind === 'new') return <FoodEditor prefill={mode.prefill} onDone={done} />;
  if (mode.kind === 'edit') {
    if (!editing?.food) return <p>Loading…</p>;
    return <FoodEditor key={editing.food.id} existing={{ food: editing.food, portions: editing.portions }} onDone={done} />;
  }

  const needle = filter.trim().toLowerCase();
  const shown = (foods ?? [])
    .filter((f) => !needle || `${f.name} ${f.brand ?? ''}`.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="screen">
      <h1>Foods</h1>
      {message && (
        <p role="status" className="message">
          {message}
        </p>
      )}
      <div className="button-row">
        <button type="button" className="primary" onClick={() => setMode({ kind: 'new' })}>
          New food
        </button>
        <button type="button" onClick={() => setScanning(true)}>
          Scan barcode
        </button>
      </div>
      {scanning && <ScannerDialog onCode={(code) => void lookUp(code)} onClose={() => setScanning(false)} />}
      {pending && pending.length > 0 && (
        <section className="card" aria-label="Barcodes to look up">
          <h2>Look up later</h2>
          <ul className="list">
            {pending.map((row) => (
              <li key={row.code} className="pending-row">
                <span>
                  {row.code} <span className="muted">scanned {formatTime(row.created_at)}</span>
                </span>
                <button type="button" onClick={() => void lookUp(row.code)}>
                  Look up
                </button>
                <button type="button" onClick={() => void db.pending_barcode.delete(row.code)}>
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <input type="search" aria-label="Filter foods" placeholder="Filter saved foods" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ul className="list">
        {shown.map((food) => (
          <li key={food.id}>
            <button type="button" className="list-item" onClick={() => setMode({ kind: 'edit', id: food.id })}>
              <span>{food.name}</span>
              <span className="muted">
                {[food.brand, SOURCE[food.source ?? 'custom'], food.carbs_per_100g === null ? 'no carb data' : `${formatCarbs(food.carbs_per_100g)} / 100 g`]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {foods && shown.length === 0 && <p className="muted">No saved foods{needle ? ' match' : ' yet'}.</p>}
    </div>
  );
}
```

- [ ] **Step 5: Run the test and typecheck**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/foods.test.tsx && pnpm typecheck`
Expected: `Tests  4 passed (4)`, then `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/ui/ScannerDialog.tsx web/src/screens/Foods.tsx web/test/foods.test.tsx
git commit -m "feat(web): Foods screen with barcode scan, drafts and look-up-later queue"
```

---

### Task 6: Meals

**Files:**
- Create: `web/src/meals/saveMeal.ts`, `web/src/meals/MealEditor.tsx`, `web/src/screens/Meals.tsx`
- Test: `web/test/meals.test.tsx`

- [ ] **Step 1: Write the failing test**

`web/test/meals.test.tsx`:
```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Meals } from '../src/screens/Meals';
import { foodData, mealData, mealItemData, synced } from './helpers';
import { makeServices, renderWith, type TestServices } from './render';

let services: TestServices;
afterEach(async () => {
  await services.db.delete();
});

async function setup() {
  services = makeServices();
  await services.db.food.bulkPut([
    synced(foodData({ id: 'tortilla', name: 'Tortilla', carbs_per_100g: 48 })),
    synced(foodData({ id: 'beans', name: 'Beans', carbs_per_100g: 20 })),
  ]);
  return userEvent.setup();
}

describe('Meals', () => {
  it('builds a meal with live per-serving carbs', async () => {
    const user = await setup();
    renderWith(<Meals />, services);
    await user.click(await screen.findByRole('button', { name: 'New meal' }));
    await user.type(screen.getByLabelText('Name'), 'Burritos');
    const yieldInput = screen.getByLabelText('Yield (servings)');
    await user.clear(yieldInput);
    await user.type(yieldInput, '2');
    const search = screen.getByLabelText('Add a component');
    await user.type(search, 'tort');
    await user.click(await screen.findByRole('button', { name: /Tortilla/ }));
    await user.type(search, 'bea');
    await user.click(await screen.findByRole('button', { name: /Beans/ }));
    expect(screen.getByTestId('meal-carbs')).toHaveTextContent('34 g carbs per serving');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('button', { name: /Burritos/ })).toHaveTextContent('34 g per serving');
    const items = (await services.db.meal_item.toArray()).sort((a, b) => a.position - b.position);
    expect(items.map((i) => [i.ref_id, i.amount, i.unit, i.position])).toEqual([
      ['tortilla', 100, 'g', 0],
      ['beans', 100, 'g', 1],
    ]);
  });

  it('reorders and removes components', async () => {
    const user = await setup();
    await services.db.meal.put(synced(mealData({ id: 'chili', name: 'Chili' })));
    await services.db.meal_item.bulkPut([
      synced(mealItemData({ id: 'i-tortilla', meal_id: 'chili', ref_id: 'tortilla', position: 0 })),
      synced(mealItemData({ id: 'i-beans', meal_id: 'chili', ref_id: 'beans', position: 1 })),
    ]);
    renderWith(<Meals />, services);
    await user.click(await screen.findByRole('button', { name: /Chili/ }));
    await user.click(await screen.findByRole('button', { name: 'Move Beans up' }));
    await user.click(screen.getByRole('button', { name: 'Remove Tortilla' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => expect((await services.db.meal_item.get('i-tortilla'))?.deleted).toBe(1));
    expect(await services.db.meal_item.get('i-beans')).toMatchObject({ position: 0, deleted: 0 });
  });

  it('refuses to add a meal that already contains this meal', async () => {
    const user = await setup();
    await services.db.meal.bulkPut([synced(mealData({ id: 'outer', name: 'Outer' })), synced(mealData({ id: 'inner', name: 'Inner' }))]);
    await services.db.meal_item.bulkPut([
      synced(mealItemData({ id: 'o1', meal_id: 'outer', ref_type: 'meal', ref_id: 'inner', amount: 1, unit: 'serving' })),
      synced(mealItemData({ id: 'n1', meal_id: 'inner', ref_id: 'tortilla' })),
    ]);
    renderWith(<Meals />, services);
    await user.click(await screen.findByRole('button', { name: /Inner/ }));
    await user.type(screen.getByLabelText('Add a component'), 'outer');
    await user.click(await screen.findByRole('button', { name: /Outer/ }));
    expect(screen.getByRole('alert')).toHaveTextContent("Can't add Outer: it already contains this meal.");
    expect(screen.getAllByTestId('item-row')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/meals.test.tsx`
Expected: FAIL — `Error: Failed to resolve import "../src/screens/Meals" from "test/meals.test.tsx". Does the file exist?`

- [ ] **Step 3: Implement meal saving**

`web/src/meals/saveMeal.ts`:
```ts
import type { MealData, MealItemData } from '@carbbook/core';
import type { CatalogData } from '../db/catalog';
import type { Change, Store } from '../db/store';
import { parseNonNegative } from '../ui/format';
import type { DraftItem } from '../ui/ItemEditor';
import { saveUsdaFoodsFor } from '../usda/materialize';

/** Saves a meal and its components (item key = meal_item id, order = position). */
export async function saveMeal(store: Store, meal: MealData, items: DraftItem[], removedItemIds: string[] = []): Promise<void> {
  await saveUsdaFoodsFor(store, items);
  const changes: Change[] = [
    { table: 'meal', data: meal },
    ...items.map(
      (item, position): Change => ({
        table: 'meal_item',
        data: {
          id: item.key,
          meal_id: meal.id,
          ref_type: item.ref_type,
          ref_id: item.ref_id,
          amount: parseNonNegative(item.amount)!,
          unit: item.unit,
          position,
        },
      }),
    ),
  ];
  await store.saveMany(changes);
  for (const id of removedItemIds) await store.remove('meal_item', id);
}

/** Catalog data with an unsaved meal draft in place of the stored meal, for live carbs and cycle checks. */
export function withDraftMeal(data: CatalogData, meal: MealData, items: DraftItem[]): CatalogData {
  const meta = { updated_at: 0, updated_by: 'draft', deleted: 0 as const };
  const draftItems = items.map(
    (item, position): MealItemData & typeof meta => ({
      id: item.key,
      meal_id: meal.id,
      ref_type: item.ref_type,
      ref_id: item.ref_id,
      amount: parseNonNegative(item.amount) ?? Number.NaN,
      unit: item.unit,
      position,
      ...meta,
    }),
  );
  return {
    ...data,
    meals: [...data.meals.filter((m) => m.id !== meal.id), { ...meal, ...meta }],
    meal_items: [...data.meal_items.filter((i) => i.meal_id !== meal.id), ...draftItems],
  };
}
```

- [ ] **Step 4: Implement the meal editor**

`web/src/meals/MealEditor.tsx`:
```tsx
import { itemCarbs, type MealData, wouldCreateCycle } from '@carbbook/core';
import { useState } from 'react';
import { useUsdaPicks } from '../app/hooks';
import { useServices } from '../app/services';
import { buildCatalog, type CatalogData } from '../db/catalog';
import { parseUsdaFoodId, uuidv7 } from '../lib/ids';
import type { SearchResult } from '../search/search';
import { formatCarbs, parseNonNegative } from '../ui/format';
import { type DraftItem, ItemEditor, newDraftItem } from '../ui/ItemEditor';
import { SearchPanel } from '../ui/SearchPanel';
import { saveMeal, withDraftMeal } from './saveMeal';

export function MealEditor(props: { data: CatalogData; mealId: string | null; onDone: () => void }) {
  const { data, mealId } = props;
  const { store, now } = useServices();
  const usda = useUsdaPicks();
  const existing = mealId ? data.meals.find((m) => m.id === mealId) : undefined;
  const [id] = useState(() => mealId ?? uuidv7(now()));
  const [originalItemIds] = useState(() => data.meal_items.filter((i) => i.meal_id === mealId).map((i) => i.id));
  const [name, setName] = useState(existing?.name ?? '');
  const [yieldText, setYieldText] = useState(String(existing?.yield_servings ?? 1));
  const [weightText, setWeightText] = useState(existing?.total_weight_g == null ? '' : String(existing.total_weight_g));
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [items, setItems] = useState<DraftItem[]>(() =>
    data.meal_items
      .filter((i) => i.meal_id === mealId)
      .sort((a, b) => a.position - b.position)
      .map((i) => ({ key: i.id, ref_type: i.ref_type, ref_id: i.ref_id, amount: String(i.amount), unit: i.unit })),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const meal: MealData = {
    id,
    name: name.trim(),
    yield_servings: parseNonNegative(yieldText) ?? Number.NaN,
    total_weight_g: weightText.trim() === '' ? null : (parseNonNegative(weightText) ?? Number.NaN),
    notes: notes.trim() || null,
  };
  const catalog = buildCatalog(withDraftMeal(data, meal, items), usda.entries);
  const perServing = itemCarbs(catalog, 'meal', id, 1, 'serving');
  const per100g = meal.total_weight_g != null && meal.total_weight_g > 0 ? itemCarbs(catalog, 'meal', id, 100, 'g') : null;

  async function pick(result: SearchResult) {
    setMessage(null);
    if (result.kind === 'meal' && wouldCreateCycle(catalog, id, result.id)) {
      setMessage(`Can't add ${result.name}: it already contains this meal.`);
      return;
    }
    let target = catalog;
    if (result.kind === 'usda') {
      const entry = await usda.add(parseUsdaFoodId(result.id)!);
      if (!entry) return;
      target = buildCatalog(withDraftMeal(data, meal, items), [...usda.entries, entry]);
    }
    setItems((current) => [...current, newDraftItem(target, result.kind === 'meal' ? 'meal' : 'food', result.id, uuidv7(now()))]);
  }

  async function save() {
    const problems: string[] = [];
    if (!meal.name) problems.push('Name is required.');
    if (!(meal.yield_servings > 0)) problems.push('Yield must be more than 0 servings.');
    if (meal.total_weight_g != null && !(meal.total_weight_g > 0)) problems.push('Total weight must be empty or more than 0 g.');
    if (items.length === 0) problems.push('Add at least one component.');
    if (items.some((i) => parseNonNegative(i.amount) === null)) problems.push('Every component needs an amount.');
    setErrors(problems);
    if (problems.length > 0) return;
    const keys = new Set(items.map((i) => i.key));
    await saveMeal(store, meal, items, originalItemIds.filter((itemId) => !keys.has(itemId)));
    props.onDone();
  }

  async function remove() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    for (const itemId of originalItemIds) await store.remove('meal_item', itemId);
    await store.remove('meal', id);
    props.onDone();
  }

  return (
    <div className="screen editor">
      <h1>{existing ? 'Edit meal' : 'New meal'}</h1>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Yield (servings)
        <input inputMode="decimal" value={yieldText} onChange={(e) => setYieldText(e.target.value)} />
      </label>
      <label>
        Total weight (g, optional)
        <input inputMode="decimal" value={weightText} onChange={(e) => setWeightText(e.target.value)} />
      </label>
      <h2>Components</h2>
      <ItemEditor items={items} catalog={catalog} onChange={setItems} reorderable />
      <SearchPanel label="Add a component" onPick={(result) => void pick(result)} />
      {message && <p role="alert">{message}</p>}
      <p className="total" data-testid="meal-carbs">
        {perServing.complete ? `${formatCarbs(perServing.carbs_g)} carbs per serving` : 'Incomplete carb data'}
        {per100g?.complete ? ` · ${formatCarbs(per100g.carbs_g)} per 100 g` : ''}
      </p>
      <label>
        Notes
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {errors.length > 0 && (
        <ul role="alert" className="errors">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <div className="button-row">
        <button type="button" className="primary" onClick={() => void save()}>
          Save
        </button>
        <button type="button" onClick={props.onDone}>
          Cancel
        </button>
        {existing && (
          <button type="button" className="danger" onClick={() => void remove()}>
            {confirmDelete ? 'Tap again to delete' : 'Delete meal'}
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Implement the Meals screen**

`web/src/screens/Meals.tsx`:
```tsx
import { itemCarbs } from '@carbbook/core';
import { useState } from 'react';
import { useCatalogData } from '../app/hooks';
import { buildCatalog } from '../db/catalog';
import { MealEditor } from '../meals/MealEditor';
import { formatCarbs } from '../ui/format';

export function Meals() {
  const data = useCatalogData();
  const [editing, setEditing] = useState<string | null>(null);
  if (!data) return <p>Loading…</p>;
  if (editing) {
    return <MealEditor key={editing} data={data} mealId={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />;
  }
  const catalog = buildCatalog(data);
  const meals = [...data.meals].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="screen">
      <h1>Meals</h1>
      <button type="button" className="primary" onClick={() => setEditing('new')}>
        New meal
      </button>
      {meals.length === 0 && <p className="muted">No meals yet. Build one here, or use Save as meal on the calculator.</p>}
      <ul className="list">
        {meals.map((meal) => {
          const perServing = itemCarbs(catalog, 'meal', meal.id, 1, 'serving');
          return (
            <li key={meal.id}>
              <button type="button" className="list-item" onClick={() => setEditing(meal.id)}>
                <span>{meal.name}</span>
                <span className="muted">{perServing.complete ? `${formatCarbs(perServing.carbs_g)} per serving` : 'incomplete carb data'}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

- [ ] **Step 6: Run the test and typecheck**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/meals.test.tsx && pnpm typecheck`
Expected: `Tests  3 passed (3)`, then `tsc` exits 0.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/meals web/src/screens/Meals.tsx web/test/meals.test.tsx
git commit -m "feat(web): meals list and editor with live per-serving carbs and cycle check"
```

---

### Task 7: Calculator

**Files:**
- Create: `web/src/screens/Calculator.tsx`
- Test: `web/test/calculator.test.tsx`

- [ ] **Step 1: Write the failing test**

`web/test/calculator.test.tsx`:
```tsx
import type { LogEntryData } from '@carbbook/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { REFUSAL_MESSAGES } from '../src/dose/dose';
import { Calculator } from '../src/screens/Calculator';
import { foodData, synced } from './helpers';
import { makeServices, NOW, renderWith, seedSettings, type TestServices } from './render';

let services: TestServices;
afterEach(async () => {
  await services.db.delete();
});

async function setup() {
  services = makeServices();
  await seedSettings(services.db);
  await services.db.food.bulkPut([
    synced(foodData({ id: 'tortilla', name: 'Tortilla', carbs_per_100g: 48 })),
    synced(foodData({ id: 'mystery', name: 'Mystery stew', carbs_per_100g: null })),
  ]);
  return userEvent.setup();
}

async function addItem(user: ReturnType<typeof userEvent.setup>, query: string, name: RegExp) {
  await user.type(await screen.findByLabelText('Search foods and meals'), query);
  await user.click(await screen.findByRole('button', { name }));
}

describe('Calculator', () => {
  it('shows live carbs and the dose breakdown labelled as an estimate', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await addItem(user, 'tort', /Tortilla/);
    const amount = await screen.findByLabelText('Amount of Tortilla');
    await user.clear(amount);
    await user.type(amount, '150');
    expect(screen.getByLabelText('Carbs in Tortilla')).toHaveTextContent('72 g');
    await user.type(screen.getByLabelText('BG (mg/dL)'), '263');
    expect(screen.getByTestId('dose-breakdown')).toHaveTextContent('72g ÷ 8 = 9.0 + BG 263 → 2u = 11.0 → 11u');
    expect(screen.getByTestId('dose-units')).toHaveTextContent('11 u');
    expect(screen.getByText('estimate')).toBeInTheDocument();
  });

  it('shows the refusal reason and no number when carb data is missing', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await addItem(user, 'mystery', /Mystery stew/);
    expect(await screen.findByTestId('dose-refusal')).toHaveTextContent(REFUSAL_MESSAGES.incomplete_carbs);
    expect(screen.queryByTestId('dose-units')).not.toBeInTheDocument();
    expect(screen.getByText('missing data')).toBeInTheDocument();
    expect(screen.getByTestId('total-carbs')).toHaveTextContent('(incomplete)');
  });

  it('prefills a fresh Dexcom reading', async () => {
    const user = await setup();
    services.api.on('GET', '/api/bg', () => ({
      mgdl: 250, trend: 'Flat', arrow: '→', delta_mgdl: 0, read_at: NOW - 5 * 60_000, age_ms: 5 * 60_000, fresh: true,
    }));
    renderWith(<Calculator />, services);
    expect(await screen.findByTestId('bg-reading')).toHaveTextContent('BG 250 → · 5 min ago (Dexcom)');
    await addItem(user, 'tort', /Tortilla/);
    expect(await screen.findByTestId('dose-breakdown')).toHaveTextContent('48g ÷ 8 = 6.0 + BG 250 → 1u = 7.0 → 7u');
  });

  it('logs the entry and copies a USDA food into the synced food table', async () => {
    const user = await setup();
    await services.db.usda_food.put({ fdc_id: 324860, name: 'Peanut butter, smooth style, with salt', carbs_per_100g: 22.3, fiber_per_100g: 4.8 });
    await services.db.usda_portion.put({ id: 119207, fdc_id: 324860, label: 'tbsp', kind: 'volume', quantity: 2, grams: 32, description: 'tablespoon' });
    renderWith(<Calculator />, services);
    await addItem(user, 'peanut', /Peanut butter/);
    const name = 'Peanut butter, smooth style, with salt';
    const amount = await screen.findByLabelText(`Amount of ${name}`);
    await user.clear(amount);
    await user.type(amount, '10');
    await user.selectOptions(screen.getByLabelText(`Unit for ${name}`), 'tbsp');
    await user.type(screen.getByLabelText('BG (mg/dL)'), '120');
    expect(screen.getByTestId('dose-breakdown')).toHaveTextContent('35.7g ÷ 8 = 4.5 + BG 120 → 0u = 4.5 → 4u (rounded down: BG under 130)');
    expect(screen.getByLabelText('Taken dose (u)')).toHaveValue('4');

    await user.click(screen.getByRole('button', { name: 'Log it' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Logged 35.7 g carbs at 12:00.');
    const [entry] = await services.db.log_entry.toArray();
    expect(entry).toMatchObject({
      eaten_at: NOW, window_name: 'Lunch', bg_mgdl: 120, bg_source: 'manual', suggested_units: 4, taken_units: 4,
      settings_version_id: 'dose-2026-08-12', updated_by: 'device-test',
    });
    expect(entry!.total_carbs_g).toBeCloseTo(35.68, 5);
    expect(await services.db.log_item.toArray()).toEqual([
      expect.objectContaining({ log_entry_id: entry!.id, ref_type: 'food', ref_id: 'usda-324860', display_name: name, amount: 10, unit: 'tbsp' }),
    ]);
    expect(await services.db.food.get('usda-324860')).toMatchObject({ source: 'usda', source_ref: '324860' });
    expect(screen.queryAllByTestId('item-row')).toHaveLength(0);
  });

  it('warns when a dose was logged in the last 4 hours', async () => {
    const user = await setup();
    await services.db.log_entry.put(
      synced<LogEntryData>({
        id: 'earlier', eaten_at: NOW - 2 * 3_600_000, window_name: 'Breakfast', bg_mgdl: null, bg_source: 'none',
        total_carbs_g: 40, suggested_units: 5, taken_units: 5, settings_version_id: null,
      }),
    );
    renderWith(<Calculator />, services);
    await addItem(user, 'tort', /Tortilla/);
    expect(await screen.findByText(/A dose was logged at 10:00, within the last 4 hours/)).toBeInTheDocument();
  });

  it('saves the current items as a meal', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await addItem(user, 'tort', /Tortilla/);
    await user.click(screen.getByRole('button', { name: 'Save as meal' }));
    await user.type(screen.getByLabelText('Meal name'), 'Taco night');
    const yieldInput = screen.getByLabelText('Yield (servings)');
    await user.clear(yieldInput);
    await user.type(yieldInput, '3');
    await user.click(screen.getByRole('button', { name: 'Save meal' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved meal "Taco night".');
    await waitFor(async () => expect(await services.db.meal_item.count()).toBe(1));
    const [meal] = await services.db.meal.toArray();
    expect(meal).toMatchObject({ name: 'Taco night', yield_servings: 3, total_weight_g: null });
    expect(await services.db.meal_item.toArray()).toEqual([
      expect.objectContaining({ meal_id: meal!.id, ref_type: 'food', ref_id: 'tortilla', amount: 100, unit: 'g', position: 0 }),
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/calculator.test.tsx`
Expected: FAIL — `Error: Failed to resolve import "../src/screens/Calculator" from "test/calculator.test.tsx". Does the file exist?`

- [ ] **Step 3: Implement**

`web/src/screens/Calculator.tsx`:
```tsx
import { activeSettings, sumCarbs } from '@carbbook/core';
import { useState } from 'react';
import { lastDoseAt, useBgStatus, useCatalogData, useDoseVersions, useLogData, useNow, useUsdaPicks } from '../app/hooks';
import { useServices } from '../app/services';
import { bgPrefill } from '../bg/bg';
import { resolveBarcode } from '../barcode/resolve';
import { buildCatalog } from '../db/catalog';
import { isLive } from '../db/db';
import type { Change } from '../db/store';
import { estimateFor } from '../dose/dose';
import { FoodEditor } from '../foods/FoodEditor';
import { type FoodPrefill, prefillFromDraft } from '../foods/label';
import { parseUsdaFoodId, uuidv7 } from '../lib/ids';
import { saveMeal } from '../meals/saveMeal';
import type { SearchResult } from '../search/search';
import { BgField, resolveBg } from '../ui/BgField';
import { DoseCard } from '../ui/DoseCard';
import { formatCarbs, formatTime, fromDateTimeLocal, parseNonNegative, toDateTimeLocal } from '../ui/format';
import { type DraftItem, draftItemCarbs, ItemEditor, itemName, newDraftItem } from '../ui/ItemEditor';
import { ScannerDialog } from '../ui/ScannerDialog';
import { SearchPanel } from '../ui/SearchPanel';
import { saveUsdaFoodsFor } from '../usda/materialize';

interface MealForm {
  name: string;
  yieldText: string;
  weightText: string;
}

export function Calculator() {
  const { db, api, store, now } = useServices();
  const data = useCatalogData();
  const versions = useDoseVersions();
  const log = useLogData();
  const usda = useUsdaPicks();
  const bgStatus = useBgStatus();
  const clock = useNow();
  const [items, setItems] = useState<DraftItem[]>([]);
  const [eatenText, setEatenText] = useState(() => toDateTimeLocal(now()));
  const [windowName, setWindowName] = useState<string | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [manualText, setManualText] = useState('');
  const [takenText, setTakenText] = useState('');
  const [takenEdited, setTakenEdited] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [foodPrefill, setFoodPrefill] = useState<FoodPrefill | null>(null);
  const [mealForm, setMealForm] = useState<MealForm | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!data || !versions || !log) return <p>Loading…</p>;

  const catalog = buildCatalog(data, usda.entries);
  const results = items.map((item) => draftItemCarbs(catalog, item));
  const carbs = sumCarbs(results);
  const eatenAt = fromDateTimeLocal(eatenText) ?? Number.NaN;
  const prefill = bgStatus ? bgPrefill(bgStatus, clock) : null;
  const bg = resolveBg(prefill, manualMode, manualText);
  const settings = activeSettings(versions, eatenAt);
  const estimate = settings ? estimateFor({ settings, windowName, eatenAt, carbs, bg: bg.mgdl }) : null;
  const suggested = estimate?.ok ? estimate.units : null;
  const takenValue = takenEdited ? takenText : suggested === null ? '' : String(suggested);
  const autoWindow = windowName === null ? (estimate?.window?.name ?? null) : null;
  const badAmounts = items.some((item) => parseNonNegative(item.amount) === null);

  function addFood(refType: 'food' | 'meal', refId: string, extra = catalog) {
    setItems((current) => [...current, newDraftItem(extra, refType, refId, uuidv7(now()))]);
  }

  async function pick(result: SearchResult) {
    if (result.kind !== 'usda') return addFood(result.kind, result.id);
    const entry = await usda.add(parseUsdaFoodId(result.id)!);
    if (entry) addFood('food', result.id, buildCatalog(data!, [...usda.entries, entry]));
  }

  async function addSavedFood(foodId: string) {
    const food = await db.food.get(foodId);
    if (!food) return;
    const portions = await db.portion.where('food_id').equals(foodId).filter(isLive).toArray();
    addFood('food', foodId, buildCatalog(data!, [{ food, portions }]));
  }

  async function lookUp(code: string) {
    setScanning(false);
    try {
      const result = await resolveBarcode(db, api, code, now);
      if (result.kind === 'local' || result.kind === 'known') await addSavedFood(result.food.id);
      else if (result.kind === 'draft') setFoodPrefill(prefillFromDraft(result.draft));
      else if (result.kind === 'manual') setFoodPrefill({ barcode: result.code, note: result.message });
      else setMessage(`No connection. Barcode ${result.code} is saved in Foods to look up later.`);
    } catch (error) {
      setMessage(`Barcode lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function reset() {
    setItems([]);
    setTakenEdited(false);
    setTakenText('');
    setWindowName(null);
    setManualMode(false);
    setManualText('');
    setEatenText(toDateTimeLocal(now()));
  }

  async function logIt() {
    if (badAmounts) return setMessage('Enter an amount for every item before logging.');
    if (!Number.isFinite(eatenAt)) return setMessage('Enter when you ate.');
    const taken = parseNonNegative(takenValue);
    if (takenValue.trim() !== '' && taken === null) return setMessage('Taken dose must be a number.');
    await saveUsdaFoodsFor(store, items);
    const entryId = uuidv7(now());
    const changes: Change[] = [
      {
        table: 'log_entry',
        data: {
          id: entryId,
          eaten_at: eatenAt,
          window_name: estimate?.window?.name ?? windowName,
          bg_mgdl: bg.mgdl,
          bg_source: bg.source,
          bg_trend: bg.trend,
          total_carbs_g: carbs.carbs_g,
          suggested_units: suggested,
          taken_units: taken,
          settings_version_id: settings?.id ?? null,
          notes: null,
        },
      },
      ...items.map(
        (item, index): Change => ({
          table: 'log_item',
          data: {
            id: uuidv7(now()),
            log_entry_id: entryId,
            ref_type: item.ref_type,
            ref_id: item.ref_id,
            display_name: itemName(catalog, item.ref_type, item.ref_id),
            amount: parseNonNegative(item.amount)!,
            unit: item.unit,
            carbs_g: results[index]!.carbs_g,
          },
        }),
      ),
    ];
    await store.saveMany(changes);
    reset();
    setMessage(`Logged ${formatCarbs(carbs.carbs_g)} carbs at ${formatTime(eatenAt)}.`);
  }

  async function saveAsMeal(form: MealForm) {
    const yieldServings = parseNonNegative(form.yieldText);
    const weight = form.weightText.trim() === '' ? null : parseNonNegative(form.weightText);
    if (!form.name.trim()) return setMessage('Give the meal a name.');
    if (!(yieldServings !== null && yieldServings > 0)) return setMessage('Yield must be more than 0 servings.');
    if (form.weightText.trim() !== '' && !(weight !== null && weight > 0)) return setMessage('Total weight must be empty or more than 0 g.');
    if (badAmounts) return setMessage('Enter an amount for every item before saving.');
    // Fresh item ids: saving the same calculator twice must not move items between meals.
    const mealItems = items.map((item) => ({ ...item, key: uuidv7(now()) }));
    await saveMeal(store, { id: uuidv7(now()), name: form.name.trim(), yield_servings: yieldServings, total_weight_g: weight, notes: null }, mealItems);
    setMealForm(null);
    setMessage(`Saved meal "${form.name.trim()}".`);
  }

  if (foodPrefill) {
    return (
      <FoodEditor
        prefill={foodPrefill}
        onDone={(foodId) => {
          setFoodPrefill(null);
          if (foodId) void addSavedFood(foodId);
        }}
      />
    );
  }

  return (
    <div className="screen calculator">
      <h1>Calculator</h1>
      {message && (
        <p role="status" className="message">
          {message}
        </p>
      )}
      <SearchPanel onPick={(result) => void pick(result)} onScan={() => setScanning(true)} />
      {scanning && <ScannerDialog onCode={(code) => void lookUp(code)} onClose={() => setScanning(false)} />}
      <ItemEditor items={items} catalog={catalog} onChange={setItems} />
      {items.length > 0 && (
        <p className="total" data-testid="total-carbs">
          Total {formatCarbs(carbs.carbs_g)} carbs{carbs.complete ? '' : ' (incomplete)'}
        </p>
      )}
      <section className="card">
        <label>
          Eaten at
          <input type="datetime-local" value={eatenText} onChange={(e) => setEatenText(e.target.value)} />
        </label>
        <label>
          Window
          <select value={windowName ?? ''} onChange={(e) => setWindowName(e.target.value || null)}>
            <option value="">{autoWindow ? `Auto (${autoWindow})` : 'Auto'}</option>
            {settings?.windows.map((w) => (
              <option key={w.name} value={w.name}>
                {w.name} (1:{w.ratio_g_per_unit})
              </option>
            ))}
          </select>
        </label>
        <BgField
          status={bgStatus}
          prefill={prefill}
          manualMode={manualMode}
          manualText={manualText}
          onManualModeChange={setManualMode}
          onManualTextChange={setManualText}
        />
      </section>
      <DoseCard estimate={estimate} hasItems={items.length > 0} bg={bg.mgdl} lastDoseAt={lastDoseAt(log.entries)} now={clock} />
      <section className="card">
        <label>
          Taken dose (u)
          <input
            inputMode="decimal"
            value={takenValue}
            onChange={(e) => {
              setTakenEdited(true);
              setTakenText(e.target.value);
            }}
          />
        </label>
        <div className="button-row">
          <button type="button" className="primary" disabled={items.length === 0} onClick={() => void logIt()}>
            Log it
          </button>
          <button type="button" disabled={items.length === 0} onClick={() => setMealForm({ name: '', yieldText: '1', weightText: '' })}>
            Save as meal
          </button>
        </div>
      </section>
      {mealForm && (
        <form
          className="card"
          aria-label="Save as meal"
          onSubmit={(e) => {
            e.preventDefault();
            void saveAsMeal(mealForm);
          }}
        >
          <label>
            Meal name
            <input value={mealForm.name} onChange={(e) => setMealForm({ ...mealForm, name: e.target.value })} />
          </label>
          <label>
            Yield (servings)
            <input inputMode="decimal" value={mealForm.yieldText} onChange={(e) => setMealForm({ ...mealForm, yieldText: e.target.value })} />
          </label>
          <label>
            Total weight (g, optional)
            <input inputMode="decimal" value={mealForm.weightText} onChange={(e) => setMealForm({ ...mealForm, weightText: e.target.value })} />
          </label>
          <div className="button-row">
            <button type="submit" className="primary">
              Save meal
            </button>
            <button type="button" onClick={() => setMealForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test and typecheck**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/calculator.test.tsx && pnpm typecheck`
Expected: `Tests  6 passed (6)`, then `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/screens/Calculator.tsx web/test/calculator.test.tsx
git commit -m "feat(web): calculator with live carbs, dose estimate, log it and save as meal"
```

---

### Task 8: Log

**Files:**
- Create: `web/src/log/LogEntryEditor.tsx`, `web/src/screens/Log.tsx`
- Test: `web/test/log.test.tsx`

- [ ] **Step 1: Write the failing test**

`web/test/log.test.tsx`:
```tsx
import type { LogEntryData, LogItemData } from '@carbbook/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Log } from '../src/screens/Log';
import { foodData, synced } from './helpers';
import { makeServices, NOW, renderWith, SEED_SETTINGS, seedSettings, type TestServices } from './render';

let services: TestServices;
afterEach(async () => {
  await services.db.delete();
});

const HOUR = 3_600_000;
const entry = (fields: Partial<LogEntryData> & { id: string; eaten_at: number }) =>
  synced<LogEntryData>({
    window_name: 'Lunch', bg_mgdl: null, bg_source: 'none', total_carbs_g: 0, suggested_units: null, taken_units: null,
    settings_version_id: SEED_SETTINGS.id, notes: null, ...fields,
  });
const item = (fields: Partial<LogItemData> & { id: string; log_entry_id: string }) =>
  synced<LogItemData>({ ref_type: 'food', ref_id: 'tortilla', display_name: 'Tortilla', amount: 100, unit: 'g', carbs_g: 0, ...fields });

async function setup() {
  services = makeServices();
  await seedSettings(services.db);
  await services.db.food.put(synced(foodData({ id: 'tortilla', name: 'Tortilla', carbs_per_100g: 48 })));
  await services.db.log_entry.bulkPut([
    entry({ id: 'today', eaten_at: NOW - HOUR, total_carbs_g: 30, suggested_units: 4, taken_units: 4 }),
    entry({ id: 'yesterday', eaten_at: NOW - 24 * HOUR, total_carbs_g: 10 }),
  ]);
  await services.db.log_item.bulkPut([
    item({ id: 'li-today', log_entry_id: 'today', display_name: 'Old tortilla', carbs_g: 30 }),
    item({ id: 'li-yesterday', log_entry_id: 'yesterday', carbs_g: 10 }),
  ]);
  return userEvent.setup();
}

describe('Log', () => {
  it('lists the day with totals and moves between days', async () => {
    const user = await setup();
    renderWith(<Log />, services);
    expect(await screen.findByTestId('day-totals')).toHaveTextContent('30 g carbs · 4 u taken');
    expect(screen.getByRole('button', { name: /11:00 Lunch/ })).toHaveTextContent('Old tortilla');
    await user.click(screen.getByRole('button', { name: 'Previous day' }));
    expect(screen.getByTestId('day-totals')).toHaveTextContent('10 g carbs · 0 u taken');
  });

  it('recalculates an entry from current food data and saves the new snapshot', async () => {
    const user = await setup();
    renderWith(<Log />, services);
    await user.click(await screen.findByRole('button', { name: /11:00 Lunch/ }));
    await user.click(await screen.findByRole('button', { name: 'Recalculate from current meal' }));
    expect(screen.getByTestId('entry-carbs')).toHaveTextContent('Total 48 g carbs');
    expect(screen.getByRole('status')).toHaveTextContent('Recalculated from current foods and meals.');
    expect(screen.getByTestId('dose-breakdown')).toHaveTextContent('48g ÷ 8 = 6.0 → 6u');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => expect((await services.db.log_item.get('li-today'))?.carbs_g).toBe(48));
    expect(await services.db.log_item.get('li-today')).toMatchObject({ display_name: 'Tortilla', updated_by: 'device-test' });
    expect(await services.db.log_entry.get('today')).toMatchObject({ total_carbs_g: 48, suggested_units: 6, taken_units: 4 });
  });

  it('keeps the logged carbs of an item whose food has no data now', async () => {
    const user = await setup();
    await services.db.food.put(synced(foodData({ id: 'tortilla', name: 'Tortilla', carbs_per_100g: null }), { updated_at: 2000 }));
    renderWith(<Log />, services);
    await user.click(await screen.findByRole('button', { name: /11:00 Lunch/ }));
    await user.click(await screen.findByRole('button', { name: 'Recalculate from current meal' }));
    expect(screen.getByRole('status')).toHaveTextContent('Kept the logged carbs for Old tortilla');
    expect(screen.getByTestId('entry-carbs')).toHaveTextContent('Total 30 g carbs');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/log.test.tsx`
Expected: FAIL — `Error: Failed to resolve import "../src/screens/Log" from "test/log.test.tsx". Does the file exist?`

- [ ] **Step 3: Implement the entry editor**

`web/src/log/LogEntryEditor.tsx`:
```tsx
import { activeSettings, type DoseSettingsData, itemCarbs, type LogEntryData, type LogItemData, type Synced } from '@carbbook/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useCatalogData, useDoseVersions } from '../app/hooks';
import { useServices } from '../app/services';
import { buildCatalog, type CatalogData } from '../db/catalog';
import { isLive } from '../db/db';
import { type Change, dataOf } from '../db/store';
import { estimateFor } from '../dose/dose';
import { DoseCard } from '../ui/DoseCard';
import { formatCarbs, fromDateTimeLocal, parseNonNegative, toDateTimeLocal, unitLabel } from '../ui/format';
import { itemName } from '../ui/ItemEditor';

export function LogEntryEditor(props: { entryId: string; onDone: () => void }) {
  const { db } = useServices();
  const loaded = useLiveQuery(
    async () => ({
      entry: await db.log_entry.get(props.entryId),
      items: await db.log_item.where('log_entry_id').equals(props.entryId).filter(isLive).toArray(),
    }),
    [db, props.entryId],
  );
  const data = useCatalogData();
  const versions = useDoseVersions();
  if (!loaded || !data || !versions) return <p>Loading…</p>;
  if (!loaded.entry || loaded.entry.deleted === 1) {
    return (
      <div className="screen">
        <p>This entry was deleted.</p>
        <button type="button" onClick={props.onDone}>
          Back
        </button>
      </div>
    );
  }
  return <EntryForm entry={loaded.entry} items={loaded.items} data={data} versions={versions} onDone={props.onDone} />;
}

function EntryForm(props: {
  entry: Synced<LogEntryData>;
  items: Synced<LogItemData>[];
  data: CatalogData;
  versions: Synced<DoseSettingsData>[];
  onDone: () => void;
}) {
  const { entry, items, data, versions } = props;
  const { store, now } = useServices();
  const [eatenText, setEatenText] = useState(toDateTimeLocal(entry.eaten_at));
  const [bgText, setBgText] = useState(entry.bg_mgdl == null ? '' : String(entry.bg_mgdl));
  const [takenText, setTakenText] = useState(entry.taken_units == null ? '' : String(entry.taken_units));
  const [notes, setNotes] = useState(entry.notes ?? '');
  const [rows, setRows] = useState(items);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const eatenAt = fromDateTimeLocal(eatenText) ?? Number.NaN;
  const bg = parseNonNegative(bgText);
  const total = rows.reduce((sum, row) => sum + row.carbs_g, 0);
  const settings = versions.find((v) => v.id === entry.settings_version_id) ?? activeSettings(versions, eatenAt);
  const estimate = settings
    ? estimateFor({ settings, windowName: entry.window_name, eatenAt, carbs: { carbs_g: total, complete: true }, bg })
    : null;

  /** Spec §8: refresh each item's carbs snapshot from current food/meal data via core. */
  function recalculate() {
    const catalog = buildCatalog(data);
    const kept: string[] = [];
    setRows(
      rows.map((row) => {
        const result = itemCarbs(catalog, row.ref_type, row.ref_id, row.amount, row.unit);
        if (!result.complete) {
          kept.push(row.display_name);
          return row;
        }
        return { ...row, carbs_g: result.carbs_g, display_name: itemName(catalog, row.ref_type, row.ref_id) };
      }),
    );
    setMessage(
      kept.length > 0
        ? `Kept the logged carbs for ${kept.join(', ')}: no complete carb data now.`
        : 'Recalculated from current foods and meals. Save to keep it.',
    );
  }

  async function save() {
    const problems: string[] = [];
    if (!Number.isFinite(eatenAt)) problems.push('Enter when you ate.');
    if (bgText.trim() !== '' && bg === null) problems.push('BG must be a number.');
    const taken = parseNonNegative(takenText);
    if (takenText.trim() !== '' && taken === null) problems.push('Taken dose must be a number.');
    setErrors(problems);
    if (problems.length > 0) return;
    const bgChanged = bg !== entry.bg_mgdl;
    const changes: Change[] = [
      {
        table: 'log_entry',
        data: {
          ...dataOf<'log_entry'>(entry),
          eaten_at: eatenAt,
          bg_mgdl: bg,
          bg_source: bgChanged ? (bg === null ? 'none' : 'manual') : entry.bg_source,
          bg_trend: bgChanged ? null : (entry.bg_trend ?? null),
          total_carbs_g: total,
          suggested_units: estimate?.ok ? estimate.units : null,
          taken_units: taken,
          notes: notes.trim() || null,
        },
      },
    ];
    for (const row of rows) {
      const original = items.find((i) => i.id === row.id);
      if (original && (original.carbs_g !== row.carbs_g || original.display_name !== row.display_name)) {
        changes.push({ table: 'log_item', data: dataOf<'log_item'>(row) });
      }
    }
    await store.saveMany(changes);
    props.onDone();
  }

  async function remove() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    for (const item of items) await store.remove('log_item', item.id);
    await store.remove('log_entry', entry.id);
    props.onDone();
  }

  return (
    <div className="screen editor">
      <h1>Edit log entry</h1>
      <label>
        Eaten at
        <input type="datetime-local" value={eatenText} onChange={(e) => setEatenText(e.target.value)} />
      </label>
      <p>Window: {entry.window_name ?? 'none'}</p>
      <label>
        BG (mg/dL)
        <input inputMode="numeric" value={bgText} onChange={(e) => setBgText(e.target.value)} />
      </label>
      <h2>Items</h2>
      <ul className="list">
        {rows.map((row) => (
          <li key={row.id} data-testid="log-item" className="log-item">
            <span>
              {row.display_name} · {row.amount} {unitLabel(row.unit, data.portions.filter((p) => p.food_id === row.ref_id))}
            </span>
            <span>{formatCarbs(row.carbs_g)}</span>
          </li>
        ))}
      </ul>
      <button type="button" onClick={recalculate}>
        Recalculate from current meal
      </button>
      {message && <p role="status">{message}</p>}
      <p className="total" data-testid="entry-carbs">
        Total {formatCarbs(total)} carbs
      </p>
      <DoseCard estimate={estimate} hasItems={rows.length > 0} bg={bg} lastDoseAt={null} now={now()} />
      <label>
        Taken dose (u)
        <input inputMode="decimal" value={takenText} onChange={(e) => setTakenText(e.target.value)} />
      </label>
      <label>
        Notes
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {errors.length > 0 && (
        <ul role="alert" className="errors">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <div className="button-row">
        <button type="button" className="primary" onClick={() => void save()}>
          Save
        </button>
        <button type="button" onClick={props.onDone}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={() => void remove()}>
          {confirmDelete ? 'Tap again to delete' : 'Delete entry'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement the Log screen**

`web/src/screens/Log.tsx`:
```tsx
import type { LogItemData, Synced } from '@carbbook/core';
import { useState } from 'react';
import { useLogData } from '../app/hooks';
import { useServices } from '../app/services';
import { LogEntryEditor } from '../log/LogEntryEditor';
import { dayKey, dayRange, formatCarbs, formatTime, formatUnits, shiftDay } from '../ui/format';

export function Log() {
  const { now } = useServices();
  const log = useLogData();
  const [day, setDay] = useState(() => dayKey(now()));
  const [editing, setEditing] = useState<string | null>(null);

  if (editing) return <LogEntryEditor entryId={editing} onDone={() => setEditing(null)} />;
  if (!log) return <p>Loading…</p>;

  const [start, end] = dayRange(day);
  const entries = log.entries.filter((e) => e.eaten_at >= start && e.eaten_at < end).sort((a, b) => a.eaten_at - b.eaten_at);
  const itemsByEntry = new Map<string, Synced<LogItemData>[]>();
  for (const item of log.items) itemsByEntry.set(item.log_entry_id, [...(itemsByEntry.get(item.log_entry_id) ?? []), item]);
  const totalCarbs = entries.reduce((sum, e) => sum + e.total_carbs_g, 0);
  const totalTaken = entries.reduce((sum, e) => sum + (e.taken_units ?? 0), 0);

  return (
    <div className="screen">
      <h1>Log</h1>
      <div className="day-nav">
        <button type="button" aria-label="Previous day" onClick={() => setDay(shiftDay(day, -1))}>
          ‹
        </button>
        <input type="date" aria-label="Day" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
        <button type="button" aria-label="Next day" onClick={() => setDay(shiftDay(day, 1))}>
          ›
        </button>
      </div>
      <p className="total" data-testid="day-totals">
        {formatCarbs(totalCarbs)} carbs · {formatUnits(totalTaken)} taken
      </p>
      {entries.length === 0 && <p className="muted">Nothing logged this day.</p>}
      <ul className="list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <button type="button" className="list-item" onClick={() => setEditing(entry.id)}>
              <span>
                <strong>{formatTime(entry.eaten_at)}</strong> {entry.window_name ?? ''}
              </span>
              <span>
                {formatCarbs(entry.total_carbs_g)} carbs · BG {entry.bg_mgdl ?? '–'} · est.{' '}
                {entry.suggested_units == null ? '–' : formatUnits(entry.suggested_units)} · took{' '}
                {entry.taken_units == null ? '–' : formatUnits(entry.taken_units)}
              </span>
              <span className="muted">{(itemsByEntry.get(entry.id) ?? []).map((i) => i.display_name).join(', ')}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 5: Run the test and typecheck**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/log.test.tsx && pnpm typecheck`
Expected: `Tests  3 passed (3)`, then `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/log web/src/screens/Log.tsx web/test/log.test.tsx
git commit -m "feat(web): daily log with totals, entry editing and recalculate from current data"
```

---

### Task 9: Settings

**Files:**
- Create: `web/src/settings/DoseSettingsEditor.tsx`, `web/src/screens/Settings.tsx`
- Test: `web/test/settings.test.tsx`

- [ ] **Step 1: Write the failing test**

`web/test/settings.test.tsx`:
```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { setMeta } from '../src/db/meta';
import { ApiError } from '../src/lib/api';
import { Settings } from '../src/screens/Settings';
import { makeServices, NOW, renderWith, SEED_SETTINGS, seedSettings, type TestServices, VIEWER } from './render';

let services: TestServices;
afterEach(async () => {
  await services.db.delete();
});

describe('Settings', () => {
  it('saves edited dose settings as a new version', async () => {
    services = makeServices();
    await seedSettings(services.db);
    const user = userEvent.setup();
    renderWith(<Settings />, services);
    await user.click(await screen.findByRole('button', { name: 'Edit dose settings' }));
    const ratio = screen.getByLabelText('Window 3 carb ratio (g per unit)');
    await user.clear(ratio);
    await user.type(ratio, '9');
    await user.click(screen.getByRole('button', { name: 'Save as new version' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Saved a new dose settings version.');
    await waitFor(async () => expect(await services.db.dose_settings.count()).toBe(2));
    const created = (await services.db.dose_settings.toArray()).find((v) => v.id !== SEED_SETTINGS.id)!;
    expect(created.effective_from).toBe(NOW);
    expect(created.windows.find((w) => w.name === 'Lunch')?.ratio_g_per_unit).toBe(9);
    expect(await services.db.dose_settings.get(SEED_SETTINGS.id)).toMatchObject({ updated_by: 'server' });
    expect(await screen.findAllByTestId('settings-version')).toHaveLength(2);
  });

  it('shows validation errors and saves nothing', async () => {
    services = makeServices();
    await seedSettings(services.db);
    const user = userEvent.setup();
    renderWith(<Settings />, services);
    await user.click(await screen.findByRole('button', { name: 'Edit dose settings' }));
    const step = screen.getByLabelText('Step (mg/dL)');
    await user.clear(step);
    await user.type(step, '0');
    await user.click(screen.getByRole('button', { name: 'Save as new version' }));
    expect(screen.getByRole('alert')).toHaveTextContent('correction step (> 0)');
    expect(await services.db.dose_settings.count()).toBe(1);
  });

  it('is read-only for viewers', async () => {
    services = makeServices({ user: VIEWER });
    await seedSettings(services.db);
    renderWith(<Settings />, services);
    expect(await screen.findByText('Only the owner can change dose settings.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit dose settings' })).not.toBeInTheDocument();
    expect(await screen.findAllByTestId('settings-version')).toHaveLength(1);
  });

  it('shows pending count, last sync and server rejections', async () => {
    services = makeServices();
    await services.db.outbox.bulkPut([
      { key: 'food:f1', table: 'food', id: 'f1', updated_at: 1 },
      { key: 'meal:m1', table: 'meal', id: 'm1', updated_at: 1 },
    ]);
    await setMeta(services.db, 'last_synced_at', NOW);
    await services.db.sync_error.put({ key: 'food:f2', table: 'food', id: 'f2', reason: 'invalid', message: 'carbs_per_100g must be >= 0', at: NOW });
    const user = userEvent.setup();
    renderWith(<Settings />, services);
    // Live queries resolve after the first render, so wait for the values rather than the elements.
    expect(await screen.findByText('2 pending changes')).toHaveAttribute('data-testid', 'pending-count');
    expect(await screen.findByText('Last synced: 2026-09-14 12:00')).toHaveAttribute('data-testid', 'last-synced');
    expect(await screen.findByText('food f2: carbs_per_100g must be >= 0')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(async () => expect(await services.db.sync_error.count()).toBe(0));
  });

  it('reports when the server has no USDA library', async () => {
    services = makeServices();
    services.api.on('GET', '/api/usda/manifest', () => {
      throw new ApiError(404, 'usda_not_imported', 'Run `carbbook import-usda` on the server first');
    });
    const user = userEvent.setup();
    renderWith(<Settings />, services);
    await user.click(await screen.findByRole('button', { name: 'Check for USDA update' }));
    expect(await screen.findByText('The server has no USDA library yet.')).toBeInTheDocument();
  });

  it('warns about unsynced changes before signing out', async () => {
    services = makeServices();
    await services.db.outbox.put({ key: 'food:f1', table: 'food', id: 'f1', updated_at: 1 });
    const user = userEvent.setup();
    renderWith(<Settings />, services);
    await screen.findByText('1 pending change');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByRole('alert')).toHaveTextContent('1 pending change will stay on this device');
    expect(services.signOuts).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(services.signOuts).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/settings.test.tsx`
Expected: FAIL — `Error: Failed to resolve import "../src/screens/Settings" from "test/settings.test.tsx". Does the file exist?`

- [ ] **Step 3: Implement the dose settings editor**

`web/src/settings/DoseSettingsEditor.tsx`:
```tsx
import { type CorrectionMode, type DoseSettingsData, parseHHMM } from '@carbbook/core';
import { useState } from 'react';
import { useServices } from '../app/services';
import { validateDoseSettings } from '../dose/dose';
import { uuidv7 } from '../lib/ids';
import { fromDateTimeLocal, toDateTimeLocal } from '../ui/format';

interface WindowDraft {
  key: string;
  name: string;
  start: string;
  ratio: string;
}

const numText = (n: number | null) => (n !== null && Number.isFinite(n) ? String(n) : '');
const num = (text: string) => (text.trim() === '' ? Number.NaN : Number(text));

/**
 * Edits a copy of a version and always saves a NEW dose_settings record (new id + effective
 * date): versions are append-only on the server.
 */
export function DoseSettingsEditor(props: { initial: DoseSettingsData; onDone: (saved: boolean) => void }) {
  const { initial } = props;
  const { store, now } = useServices();
  const [windows, setWindows] = useState<WindowDraft[]>(() =>
    initial.windows.map((w) => ({ key: uuidv7(), name: w.name, start: w.start, ratio: numText(w.ratio_g_per_unit) })),
  );
  const [threshold, setThreshold] = useState(numText(initial.correction.threshold));
  const [step, setStep] = useState(numText(initial.correction.step));
  const [unitsPerStep, setUnitsPerStep] = useState(numText(initial.correction.units_per_step));
  const [mode, setMode] = useState<CorrectionMode>(initial.correction.mode);
  const [increment, setIncrement] = useState(numText(initial.rounding.increment));
  const [roundDown, setRoundDown] = useState(numText(initial.rounding.round_down_below_bg));
  const [effectiveText, setEffectiveText] = useState(() => toDateTimeLocal(now()));
  const [errors, setErrors] = useState<string[]>([]);

  const update = (key: string, patch: Partial<WindowDraft>) =>
    setWindows((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  async function save() {
    const draft: DoseSettingsData = {
      id: uuidv7(now()),
      effective_from: fromDateTimeLocal(effectiveText) ?? Number.NaN,
      windows: windows.map((w) => ({ name: w.name.trim(), start: w.start, ratio_g_per_unit: num(w.ratio) })),
      correction: { threshold: num(threshold), step: num(step), units_per_step: num(unitsPerStep), mode },
      rounding: { increment: num(increment), round_down_below_bg: roundDown.trim() === '' ? null : num(roundDown) },
    };
    const problems = validateDoseSettings(draft);
    if (!Number.isFinite(draft.effective_from)) problems.push('Enter when these settings take effect.');
    setErrors(problems);
    if (problems.length > 0) return;
    draft.windows.sort((a, b) => parseHHMM(a.start) - parseHHMM(b.start));
    await store.save('dose_settings', draft);
    props.onDone(true);
  }

  return (
    <form
      aria-label="Dose settings editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>Time windows</h3>
      {windows.map((w, i) => (
        <div className="window-row" key={w.key}>
          <input aria-label={`Window ${i + 1} name`} value={w.name} onChange={(e) => update(w.key, { name: e.target.value })} />
          <input type="time" aria-label={`Window ${i + 1} start`} value={w.start} onChange={(e) => update(w.key, { start: e.target.value })} />
          <input
            aria-label={`Window ${i + 1} carb ratio (g per unit)`}
            inputMode="decimal"
            value={w.ratio}
            onChange={(e) => update(w.key, { ratio: e.target.value })}
          />
          <button type="button" aria-label={`Remove window ${i + 1}`} onClick={() => setWindows((rows) => rows.filter((r) => r.key !== w.key))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setWindows((rows) => [...rows, { key: uuidv7(), name: '', start: '12:00', ratio: '' }])}>
        Add window
      </button>
      <h3>Correction</h3>
      <label>
        Threshold (mg/dL)
        <input inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
      </label>
      <label>
        Step (mg/dL)
        <input inputMode="numeric" value={step} onChange={(e) => setStep(e.target.value)} />
      </label>
      <label>
        Units per step
        <input inputMode="decimal" value={unitsPerStep} onChange={(e) => setUnitsPerStep(e.target.value)} />
      </label>
      <label>
        Mode
        <select value={mode} onChange={(e) => setMode(e.target.value as CorrectionMode)}>
          <option value="started">Started steps (round up)</option>
          <option value="full">Full steps only (round down)</option>
          <option value="proportional">Proportional</option>
        </select>
      </label>
      <h3>Rounding</h3>
      <label>
        Round to increment (u)
        <input inputMode="decimal" value={increment} onChange={(e) => setIncrement(e.target.value)} />
      </label>
      <label>
        Round down when BG is below (mg/dL, optional)
        <input inputMode="numeric" value={roundDown} onChange={(e) => setRoundDown(e.target.value)} />
      </label>
      <label>
        Takes effect
        <input type="datetime-local" value={effectiveText} onChange={(e) => setEffectiveText(e.target.value)} />
      </label>
      {errors.length > 0 && (
        <ul role="alert" className="errors">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <div className="button-row">
        <button type="submit" className="primary">
          Save as new version
        </button>
        <button type="button" onClick={() => props.onDone(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 4: Implement the Settings screen**

`web/src/screens/Settings.tsx`:
```tsx
import { activeSettings, type DoseSettingsData } from '@carbbook/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState, useSyncExternalStore } from 'react';
import { useDoseVersions } from '../app/hooks';
import { useServices } from '../app/services';
import { getMeta } from '../db/meta';
import { NetworkError } from '../lib/api';
import { DoseSettingsEditor } from '../settings/DoseSettingsEditor';
import type { SyncPhase } from '../sync/engine';
import { dayKey, formatTime } from '../ui/format';
import { syncUsdaLibrary } from '../usda/bundle';

export const PHASE_TEXT: Record<SyncPhase, string> = {
  idle: 'Up to date',
  syncing: 'Syncing…',
  offline: 'Offline: changes sync when you reconnect',
  error: 'Sync failed; retrying automatically',
  signed_out: 'Signed out: sign in again to sync',
};

export const pendingText = (n: number) => `${n} pending change${n === 1 ? '' : 's'}`;
const when = (ms: number) => `${dayKey(ms)} ${formatTime(ms)}`;

const BLANK_SETTINGS: DoseSettingsData = {
  id: '',
  effective_from: 0,
  windows: [],
  correction: { threshold: Number.NaN, step: Number.NaN, units_per_step: Number.NaN, mode: 'started' },
  rounding: { increment: Number.NaN, round_down_below_bg: null },
};

function DoseSettingsSection() {
  const { user, now } = useServices();
  const versions = useDoseVersions();
  const [draft, setDraft] = useState<DoseSettingsData | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (!versions) return <p>Loading…</p>;
  const active = activeSettings(versions, now());
  const canEdit = user.role === 'owner';
  const sorted = [...versions].sort((a, b) => b.effective_from - a.effective_from);

  return (
    <section className="card" aria-label="Dose settings">
      <h2>Dose settings</h2>
      {message && <p role="status">{message}</p>}
      {!canEdit && <p className="note">Only the owner can change dose settings.</p>}
      {draft ? (
        <DoseSettingsEditor
          initial={draft}
          onDone={(saved) => {
            setDraft(null);
            setMessage(saved ? 'Saved a new dose settings version.' : null);
          }}
        />
      ) : (
        canEdit && (
          <button
            type="button"
            className="primary"
            onClick={() => {
              setMessage(null);
              setDraft(active ?? BLANK_SETTINGS);
            }}
          >
            Edit dose settings
          </button>
        )
      )}
      <h3>Version history</h3>
      <ul className="list">
        {sorted.map((v) => (
          <li key={v.id} className="version" data-testid="settings-version">
            <p>
              <strong>From {when(v.effective_from)}</strong> {v.id === active?.id && <span className="tag">active</span>}
            </p>
            <p className="muted">{v.windows.map((w) => `${w.name} ${w.start} 1:${w.ratio_g_per_unit}`).join(' · ')}</p>
            <p className="muted">
              Correction above {v.correction.threshold}: {v.correction.units_per_step} u per {v.correction.step} mg/dL ({v.correction.mode});
              round to {v.rounding.increment} u{v.rounding.round_down_below_bg == null ? '' : `, down below BG ${v.rounding.round_down_below_bg}`}
            </p>
            {canEdit && !draft && (
              <button type="button" onClick={() => setDraft(v)}>
                Start a new version from this
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SyncSection() {
  const { db, engine } = useServices();
  const status = useSyncExternalStore(engine.subscribe, engine.getStatus);
  const pending = useLiveQuery(() => db.outbox.count(), [db]) ?? 0;
  const lastSynced = useLiveQuery(() => getMeta(db, 'last_synced_at'), [db]);
  const errors = useLiveQuery(() => db.sync_error.orderBy('at').reverse().toArray(), [db]) ?? [];
  return (
    <section className="card" aria-label="Sync">
      <h2>Sync</h2>
      <p data-testid="sync-phase">{PHASE_TEXT[status.phase]}</p>
      {status.error && <p role="alert">{status.error}</p>}
      <p data-testid="pending-count">{pendingText(pending)}</p>
      <p data-testid="last-synced">Last synced: {lastSynced ? when(lastSynced) : 'never'}</p>
      <button type="button" onClick={() => void engine.syncNow()}>
        Sync now
      </button>
      {errors.length > 0 && (
        <>
          <h3>Rejected by the server</h3>
          <p className="note">These changes were not saved on the server. Edit the item to try again.</p>
          <ul className="list">
            {errors.map((error) => (
              <li key={error.key} className="pending-row">
                <span>
                  {error.table} {error.id}: {error.message}
                </span>
                <button type="button" onClick={() => void db.sync_error.delete(error.key)}>
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function LibrarySection() {
  const { db, api } = useServices();
  const version = useLiveQuery(() => getMeta(db, 'usda_version'), [db]);
  const count = useLiveQuery(() => db.usda_food.count(), [db]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check() {
    setBusy(true);
    try {
      const result = await syncUsdaLibrary(db, api);
      if (result.status === 'not_imported') setMessage('The server has no USDA library yet.');
      else if (result.status === 'up_to_date') setMessage('USDA library is up to date.');
      else setMessage(`Downloaded USDA library ${result.version} (${result.food_count} foods).`);
    } catch (error) {
      setMessage(error instanceof NetworkError ? 'Offline: try again when connected.' : error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-label="USDA library">
      <h2>USDA library</h2>
      <p>{version ? `${version} · ${count ?? 0} foods on this device` : 'Not downloaded yet'}</p>
      <button type="button" disabled={busy} onClick={() => void check()}>
        Check for USDA update
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}

function AccountSection() {
  const { db, user, signOut } = useServices();
  const pending = useLiveQuery(() => db.outbox.count(), [db]) ?? 0;
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSignOut() {
    if (pending > 0 && !confirming) {
      setConfirming(true);
      return;
    }
    try {
      await signOut();
    } catch (e) {
      setError(`Sign out failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <section className="card" aria-label="Account">
      <h2>Account</h2>
      <p>
        Signed in as <strong>{user.username}</strong> ({user.role})
      </p>
      {confirming && (
        <p role="alert">
          {pendingText(pending)} will stay on this device and sync after you sign in again. Tap Sign out again to continue.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button type="button" className="danger" onClick={() => void onSignOut()}>
        Sign out
      </button>
    </section>
  );
}

export function Settings() {
  return (
    <div className="screen">
      <h1>Settings</h1>
      <DoseSettingsSection />
      <SyncSection />
      <LibrarySection />
      <AccountSection />
    </div>
  );
}
```

- [ ] **Step 5: Run the test and typecheck**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/settings.test.tsx && pnpm typecheck`
Expected: `Tests  6 passed (6)`, then `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/settings web/src/screens/Settings.tsx web/test/settings.test.tsx
git commit -m "feat(web): settings with dose-settings versions, sync status, USDA library, sign out"
```

---

### Task 10: App shell, login and entry point

**Files:**
- Create: `web/src/app/Login.tsx`, `web/src/app/Shell.tsx`, `web/src/App.tsx`, `web/src/main.tsx`, `web/src/styles.css`, `web/index.html`
- Test: `web/test/app.test.tsx`

- [ ] **Step 1: Write the failing test**

`web/test/app.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import type { CarbBookDb } from '../src/db/db';
import { setMeta } from '../src/db/meta';
import { createStore } from '../src/db/store';
import { ApiError, NetworkError } from '../src/lib/api';
import { SIGNED_OUT_MESSAGE } from '../src/sync/engine';
import { FakeApi, foodData, openTestDb } from './helpers';
import { noScanner, OWNER } from './render';

let db: CarbBookDb;
afterEach(async () => {
  window.history.replaceState(null, '', '/');
  await db.delete();
});

function serverApi() {
  return new FakeApi()
    .on('GET', '/api/sync/pull', () => ({ changes: [], next_since: 0, has_more: false }))
    .on('GET', '/api/usda/manifest', () => {
      throw new ApiError(404, 'usda_not_imported', 'not imported');
    })
    .on('GET', '/api/bg', () => {
      throw new ApiError(503, 'bg_unavailable', 'dexcom-api unreachable');
    });
}

describe('App', () => {
  it('signs in, then navigates between screens', async () => {
    db = openTestDb();
    const api = serverApi()
      .on('GET', '/api/auth/me', () => {
        throw new ApiError(401, 'unauthorized', 'Sign in required');
      })
      .on('POST', '/api/auth/login', () => ({ user: OWNER }));
    const user = userEvent.setup();
    render(<App db={db} api={api} startScanner={noScanner} />);
    await user.type(await screen.findByLabelText('Username'), 'brett');
    await user.type(screen.getByLabelText('Password'), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Calculator' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Foods' }));
    expect(await screen.findByRole('heading', { name: 'Foods' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/foods');
    await waitFor(() => expect(api.calls.some((c) => c.path.startsWith('/api/sync/pull'))).toBe(true));
  });

  it('shows login errors', async () => {
    db = openTestDb();
    const api = serverApi()
      .on('GET', '/api/auth/me', () => {
        throw new ApiError(401, 'unauthorized', 'Sign in required');
      })
      .on('POST', '/api/auth/login', () => {
        throw new ApiError(401, 'invalid_credentials', 'Wrong username or password');
      });
    const user = userEvent.setup();
    render(<App db={db} api={api} startScanner={noScanner} />);
    await user.type(await screen.findByLabelText('Username'), 'brett');
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong username or password');
  });

  it('opens offline with the last signed-in user', async () => {
    db = openTestDb();
    await setMeta(db, 'user', OWNER);
    const offline = () => {
      throw new NetworkError('Failed to fetch');
    };
    const api = new FakeApi().on('GET', '/api/auth/me', offline).on('GET', '/api/sync/pull', offline).on('GET', '/api/bg', offline);
    render(<App db={db} api={api} startScanner={noScanner} />);
    expect(await screen.findByRole('heading', { name: 'Calculator' })).toBeInTheDocument();
    expect(await screen.findByText('Offline: enter BG manually.')).toBeInTheDocument();
  });

  it('returns to the login screen when the session expires, keeping unsynced changes', async () => {
    db = openTestDb();
    await createStore(db, 'device-a').save('food', foodData({ id: 'f1' }));
    const api = serverApi()
      .on('GET', '/api/auth/me', () => ({ user: OWNER }))
      .on('POST', '/api/sync/push', () => {
        throw new ApiError(401, 'unauthorized', 'Session expired or revoked');
      });
    render(<App db={db} api={api} startScanner={noScanner} />);
    expect(await screen.findByText(SIGNED_OUT_MESSAGE)).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(await db.outbox.count()).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/app.test.tsx`
Expected: FAIL — `Error: Failed to resolve import "../src/App" from "test/app.test.tsx". Does the file exist?`

- [ ] **Step 3: Implement the login form**

`web/src/app/Login.tsx`:
```tsx
import { useState } from 'react';
import { login, loginErrorMessage } from '../auth/session';
import type { CarbBookDb } from '../db/db';
import type { Api } from '../lib/api';
import type { User } from '../lib/wire';

export function Login(props: { db: CarbBookDb; api: Api; message: string | null; onSignedIn: (user: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      props.onSignedIn(await login(props.db, props.api, username.trim(), password));
    } catch (e) {
      setError(loginErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <h1>CarbBook</h1>
      {props.message && <p className="note">{props.message}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          Username
          <input autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={busy || !username.trim() || !password}>
          Sign in
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 4: Implement the shell and routes**

`web/src/app/Shell.tsx`:
```tsx
import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Calculator } from '../screens/Calculator';
import { Foods } from '../screens/Foods';
import { Log } from '../screens/Log';
import { Meals } from '../screens/Meals';
import { Settings } from '../screens/Settings';
import type { SyncPhase } from '../sync/engine';
import { useServices } from './services';

interface Route {
  path: string;
  label: string;
  render: () => ReactNode;
}

export const ROUTES: Route[] = [
  { path: '/', label: 'Calculator', render: () => <Calculator /> },
  { path: '/foods', label: 'Foods', render: () => <Foods /> },
  { path: '/meals', label: 'Meals', render: () => <Meals /> },
  { path: '/log', label: 'Log', render: () => <Log /> },
  { path: '/settings', label: 'Settings', render: () => <Settings /> },
];

export function routeFor(pathname: string): Route {
  return ROUTES.find((r) => r.path !== '/' && (pathname === r.path || pathname.startsWith(`${r.path}/`))) ?? ROUTES[0]!;
}

/** Minimal history-API router; the server falls back to index.html for these paths. */
function usePath(): [string, (path: string) => void] {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((next: string) => {
    if (next !== window.location.pathname) window.history.pushState(null, '', next);
    setPath(next);
  }, []);
  return [path, navigate];
}

const BADGE: Record<SyncPhase, string> = { idle: '', syncing: 'Syncing…', offline: 'Offline', error: 'Sync error', signed_out: 'Signed out' };

export function Shell() {
  const { db, engine } = useServices();
  const status = useSyncExternalStore(engine.subscribe, engine.getStatus);
  const pending = useLiveQuery(() => db.outbox.count(), [db]) ?? 0;
  const [path, navigate] = usePath();
  const route = routeFor(path);
  const badge = [BADGE[status.phase], pending > 0 ? `${pending} pending` : ''].filter(Boolean).join(' · ');

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">CarbBook</span>
        <span data-testid="sync-badge">{badge}</span>
      </header>
      <main>{route.render()}</main>
      <nav className="tabbar" aria-label="Main">
        {ROUTES.map((r) => (
          <a
            key={r.path}
            href={r.path}
            aria-current={r === route ? 'page' : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate(r.path);
            }}
          >
            {r.label}
          </a>
        ))}
      </nav>
    </div>
  );
}
```

- [ ] **Step 5: Implement the app**

`web/src/App.tsx`:
```tsx
import { useEffect, useMemo, useState } from 'react';
import { Login } from './app/Login';
import { type Services, ServicesProvider } from './app/services';
import { Shell } from './app/Shell';
import { logout, restoreSession, type Session } from './auth/session';
import { type StartScanner, startScanner as browserScanner } from './barcode/scanner';
import type { CarbBookDb } from './db/db';
import { getDeviceId } from './db/meta';
import { createStore } from './db/store';
import type { Api } from './lib/api';
import { SIGNED_OUT_MESSAGE, SyncEngine } from './sync/engine';
import { syncOnce } from './sync/sync';
import { syncUsdaLibrary } from './usda/bundle';

type Boot = { phase: 'loading' } | { phase: 'ready'; deviceId: string; session: Session };

export function App(props: { db: CarbBookDb; api: Api; startScanner?: StartScanner }) {
  const { db, api } = props;
  const startScanner = props.startScanner ?? browserScanner;
  const [boot, setBoot] = useState<Boot>({ phase: 'loading' });
  const signOutLocally = () => setBoot((b) => (b.phase === 'ready' ? { ...b, session: { status: 'signed_out' } } : b));

  // Auth expiry keeps IndexedDB (and the outbox) intact and just shows the login screen (spec §9).
  const engine = useMemo(() => new SyncEngine({ run: () => syncOnce(db, api), onAuthExpired: signOutLocally }), [db, api]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const deviceId = await getDeviceId(db);
      const session = await restoreSession(db, api);
      if (!cancelled) setBoot({ phase: 'ready', deviceId, session });
    })();
    return () => {
      cancelled = true;
    };
  }, [db, api]);

  const deviceId = boot.phase === 'ready' ? boot.deviceId : null;
  const user = boot.phase === 'ready' && boot.session.status === 'signed_in' ? boot.session.user : null;
  const userId = user?.id ?? null;

  useEffect(() => {
    if (userId === null) return;
    engine.resume();
    engine.start();
    syncUsdaLibrary(db, api).catch((error: unknown) => console.warn('USDA library update failed', error));
    return () => engine.stop();
  }, [userId, engine, db, api]);

  const store = useMemo(() => (deviceId ? createStore(db, deviceId, { onWrite: engine.requestSync }) : null), [db, deviceId, engine]);

  const services = useMemo<Services | null>(
    () =>
      store && user
        ? {
            db,
            api,
            store,
            engine,
            user,
            now: Date.now,
            startScanner,
            signOut: async () => {
              await logout(db, api);
              engine.stop();
              signOutLocally();
            },
          }
        : null,
    [db, api, store, engine, user, startScanner],
  );

  if (boot.phase === 'loading' || !store) return <p className="boot">Loading CarbBook…</p>;
  if (!services) {
    return (
      <Login
        db={db}
        api={api}
        message={engine.getStatus().phase === 'signed_out' ? SIGNED_OUT_MESSAGE : null}
        onSignedIn={(signedIn) =>
          setBoot((b) => (b.phase === 'ready' ? { ...b, session: { status: 'signed_in', user: signedIn, offline: false } } : b))
        }
      />
    );
  }
  return (
    <ServicesProvider services={services}>
      <Shell />
    </ServicesProvider>
  );
}
```

- [ ] **Step 6: Add the entry point, HTML and styles**

`web/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { CarbBookDb } from './db/db';
import { createApi } from './lib/api';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App db={new CarbBookDb()} api={createApi()} />
  </StrictMode>,
);
```

`web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#1b5e20" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <title>CarbBook</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/styles.css`:
```css
:root {
  --bg: #f6f7f4;
  --card: #ffffff;
  --text: #1c2419;
  --muted: #5d6b59;
  --accent: #1b5e20;
  --accent-soft: #e8f5e9;
  --accent-text: #ffffff;
  --danger: #b3261e;
  --warn: #8a4b00;
  --warn-bg: #fff4e5;
  --border: #d7ddd3;
  --radius: 12px;
  --tap: 48px;
  color-scheme: light;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-size: 17px;
  line-height: 1.4;
}

.app {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: max(8px, env(safe-area-inset-top)) 16px 8px;
  background: var(--accent);
  color: var(--accent-text);
}

.brand {
  font-weight: 700;
}

main {
  flex: 1;
  width: 100%;
  max-width: 640px;
  margin: 0 auto;
  padding: 0 16px calc(var(--tap) + 32px);
}

.tabbar {
  position: fixed;
  inset: auto 0 0 0;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  background: var(--card);
  border-top: 1px solid var(--border);
  padding-bottom: env(safe-area-inset-bottom);
}

.tabbar a {
  min-height: var(--tap);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: var(--muted);
  text-decoration: none;
}

.tabbar a[aria-current='page'] {
  color: var(--accent);
  font-weight: 700;
}

h1 {
  font-size: 24px;
  margin: 16px 0 8px;
}

h2 {
  font-size: 19px;
  margin: 12px 0 8px;
}

h3 {
  font-size: 16px;
  margin: 12px 0 4px;
}

label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0;
  font-size: 15px;
  font-weight: 600;
}

label.inline {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  font-weight: 400;
}

input,
select,
textarea,
button {
  font: inherit;
  min-height: var(--tap);
  border-radius: 10px;
}

input,
select,
textarea {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  background: #fff;
  color: var(--text);
}

input[type='radio'] {
  width: 24px;
  min-height: 24px;
}

textarea {
  min-height: 88px;
}

button {
  padding: 8px 16px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text);
  cursor: pointer;
}

button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
  font-weight: 700;
}

button.danger {
  color: var(--danger);
  border-color: var(--danger);
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}

.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}

.card,
fieldset {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 16px;
  margin: 12px 0;
}

.muted,
.note {
  color: var(--muted);
}

.note {
  font-size: 15px;
}

.message {
  background: var(--accent-soft);
  border-radius: 10px;
  padding: 8px 12px;
}

[role='alert'],
.warning {
  color: var(--warn);
}

.warning,
.errors {
  background: var(--warn-bg);
  border-radius: 10px;
  padding: 8px 12px;
}

.errors {
  padding-left: 28px;
}

.search-bar {
  display: flex;
  gap: 8px;
}

.results,
.list,
.items {
  list-style: none;
  padding: 0;
  margin: 8px 0;
}

.result,
.list-item {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  margin: 4px 0;
  text-align: left;
}

.result-meta {
  font-size: 14px;
  color: var(--muted);
}

.item-row {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 12px;
  margin: 8px 0;
}

.item-name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.flag {
  display: inline-block;
  font-size: 13px;
  font-weight: 700;
  color: var(--warn);
  background: var(--warn-bg);
  border-radius: 999px;
  padding: 2px 8px;
  margin: 4px 0;
}

.item-controls {
  display: grid;
  grid-template-columns: 5.5rem 1fr auto auto;
  gap: 8px;
  align-items: center;
  margin-top: 6px;
}

.item-controls output {
  min-width: 4rem;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.item-controls button {
  padding: 8px 12px;
}

.total {
  font-size: 19px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.dose-units {
  font-size: 32px;
  font-weight: 800;
  margin: 4px 0;
}

.tag {
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 999px;
  padding: 2px 8px;
  vertical-align: middle;
}

.breakdown {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 15px;
  overflow-wrap: anywhere;
}

.fineprint {
  font-size: 13px;
  color: var(--muted);
}

.portion-row,
.window-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin: 8px 0;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

.day-nav {
  display: grid;
  grid-template-columns: var(--tap) 1fr var(--tap);
  gap: 8px;
  align-items: center;
}

.pending-row,
.log-item {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
}

.overlay {
  position: fixed;
  inset: 0;
  z-index: 10;
  overflow: auto;
  padding: 16px;
  background: rgba(0, 0, 0, 0.88);
  color: #fff;
}

.overlay label,
.overlay [role='alert'] {
  color: #fff;
}

.scanner-video {
  width: 100%;
  max-height: 50dvh;
  object-fit: cover;
  background: #000;
  border-radius: var(--radius);
}

.login,
.boot {
  max-width: 420px;
  margin: 0 auto;
  padding: 32px 16px;
}

@media (min-width: 600px) {
  .item-controls {
    grid-template-columns: 7rem 1fr auto auto auto auto;
  }
}
```

- [ ] **Step 7: Run the test, the full suite and typecheck**

Run: `cd ~/Projects/CarbBook/web && pnpm exec vitest run test/app.test.tsx && pnpm test && pnpm typecheck`
Expected: `Tests  4 passed (4)`; the full run reports `Test Files  23 passed (23)` and `Tests  120 passed (120)`; `tsc` exits 0.

- [ ] **Step 8: Commit**

```bash
cd ~/Projects/CarbBook
git add web/src/app/Login.tsx web/src/app/Shell.tsx web/src/App.tsx web/src/main.tsx web/src/styles.css web/index.html web/test/app.test.tsx
git commit -m "feat(web): app shell with login gate, sync lifecycle and tab navigation"
```

---

### Task 11: Installable offline PWA

**Files:**
- Modify: `web/vite.config.ts` (full replacement)
- Create: `web/scripts/make-icons.mjs`, `web/public/icon.svg`, `web/public/icon-192.png`, `web/public/icon-512.png`, `web/public/apple-touch-icon.png` (generated)

- [ ] **Step 1: Add the icons**

`web/public/icon.svg`:
```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#1b5e20"/>
  <circle cx="50" cy="50" r="27" fill="none" stroke="#fff" stroke-width="6"/>
  <path d="M50 50 V26 A24 24 0 0 1 74 50 Z" fill="#a5d6a7"/>
</svg>
```

`web/scripts/make-icons.mjs`:
```js
// Writes the PWA PNG icons into public/ with no image dependencies: a white plate ring with a
// light-green slice on the brand green, drawn inside the 80% maskable safe zone.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const GREEN = [27, 94, 32, 255];
const WHITE = [255, 255, 255, 255];
const LIGHT = [165, 214, 167, 255];

function pixel(u, v) {
  const dx = u - 0.5;
  const dy = v - 0.5;
  const r = Math.hypot(dx, dy);
  if (r > 0.24 && r < 0.3) return WHITE;
  if (r <= 0.24 && dx > 0 && dy < 0) return LIGHT;
  return GREEN;
}

function png(size) {
  const row = size * 4 + 1;
  const raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y++) {
    raw[y * row] = 0; // filter: none
    for (let x = 0; x < size; x++) raw.set(pixel((x + 0.5) / size, (y + 0.5) / size), y * row + 1 + x * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = new URL('../public/', import.meta.url);
mkdirSync(out, { recursive: true });
for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  writeFileSync(new URL(name, out), png(size));
  console.log(`wrote public/${name} (${size}x${size})`);
}
```

Run: `cd ~/Projects/CarbBook/web && node scripts/make-icons.mjs && file public/*.png`
Expected:
```
wrote public/icon-192.png (192x192)
wrote public/icon-512.png (512x512)
wrote public/apple-touch-icon.png (180x180)
public/apple-touch-icon.png: PNG image data, 180 x 180, 8-bit/color RGBA, non-interlaced
public/icon-192.png:         PNG image data, 192 x 192, 8-bit/color RGBA, non-interlaced
public/icon-512.png:         PNG image data, 512 x 512, 8-bit/color RGBA, non-interlaced
```

- [ ] **Step 2: Build before adding the plugin to see the failing check**

Run: `cd ~/Projects/CarbBook/web && pnpm build >/dev/null && ls dist/sw.js`
Expected: FAIL — `ls: cannot access 'dist/sw.js': No such file or directory`

- [ ] **Step 3: Add the PWA plugin**

Replace `web/vite.config.ts` with:
```ts
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // New builds activate on the next load; the server sends index.html with Cache-Control: no-cache.
      registerType: 'autoUpdate',
      injectRegister: 'script',
      manifest: {
        name: 'CarbBook',
        short_name: 'CarbBook',
        description: 'Carb counter and insulin dose estimator',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f6f7f4',
        theme_color: '#1b5e20',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the app shell; the API is never cached (data lives in IndexedDB).
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: {
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
```

- [ ] **Step 4: Build and check the service worker and manifest**

Run:
```bash
cd ~/Projects/CarbBook/web && rm -rf dist && pnpm build 2>&1 | grep -E "precache|built in" \
&& grep -o '<link rel="manifest"[^>]*>\|<script id="vite-plugin-pwa:register-sw"[^>]*>' dist/index.html \
&& grep -o 'NavigationRoute([^;]*' dist/sw.js
```
Expected (hashes and sizes vary):
```
✓ built in …ms
precache  13 entries (… KiB)
<link rel="manifest" href="/manifest.webmanifest">
<script id="vite-plugin-pwa:register-sw" src="/registerSW.js">
NavigationRoute(e.createHandlerBoundToURL("/index.html"),{denylist:[/^\/api\//]}))})
```

- [ ] **Step 5: Unit tests still pass with the plugin loaded**

Run: `cd ~/Projects/CarbBook/web && pnpm test`
Expected: `Test Files  23 passed (23)`, `Tests  120 passed (120)`

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add web/vite.config.ts web/scripts/make-icons.mjs web/public
git commit -m "feat(web): installable PWA with precached app shell"
```

---

### Task 12: Playwright end-to-end test (spec §10)

**Files:**
- Create: `web/playwright.config.ts`, `web/e2e/start-server.mjs`, `web/e2e/carbbook.spec.ts`
- Modify: `.gitignore` (append two lines)

- [ ] **Step 1: Ignore Playwright output**

Append to `.gitignore`:
```
test-results/
playwright-report/
```

- [ ] **Step 2: Install the browser**

Run: `cd ~/Projects/CarbBook/web && pnpm exec playwright install chromium`
Expected: `Chromium … downloaded to …/ms-playwright/chromium-…` (nothing to do if already installed). On Arch Linux `--with-deps` is not supported; if the browser later fails to launch with a missing shared library, install that library with pacman.

- [ ] **Step 3: Add the config and server launcher**

`web/playwright.config.ts`:
```ts
import { defineConfig, devices } from '@playwright/test';

export const E2E_PORT = 3998;

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    ...devices['Pixel 7'],
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  webServer: {
    // Builds the PWA, then starts carbs-server on a throwaway database serving web/dist.
    command: 'pnpm build && node e2e/start-server.mjs',
    url: `http://127.0.0.1:${E2E_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
  },
});
```

`web/e2e/start-server.mjs`:
```js
// Starts carbs-server for Playwright: fresh temp database, owner "brett", USDA fixture library,
// the built PWA from web/dist. dexcom-api and Open Food Facts point at a closed port.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const serverDir = resolve(webDir, '../server');
const dataDir = mkdtempSync(join(tmpdir(), 'carbbook-e2e-'));

const env = {
  ...process.env,
  DATABASE_PATH: join(dataDir, 'carbbook.db'),
  USDA_DIR: join(dataDir, 'usda'),
  WEB_DIR: join(webDir, 'dist'),
  HOST: '127.0.0.1',
  PORT: '3998',
  COOKIE_SECURE: 'false',
  DEXCOM_API_URL: 'http://127.0.0.1:9',
  OFF_BASE_URL: 'http://127.0.0.1:9',
  CARBBOOK_PASSWORD: 'e2e password',
};

const carbbook = (...args) => execFileSync('pnpm', ['-s', 'carbbook', ...args], { cwd: serverDir, env, stdio: 'inherit' });
carbbook('user', 'add', 'brett', '--role', 'owner');
carbbook('import-usda', ...['foundation', 'sr_legacy', 'survey'].map((d) => join(serverDir, 'test/fixtures/usda', d)));

const server = spawn('pnpm', ['-s', 'start'], { cwd: serverDir, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code ?? 0));
```

- [ ] **Step 4: Write the test**

`web/e2e/carbbook.spec.ts`:
```ts
import { expect, test } from '@playwright/test';

const USERNAME = 'brett';
const PASSWORD = 'e2e password';
const PB = 'Peanut butter, smooth style, with salt';
const KALE = 'Kale, raw';

type Record = { [field: string]: unknown };

test('log, save and edit a meal, then log offline and sync on reconnect (spec §10)', async ({ page, context, playwright, baseURL }) => {
  // Login
  await page.goto('/');
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Calculator' })).toBeVisible();

  // Search the downloaded USDA library and add items with units
  await page.getByLabel('Search foods and meals').fill('peanut');
  await page.getByRole('button', { name: new RegExp(PB) }).click();
  await page.getByLabel(`Amount of ${PB}`).fill('10');
  await page.getByLabel(`Unit for ${PB}`).selectOption('tbsp');
  await page.getByLabel('Search foods and meals').fill('kale');
  await page.getByRole('button', { name: new RegExp(KALE) }).click();
  await page.getByLabel('BG (mg/dL)').fill('120');
  await expect(page.getByTestId('dose-breakdown')).toContainText('BG 120');
  await expect(page.getByText('estimate', { exact: true })).toBeVisible();

  // Save as meal, then log
  await page.getByRole('button', { name: 'Save as meal' }).click();
  await page.getByLabel('Meal name').fill('PB kale bowl');
  await page.getByLabel('Yield (servings)').fill('2');
  await page.getByRole('button', { name: 'Save meal' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved meal "PB kale bowl".');
  await page.getByRole('button', { name: 'Log it' }).click();
  await expect(page.getByRole('status')).toContainText('Logged 40.1 g carbs');

  // Edit the meal: 200 g kale → (35.68 + 8.84) / 2 = 22.3 g per serving
  await page.getByRole('link', { name: 'Meals' }).click();
  await page.getByRole('button', { name: /PB kale bowl/ }).click();
  await page.getByLabel(`Amount of ${KALE}`).fill('200');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: /PB kale bowl/ })).toContainText('22.3 g per serving');

  // Everything reaches the server
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('pending-count')).toHaveText('0 pending changes');

  // Offline: the service worker serves the app shell, logging still works
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Calculator' })).toBeVisible();
  await page.getByLabel('Search foods and meals').fill('PB kale');
  await page.getByRole('button', { name: /PB kale bowl/ }).click();
  await page.getByLabel('BG (mg/dL)').fill('180');
  await page.getByRole('button', { name: 'Log it' }).click();
  await expect(page.getByRole('status')).toContainText('Logged');
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('sync-phase')).toHaveText('Offline: changes sync when you reconnect');
  await expect(page.getByTestId('pending-count')).toHaveText('2 pending changes');

  // Reconnect: the engine syncs on the online event
  await context.setOffline(false);
  await expect(page.getByTestId('pending-count')).toHaveText('0 pending changes', { timeout: 15_000 });

  // Verify server state through the API
  const api = await playwright.request.newContext({ baseURL });
  expect((await api.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } })).ok()).toBe(true);
  const pull = (await (await api.get('/api/sync/pull?since=0&limit=1000')).json()) as { changes: { table: string; record: Record }[] };
  const rows = (table: string) => pull.changes.filter((c) => c.table === table).map((c) => c.record);

  expect(rows('log_entry').map((e) => e.bg_mgdl).sort()).toEqual([120, 180]);
  expect(rows('meal')).toEqual([expect.objectContaining({ name: 'PB kale bowl', yield_servings: 2, deleted: 0 })]);
  expect(rows('meal_item').find((i) => i.ref_id === 'usda-323505')).toMatchObject({ amount: 200, unit: 'g' });
  expect(rows('food').map((f) => f.id).sort()).toEqual(['usda-323505', 'usda-324860']);
  expect(rows('log_item').find((i) => i.ref_type === 'meal')).toMatchObject({ display_name: 'PB kale bowl', amount: 1, unit: 'serving' });
  await api.dispose();
});
```

- [ ] **Step 5: Run it**

Run: `cd ~/Projects/CarbBook/web && pnpm e2e`
Expected: the web build output, `Created owner "brett" (id 1)`, `Imported 12 foods and 28 portions (3 skipped) from 3 datasets`, then `✓  1 [chromium] › e2e/carbbook.spec.ts:… › log, save and edit a meal, then log offline and sync on reconnect (spec §10)` and `1 passed`.
If the offline `page.reload()` step fails with `net::ERR_INTERNET_DISCONNECTED`, the page was not yet controlled by the service worker: confirm `dist/sw.js` exists (Task 11) and that the server serves `web/dist` (`WEB_DIR`). Do not weaken the test by removing the reload.

- [ ] **Step 6: Typecheck and commit**

Run: `cd ~/Projects/CarbBook/web && pnpm typecheck`
Expected: `tsc` exits 0.

```bash
cd ~/Projects/CarbBook
git add .gitignore web/playwright.config.ts web/e2e
git commit -m "test(web): Playwright e2e for logging, meals and offline sync"
```

---

### Task 13: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Workspace tests and typecheck**

Run: `cd ~/Projects/CarbBook && pnpm test && pnpm typecheck`
Expected: core, server and web all pass (web: `Test Files  23 passed (23)`, `Tests  120 passed (120)`); no type errors.

- [ ] **Step 2: Production build and e2e**

Run: `cd ~/Projects/CarbBook/web && pnpm e2e`
Expected: `1 passed`.

- [ ] **Step 3: Check the layout at 375 px**

Run the server and the dev UI in two terminals:
```bash
cd ~/Projects/CarbBook/server && T=$(mktemp -d) && DATABASE_PATH=$T/c.db CARBBOOK_PASSWORD='dev password' pnpm -s carbbook user add brett --role owner \
&& DATABASE_PATH=$T/c.db USDA_DIR=$T/usda pnpm -s carbbook import-usda test/fixtures/usda/foundation test/fixtures/usda/sr_legacy test/fixtures/usda/survey \
&& DATABASE_PATH=$T/c.db USDA_DIR=$T/usda PORT=3000 HOST=127.0.0.1 COOKIE_SECURE=false pnpm start
```
```bash
cd ~/Projects/CarbBook/web && pnpm dev
```
Open `http://localhost:5173` in Chrome, DevTools device toolbar at 375 × 812, sign in as `brett` / `dev password`, and check each tab: no horizontal scrolling; the tab bar and every button are at least 48 px tall; the item row (amount, unit, carbs, remove) fits; the dose breakdown wraps instead of overflowing; the scan dialog's Cancel button is reachable.
Expected: all checks hold. Fix any overflow in `src/styles.css` and re-run `pnpm test` before committing.

- [ ] **Step 4: Check camera scanning on real phones**

With the Pi deployment (or `pnpm preview` behind HTTPS), open Foods → Scan barcode on Android Chrome (BarcodeDetector path) and iPhone Safari (ZXing path) and scan a packaged food.
Expected: both open the food (known), a prefilled draft, or manual entry with the barcode filled in; denying the camera shows "Camera unavailable (…). Type the barcode instead." and the typed code still works.

- [ ] **Step 5: Commit (only if anything changed)**

```bash
cd ~/Projects/CarbBook && git status --short
```
Expected: clean working tree.

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| §8 Calculator: unified search (meals, foods, recents, USDA) + barcode button | 2 (SearchPanel), 7 |
| §8 item rows with amount + valid-unit picker (servings for meals), live carbs | 2, 7 |
| §8 BG with trend + age; manual entry when stale/unavailable/offline (§4.4, §9) | 3 (BgField), 7 |
| §8 window auto, overridable | 3 (`settingsForWindow`), 7 |
| §4.3.7 dose labelled estimate, breakdown always shown; refusal reasons never a number | 3 (DoseCard), 7 |
| §4.3.6 warning when a dose was logged within 4 hours | 3, 7 |
| §8 Log it with editable taken dose; USDA foods copied into `food` | 7 |
| §8 Save as meal (yield servings, optional total weight) | 7 |
| §8 Foods: list/search, create from label, edit fields and portions, scan barcode | 4, 5 |
| §3 editing a USDA food creates a custom copy (`derived_from`) | 4 |
| §6/§9 barcode: known → food, draft → confirm (null carbs blocked), not found/unavailable → manual prefilled, offline → queue | 4, 5 |
| §8 barcode: BarcodeDetector where supported, ZXing fallback | 1 (scanner.ts), 5, 13 (manual) |
| §8 Meals: edit name, yield, weight, components add/remove/reorder, amounts/units; live per-serving carbs; cycles rejected | 6 |
| §8 Log: per-day list, carbs/BG/doses, day totals, edit entries, Recalculate from current meal | 8 |
| §8 Settings: dose settings editor (windows add/remove/rename/times/ratios, correction, rounding) saved as new version with effective date; version history | 9 |
| §8 Settings: sync status (pending, last synced, rejections), sign out; users screen out of scope | 9 |
| §5 pending count + last synced visible; auth expiry prompts re-login without losing changes (§9) | 9, 10 |
| Dangling references shown as missing data (server has no referential integrity) | 2, 7 |
| Offline PWA: precached app shell, installable manifest, navigate fallback except /api | 11 |
| Mobile-first CSS, 375 px, large touch targets, no UI kit | 10 (styles.css), 13 |
| §10 Playwright: login, search, add items with units, log, save meal, edit meal, go offline, log, reconnect, verify server state | 12 |
