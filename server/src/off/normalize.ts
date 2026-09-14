import type { OffProduct } from './client';

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
  /** OFF's free-text serving size, shown so the user can sanity-check the portion. */
  serving_size: string | null;
}

function nonNegative(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/** Draft the user confirms before it is saved as a food with source "off" (spec §6). */
export function normalizeOffProduct(product: OffProduct, scannedCode: string): FoodDraft {
  const code = product.code || scannedCode;
  const brand = product.brands?.split(',')[0]?.trim() || null;
  const grams = nonNegative(product.serving_quantity);
  const unit = (product.serving_quantity_unit ?? 'g').trim().toLowerCase();
  return {
    food: {
      name: product.product_name?.trim() || `Barcode ${code}`,
      brand,
      source: 'off',
      source_ref: code,
      carbs_per_100g: nonNegative(product.nutriments?.carbohydrates_100g),
      fiber_per_100g: nonNegative(product.nutriments?.fiber_100g),
    },
    portions: grams !== null && grams > 0 && unit === 'g' ? [{ label: 'label serving', kind: 'serving', quantity: 1, grams }] : [],
    barcode: code,
    serving_size: product.serving_size?.trim() || null,
  };
}

/** UPC-A/EAN-13 variants so "737628064502" finds a stored "0737628064502" and vice versa. */
export function barcodeCandidates(code: string): string[] {
  const stripped = code.replace(/^0+/, '') || '0';
  return [...new Set([code, stripped, stripped.padStart(12, '0'), stripped.padStart(13, '0')])];
}
