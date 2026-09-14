/** UUIDv7 (RFC 9562): 48-bit ms timestamp, version 7, variant 10, random rest. Sorts by creation time. */
export function uuidv7(
  now: number = Date.now(),
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (bytes) => crypto.getRandomValues(bytes),
): string {
  const bytes = random(new Uint8Array(16));
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A USDA food copied into the synced `food` table gets a deterministic id, so two devices that
 * copy the same FDC food offline converge on one row (last-write-wins) instead of duplicates.
 */
export const usdaFoodId = (fdcId: number): string => `usda-${fdcId}`;
export const usdaPortionId = (usdaPortionRowId: number): string => `usda-portion-${usdaPortionRowId}`;

export function parseUsdaFoodId(id: string): number | null {
  const match = /^usda-(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
}
