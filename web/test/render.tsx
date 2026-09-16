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
  // carb_goal values mirror the live server's deployed goals for this user (Breakfast 30-50,
  // AM/PM/HS Snack 10-30, Lunch 50-80, Dinner 50-80) so plan/goal tests exercise real numbers.
  windows: [
    { name: 'Breakfast', start: '05:00', ratio_g_per_unit: 8, carb_goal: { min: 30, max: 50 } },
    { name: 'AM Snack', start: '09:00', ratio_g_per_unit: 10, carb_goal: { min: 10, max: 30 } },
    { name: 'Lunch', start: '11:00', ratio_g_per_unit: 8, carb_goal: { min: 50, max: 80 } },
    { name: 'PM Snack', start: '14:00', ratio_g_per_unit: 10, carb_goal: { min: 10, max: 30 } },
    { name: 'Dinner', start: '16:30', ratio_g_per_unit: 8, carb_goal: { min: 50, max: 80 } },
    { name: 'HS Snack', start: '19:30', ratio_g_per_unit: 12, carb_goal: { min: 10, max: 30 } },
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
