export interface Versioned {
  updated_at: number;
  updated_by: string;
}

/** Last-write-wins: newer timestamp wins; equal timestamps go to the higher device id (spec §5). */
export function isNewer(incoming: Versioned, stored: Versioned | undefined): boolean {
  if (!stored) return true;
  if (incoming.updated_at !== stored.updated_at) return incoming.updated_at > stored.updated_at;
  return incoming.updated_by > stored.updated_by;
}
