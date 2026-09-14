import type { Db } from '../db';

export interface SearchHit {
  kind: 'meal' | 'food' | 'usda';
  /** food/meal UUID, or "usda:<fdc_id>". */
  id: string;
  name: string;
  brand: string | null;
  source: 'usda' | 'off' | 'custom' | null;
  carbs_per_100g: number | null;
}

/** Turns user input into an FTS5 prefix query: `pea but` → `"pea"* "but"*`. */
export function toFtsQuery(input: string): string | null {
  const tokens = input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return null;
  return tokens
    .slice(0, 8)
    .map((token) => `"${token}"*`)
    .join(' ');
}

/**
 * Ranking (spec §6): meals and custom foods, then other saved foods (most recently logged first),
 * then the USDA library. bm25 breaks ties inside a tier.
 */
export function search(db: Db, input: string, limit: number): SearchHit[] {
  const query = toFtsQuery(input);
  if (!query) return [];
  const userHits = db
    .prepare(
      `SELECT catalog_fts.kind AS kind, catalog_fts.ref_id AS id, catalog_fts.name AS name,
              nullif(catalog_fts.brand, '') AS brand, food.source AS source, food.carbs_per_100g AS carbs_per_100g,
              CASE WHEN catalog_fts.kind = 'meal' OR food.source = 'custom' THEN 0 ELSE 1 END AS tier,
              (SELECT max(log_entry.eaten_at) FROM log_item
                 JOIN log_entry ON log_entry.id = log_item.log_entry_id
                WHERE log_item.ref_id = catalog_fts.ref_id AND log_item.deleted = 0 AND log_entry.deleted = 0
              ) AS last_logged
         FROM catalog_fts
         LEFT JOIN food ON catalog_fts.kind = 'food' AND food.id = catalog_fts.ref_id
        WHERE catalog_fts MATCH ?
        ORDER BY tier, last_logged DESC NULLS LAST, bm25(catalog_fts)
        LIMIT ?`,
    )
    .all(query, limit) as (SearchHit & { tier: number; last_logged: number | null })[];

  const hits: SearchHit[] = userHits.map(({ tier: _tier, last_logged: _last, ...hit }) => hit);
  const remaining = limit - hits.length;
  if (remaining > 0) {
    const usdaHits = db
      .prepare(
        `SELECT 'usda' AS kind, 'usda:' || usda_food.fdc_id AS id, usda_food.name AS name, NULL AS brand,
                'usda' AS source, usda_food.carbs_per_100g AS carbs_per_100g
           FROM usda_fts JOIN usda_food ON usda_food.fdc_id = usda_fts.rowid
          WHERE usda_fts MATCH ?
          ORDER BY bm25(usda_fts)
          LIMIT ?`,
      )
      .all(query, remaining) as SearchHit[];
    hits.push(...usdaHits);
  }
  return hits;
}
