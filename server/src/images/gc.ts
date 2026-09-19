import type { Db } from '../db';
import type { ImageStore } from './store';

/**
 * Hashes no live food or meal references, older than `minAgeDays`.
 *
 * The age floor matters: a device that has been offline may hold a reference it has not pushed
 * yet, and deleting those bytes would surface as a permanently broken thumbnail. Thirty days is
 * far longer than any realistic offline window here.
 *
 * Rows gc has already soft-deleted are skipped: their bytes are gone, so a second sweep would
 * otherwise report and re-delete the same hashes for ever.
 */
export function findUnreferencedImages(db: Db, now: number, minAgeDays: number): string[] {
  const cutoff = now - minAgeDays * 86_400_000;
  const rows = db
    .prepare(
      `SELECT i.id FROM image i
        WHERE i.deleted = 0
          AND i.updated_at < ?
          AND NOT EXISTS (SELECT 1 FROM food f WHERE f.deleted = 0 AND f.image_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM meal m WHERE m.deleted = 0 AND m.image_id = i.id)
        ORDER BY i.id`,
    )
    .all(cutoff) as { id: string }[];
  return rows.map((row) => row.id);
}

/** Deletes bytes and soft-deletes rows. Only ever called from the CLI with --delete. */
export async function deleteImages(db: Db, store: ImageStore, hashes: string[], now: number): Promise<void> {
  const mark = db.prepare('UPDATE image SET deleted = 1, updated_at = ?, updated_by = ? WHERE id = ?');
  for (const hash of hashes) {
    await store.remove(hash);
    mark.run(now, 'server-images-gc', hash);
  }
}
