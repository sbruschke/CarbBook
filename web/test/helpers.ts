import type { FoodData, MealData, MealItemData, PortionData, Synced, SyncMeta } from '@carbbook/core';
import { CarbBookDb } from '../src/db/db';
import { type Api, ApiError } from '../src/lib/api';

let dbCounter = 0;

/** A fresh, uniquely named IndexedDB (fake-indexeddb in tests). Call `db.delete()` when done. */
export function openTestDb(): CarbBookDb {
  dbCounter += 1;
  return new CarbBookDb(`carbbook-test-${dbCounter}-${Math.random().toString(36).slice(2)}`);
}

export const foodData = (fields: Partial<FoodData> = {}): FoodData => ({
  id: 'food-1',
  name: 'Tortilla',
  brand: null,
  source: 'custom',
  source_ref: null,
  derived_from: null,
  carbs_per_100g: 48,
  fiber_per_100g: null,
  density_g_per_ml: null,
  notes: null,
  ...fields,
});

export const portionData = (fields: Partial<PortionData> = {}): PortionData => ({
  id: 'portion-1',
  food_id: 'food-1',
  label: 'slice',
  kind: 'count',
  quantity: 1,
  grams: 30,
  ...fields,
});

export const mealData = (fields: Partial<MealData> = {}): MealData => ({
  id: 'meal-1',
  name: 'Tacos',
  yield_servings: 1,
  total_weight_g: null,
  notes: null,
  ...fields,
});

export const mealItemData = (fields: Partial<MealItemData> = {}): MealItemData => ({
  id: 'item-1',
  meal_id: 'meal-1',
  ref_type: 'food',
  ref_id: 'food-1',
  amount: 100,
  unit: 'g',
  position: 0,
  ...fields,
});

export function synced<T>(data: T, meta: Partial<SyncMeta> = {}): Synced<T> {
  return { ...data, updated_at: 1000, updated_by: 'server', deleted: 0, ...meta };
}

type Handler = (body: unknown, path: string) => unknown;

/** In-memory Api: register handlers per `METHOD /path` (query string ignored when matching). */
export class FakeApi implements Api {
  readonly calls: { method: 'GET' | 'POST'; path: string; body?: unknown }[] = [];
  private readonly handlers = new Map<string, Handler>();

  on(method: 'GET' | 'POST', path: string, handler: Handler): this {
    this.handlers.set(`${method} ${path}`, handler);
    return this;
  }

  private async handle(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    this.calls.push(body === undefined ? { method, path } : { method, path, body });
    const handler = this.handlers.get(`${method} ${path.split('?')[0]}`);
    if (!handler) throw new ApiError(404, 'not_found', `No fake route for ${method} ${path}`);
    return handler(body, path);
  }

  async get<T>(path: string): Promise<T> {
    return (await this.handle('GET', path)) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.handle('POST', path, body)) as T;
  }

  async getBytes(path: string): Promise<ArrayBuffer> {
    return (await this.handle('GET', path)) as ArrayBuffer;
  }
}

/** Lets pending promise callbacks run. */
export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
