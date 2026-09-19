import type { FoodData, PortionData, Synced } from '@carbbook/core';

/** Shapes of carbs-server responses (server-foundation and server-data plans, "Wire formats"). */

export type Role = 'owner' | 'viewer';

export interface User {
  id: number;
  username: string;
  role: Role;
}

export type PushResult =
  | { table: string; id: string; status: 'accepted'; server_seq: number }
  | { table: string; id: string; status: 'ignored'; server_seq: number }
  | {
      table: string;
      id: string | null;
      status: 'rejected';
      reason: 'unknown_table' | 'invalid' | 'forbidden' | 'cycle' | 'append_only';
      message: string;
    };

export interface PushResponse {
  results: PushResult[];
  server_seq: number;
}

export interface PullChange {
  table: string;
  /** Always carries server_seq on the wire; optional here so core `Synced<T>` records fit. */
  record: { id: string; updated_at: number; updated_by: string; deleted: 0 | 1; server_seq?: number };
}

export interface PullPage {
  changes: PullChange[];
  next_since: number;
  has_more: boolean;
}

export interface UsdaManifest {
  version: string;
  created_at: number;
  food_count: number;
  portion_count: number;
  json_file: string;
  json_sha256: string;
  json_url: string;
  sqlite_file: string;
  sqlite_sha256: string;
  sqlite_url: string;
}

/** gzip JSON bundle, format 1. */
export interface UsdaJsonBundle {
  format: 1;
  /** [fdc_id, name, carbs_per_100g, fiber_per_100g] */
  foods: [number, string, number | null, number | null][];
  /** [id, fdc_id, label, kind, quantity, grams, description] */
  portions: [number, number, string, string, number, number, string][];
}

export interface BgReading {
  mgdl: number;
  trend: string | null;
  arrow: string | null;
  delta_mgdl: number | null;
  read_at: number;
  age_ms: number;
  fresh: boolean;
}

export interface FoodDraft {
  food: {
    name: string;
    brand: string | null;
    source: 'off';
    source_ref: string;
    carbs_per_100g: number | null;
    fiber_per_100g: number | null;
  };
  portions: { label: string; kind: 'serving'; quantity: number; grams: number }[];
  barcode: string;
  serving_size: string | null;
}

export type BarcodeResponse =
  | { status: 'known'; food: Synced<FoodData>; portions: Synced<PortionData>[] }
  | { status: 'draft'; draft: FoodDraft }
  | { status: 'not_found'; code: string }
  | { status: 'unavailable'; code: string; message: string };

/** One image-search hit (server `images/providers/types.ts`). Nothing is stored until it is adopted. */
export interface ImageCandidate {
  provider: 'openverse' | 'wikimedia' | 'themealdb' | 'off';
  /** Small image for the picker grid, loaded straight from the provider. */
  thumb_url: string;
  /** What POST /api/images/adopt fetches and stores. */
  full_url: string;
  /** The provider's own claim, shown pre-adopt only; stored dimensions come from the bytes. */
  width: number | null;
  /** See `width`. */
  height: number | null;
  license: string | null;
  attribution: string | null;
  title: string | null;
}

/** A provider that failed is named, not fatal: the search is still a 200 with whatever else came back. */
export interface ImageSearchResult {
  candidates: ImageCandidate[];
  providers_failed: string[];
}
