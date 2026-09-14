import { type FoodData, isNewer, type PortionData, type Synced } from '@carbbook/core';
import type { Table } from 'dexie';
import type { AnySyncRecord, CarbBookDb } from '../db/db';
import { type Api, NetworkError } from '../lib/api';
import type { BarcodeResponse, FoodDraft } from '../lib/wire';

export type BarcodeResolution =
  | { kind: 'local'; food: Synced<FoodData> }
  | { kind: 'known'; food: Synced<FoodData>; portions: Synced<PortionData>[] }
  | { kind: 'draft'; draft: FoodDraft }
  /** Open Food Facts had nothing or failed: enter the food by hand, prefilled with the code. */
  | { kind: 'manual'; code: string; message: string }
  /** Offline and not known locally: kept to look up later (spec §6). */
  | { kind: 'queued'; code: string };

/** UPC-A/EAN-13 spellings, matching the server: "737628064502" ⇄ "0737628064502". */
export function barcodeCandidates(code: string): string[] {
  const stripped = code.replace(/^0+/, '') || '0';
  return [...new Set([code, stripped, stripped.padStart(12, '0'), stripped.padStart(13, '0')])];
}

async function putIfNewer<T extends AnySyncRecord>(table: Table<T, string>, record: T): Promise<void> {
  const local = await table.get(record.id);
  if (!local || isNewer(record, local)) await table.put(record);
}

export async function resolveBarcode(
  db: CarbBookDb,
  api: Api,
  code: string,
  now: () => number = Date.now,
): Promise<BarcodeResolution> {
  const rows = await db.barcode.where('code').anyOf(barcodeCandidates(code)).toArray();
  for (const row of rows.filter((r) => r.deleted === 0).sort((a, b) => b.updated_at - a.updated_at)) {
    const food = await db.food.get(row.food_id);
    if (food && food.deleted === 0) {
      await db.pending_barcode.delete(code);
      return { kind: 'local', food };
    }
  }

  let response: BarcodeResponse;
  try {
    response = await api.get<BarcodeResponse>(`/api/barcode/${encodeURIComponent(code)}`);
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
    await db.pending_barcode.put({ code, created_at: now() });
    return { kind: 'queued', code };
  }
  await db.pending_barcode.delete(code);

  switch (response.status) {
    case 'known':
      await db.transaction('rw', [db.food, db.portion], async () => {
        await putIfNewer(db.food, response.food);
        for (const portion of response.portions) await putIfNewer(db.portion, portion);
      });
      return { kind: 'known', food: response.food, portions: response.portions };
    case 'draft':
      return { kind: 'draft', draft: response.draft };
    case 'not_found':
      return { kind: 'manual', code, message: `No product found for barcode ${code}. Enter the food from its label.` };
    case 'unavailable':
      return {
        kind: 'manual',
        code,
        message: `Open Food Facts is unavailable (${response.message}). Enter the food from its label.`,
      };
  }
}
