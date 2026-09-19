import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli';
import { deleteImages, findUnreferencedImages } from '../src/images/gc';
import { createImageStore, type ImageStore } from '../src/images/store';
import { initDatabase } from '../src/init';
import { applyPush } from '../src/sync/push';

/** Fixed, and in the past: applyPush rejects an updated_at in the future. */
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const hash = (char: string) => char.repeat(64);
const meta = (updated_at: number) => ({ updated_at, updated_by: 'test', deleted: 0 });
const image = (id: string, updated_at: number) => ({
  table: 'image',
  record: { id, mime: 'image/jpeg', width: 8, height: 8, source: 'upload', source_url: null, license: null, attribution: null, ...meta(updated_at) },
});

function seeded() {
  const db = initDatabase(':memory:');
  applyPush(db, 'owner', [
    image(hash('a'), NOW - 60 * DAY),
    image(hash('b'), NOW - 60 * DAY),
    image(hash('c'), NOW - 2 * DAY),
    { table: 'food', record: { id: 'f1', name: 'Soup', source: 'custom', carbs_per_100g: 10, image_id: hash('a'), ...meta(NOW) } },
  ]);
  return db;
}

describe('findUnreferencedImages', () => {
  it('keeps referenced images, keeps young ones, and reports only old orphans', () => {
    // 'a' is referenced by a food; 'c' is only 2 days old; 'b' is the sole orphan.
    expect(findUnreferencedImages(seeded(), NOW, 30)).toEqual([hash('b')]);
  });

  it('counts a meal reference too', () => {
    const db = seeded();
    applyPush(db, 'owner', [
      { table: 'meal', record: { id: 'm1', name: 'Pot', yield_servings: 4, image_id: hash('b'), ...meta(NOW) } },
    ]);
    expect(findUnreferencedImages(db, NOW, 30)).toEqual([]);
  });

  it('ignores a reference from a soft-deleted food', () => {
    const db = seeded();
    applyPush(db, 'owner', [
      { table: 'food', record: { id: 'f1', name: 'Soup', source: 'custom', carbs_per_100g: 10, image_id: hash('a'), updated_at: NOW + 1, updated_by: 'test', deleted: 1 } },
    ]);
    expect(findUnreferencedImages(db, NOW + 2, 30).sort()).toEqual([hash('a'), hash('b')].sort());
  });

  it('respects the age floor', () => {
    // With a 1-day floor, the 2-day-old orphan becomes eligible too.
    expect(findUnreferencedImages(seeded(), NOW, 1).sort()).toEqual([hash('b'), hash('c')].sort());
  });

  it('never re-reports a row gc has already soft-deleted', async () => {
    const db = seeded();
    const store = createImageStore({ imageDir: mkdtempSync(join(tmpdir(), 'carbbook-gc-')) });
    // An earlier sweep deleted 'b' long enough ago that its row is itself past the age floor.
    await deleteImages(db, store, [hash('b')], NOW - 45 * DAY);
    // Its bytes are already gone, so reporting it again would be busywork for ever.
    expect(findUnreferencedImages(db, NOW, 30)).toEqual([]);
  });
});

describe('deleteImages', () => {
  it('removes the bytes and soft-deletes the row', async () => {
    const db = seeded();
    const store = createImageStore({ imageDir: mkdtempSync(join(tmpdir(), 'carbbook-gc-')) });
    const stored = await store.put(await sharp({ create: { width: 16, height: 16, channels: 3, background: '#c00' } }).png().toBuffer());
    applyPush(db, 'owner', [image(stored.id, NOW - 60 * DAY)]);
    expect(await store.has(stored.id)).toBe(true);

    await deleteImages(db, store, [stored.id], NOW + 5);

    expect(await store.has(stored.id)).toBe(false);
    const row = db.prepare('SELECT deleted, updated_at, updated_by FROM image WHERE id = ?').get(stored.id);
    expect(row).toEqual({ deleted: 1, updated_at: NOW + 5, updated_by: 'server-images-gc' });
  });

  it('does not throw when the bytes are already gone', async () => {
    const db = seeded();
    const store = createImageStore({ imageDir: mkdtempSync(join(tmpdir(), 'carbbook-gc-')) });
    await expect(deleteImages(db, store, [hash('b')], NOW)).resolves.toBeUndefined();
    expect(db.prepare('SELECT deleted FROM image WHERE id = ?').get(hash('b'))).toEqual({ deleted: 1 });
  });
});

function cliIo(db: ReturnType<typeof seeded>, store: ImageStore) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    env: {},
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    readPassword: async () => '',
    db,
    store,
    now: () => NOW,
  };
  return { io, out, err };
}

const tempStore = () => createImageStore({ imageDir: mkdtempSync(join(tmpdir(), 'carbbook-gc-')) });

describe('carbbook images gc', () => {
  it('reports orphans and deletes nothing without --delete', async () => {
    const db = seeded();
    const t = cliIo(db, tempStore());
    expect(await runCli(['images', 'gc'], t.io)).toBe(0);
    expect(t.out).toEqual([
      '1 unreferenced image(s) older than 30 days',
      `  ${hash('b')}`,
      'nothing deleted; re-run with --delete to remove them',
    ]);
    expect(db.prepare('SELECT deleted FROM image WHERE id = ?').get(hash('b'))).toEqual({ deleted: 0 });
  });

  it('deletes with --delete and honours --min-age-days', async () => {
    const db = seeded();
    const t = cliIo(db, tempStore());
    expect(await runCli(['images', 'gc', '--delete', '--min-age-days', '1'], t.io)).toBe(0);
    expect(t.out.at(0)).toBe('2 unreferenced image(s) older than 1 days');
    expect(t.out.at(-1)).toBe('deleted 2 image(s)');
    expect(findUnreferencedImages(db, NOW, 1)).toEqual([]);
  });

  it('rejects a --min-age-days that is not a positive integer', async () => {
    for (const value of ['0', '-1', '1.5', 'many', undefined]) {
      const t = cliIo(seeded(), tempStore());
      const argv = ['images', 'gc', '--min-age-days', ...(value === undefined ? [] : [value])];
      expect(await runCli(argv, t.io)).toBe(2);
      expect(t.err).toEqual(['--min-age-days must be a positive integer']);
    }
  });
});
