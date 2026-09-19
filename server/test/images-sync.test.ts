import { describe, expect, it } from 'vitest';
import { initDatabase } from '../src/init';
import { applyPush } from '../src/sync/push';
import { columnsOf, SYNC_TABLES, TABLE_SPECS } from '../src/sync/tables';

const HASH = 'b'.repeat(64);
const meta = { updated_at: 1_700_000_000_000, updated_by: 'test', deleted: 0 };
const imageRow = {
  id: HASH,
  mime: 'image/jpeg',
  width: 800,
  height: 600,
  source: 'openverse',
  source_url: 'https://api.openverse.org/v1/images/x/thumb/',
  license: 'CC-BY-4.0',
  attribution: 'Someone, CC BY 4.0',
  ...meta,
};

describe('image sync table', () => {
  it('is registered in the pull order', () => {
    expect(SYNC_TABLES).toContain('image');
    expect(columnsOf(TABLE_SPECS.image)).toEqual([
      'id', 'mime', 'width', 'height', 'source', 'source_url', 'license', 'attribution',
      'updated_at', 'updated_by', 'deleted', 'server_seq',
    ]);
  });

  it('accepts a valid image row', () => {
    const db = initDatabase(':memory:');
    expect(applyPush(db, 'owner', [{ table: 'image', record: imageRow }])[0]!.status).toBe('accepted');
  });

  it('rejects a non-hash id, an unknown source, a bad mime and a zero dimension', () => {
    const db = initDatabase(':memory:');
    const bad = [
      { ...imageRow, id: 'not-a-hash' },
      { ...imageRow, source: 'pinterest' },
      { ...imageRow, mime: 'image/png' },
      { ...imageRow, width: 0 },
    ];
    for (const record of bad) {
      const result = applyPush(db, 'owner', [{ table: 'image', record }])[0]!;
      expect(result.status, JSON.stringify(record)).toBe('rejected');
      expect(result.status === 'rejected' && result.reason).toBe('invalid');
    }
  });

  it('accepts image_id on food and meal, and tolerates a dangling one', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'owner', [
      { table: 'food', record: { id: 'f1', name: 'Soup', source: 'custom', carbs_per_100g: 10, image_id: HASH, ...meta } },
      { table: 'meal', record: { id: 'm1', name: 'Pot', yield_servings: 10, image_id: 'c'.repeat(64), ...meta } },
    ]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
  });

  it('rejects an image_id that is not a hash', () => {
    const db = initDatabase(':memory:');
    const [result] = applyPush(db, 'owner', [
      { table: 'food', record: { id: 'f2', name: 'Soup', source: 'custom', carbs_per_100g: 10, image_id: 'nope', ...meta } },
    ]);
    expect(result!.status).toBe('rejected');
  });
});
