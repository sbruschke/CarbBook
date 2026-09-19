import type { ImageCandidate } from '../images/providers/types';
import { isProviderHost } from '../images/urlguard';
import type { OffProduct } from './client';

export interface FoodDraft {
  food: {
    name: string;
    brand: string | null;
    source: 'off';
    source_ref: string;
    carbs_per_100g: number | null;
    /** Volume carb basis (any-unit foods addendum). OFF never supplies this; always null here. */
    carbs_per_100ml: null;
    fiber_per_100g: number | null;
  };
  portions: { label: string; kind: 'serving'; quantity: number; grams: number; carbs_g: null }[];
  barcode: string;
  /** OFF's free-text serving size, shown so the user can sanity-check the portion. */
  serving_size: string | null;
}

function nonNegative(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/** Carbs/fiber are grams per 100g of food and can never exceed 100; anything else is unparseable/bad data. */
function per100g(value: unknown): number | null {
  const n = nonNegative(value);
  return n !== null && n <= 100 ? n : null;
}

/** Draft the user confirms before it is saved as a food with source "off" (spec §6). */
export function normalizeOffProduct(product: OffProduct, scannedCode: string): FoodDraft {
  const code = product.code || scannedCode;
  const brand = product.brands?.split(',')[0]?.trim() || null;
  const grams = nonNegative(product.serving_quantity);
  const unit = (product.serving_quantity_unit ?? 'g').trim().toLowerCase();
  const carbsPer100g = per100g(product.nutriments?.carbohydrates_100g);
  let fiberPer100g = per100g(product.nutriments?.fiber_100g);
  if (carbsPer100g !== null && fiberPer100g !== null && fiberPer100g > carbsPer100g) fiberPer100g = null;
  return {
    food: {
      name: product.product_name?.trim() || `Barcode ${code}`,
      brand,
      source: 'off',
      source_ref: code,
      carbs_per_100g: carbsPer100g,
      carbs_per_100ml: null,
      fiber_per_100g: fiberPer100g,
    },
    portions:
      grams !== null && grams > 0 && unit === 'g'
        ? [{ label: 'label serving', kind: 'serving', quantity: 1, grams, carbs_g: null }]
        : [],
    barcode: code,
    serving_size: product.serving_size?.trim() || null,
  };
}

/**
 * OFF photos are contributed under CC-BY-SA; the credit line is the project itself.
 * Returns null unless the URL is on an OFF-owned host, so a candidate that could never be
 * adopted (urlguard would reject it) never reaches the scan-confirm screen.
 */
/**
 * OFF serves each photo at several sizes, encoded in the filename as
 * `front_<lang>.<revision>.<size>.jpg` where size is 100, 200, 400 or `full`.
 * `image_front_url` is the 400 variant, which measures about 289x400 — well under our 800px
 * cap, and visibly soft in a 120px editor slot on a retina screen. Promote it to `full`
 * (measured 1311x1812 for the same product) so the stored image is worth the round trip.
 *
 * Only an exact match of that pattern is rewritten; anything else is left alone, so an OFF
 * URL shaped differently degrades to the 400 variant rather than a guessed 404.
 */
function preferFullSize(url: string): string {
  return url.replace(/(\/front_[a-z]{2,3}\.\d+)\.(?:100|200|400)\.jpg$/i, '$1.full.jpg');
}

export function offImageCandidate(product: OffProduct): ImageCandidate | null {
  const full = product.image_front_url?.trim();
  if (!full || !isProviderHost(full, 'off')) return null;
  const small = product.image_front_small_url?.trim();
  return {
    provider: 'off',
    thumb_url: small && isProviderHost(small, 'off') ? small : full,
    full_url: preferFullSize(full),
    width: null,
    height: null,
    license: 'CC-BY-SA-3.0',
    attribution: 'Open Food Facts',
    title: product.product_name ?? null,
  };
}

/** UPC-A/EAN-13 variants so "737628064502" finds a stored "0737628064502" and vice versa. */
export function barcodeCandidates(code: string): string[] {
  const stripped = code.replace(/^0+/, '') || '0';
  return [...new Set([code, stripped, stripped.padStart(12, '0'), stripped.padStart(13, '0')])];
}
