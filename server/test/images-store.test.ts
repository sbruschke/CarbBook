import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { IMAGE_MAX_EDGE_PX } from '@carbbook/core';
import { createImageStore, ImageRejectedError } from '../src/images/store';

let dir: string;
let store: ReturnType<typeof createImageStore>;
let tall: Buffer;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'carbbook-images-'));
  store = createImageStore({ imageDir: dir });
  tall = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#c00' } }).png().toBuffer();
});

describe('image store', () => {
  it('normalises to a capped JPEG and returns metadata', async () => {
    const stored = await store.put(tall);
    expect(stored.mime).toBe('image/jpeg');
    expect(Math.max(stored.width, stored.height)).toBe(IMAGE_MAX_EDGE_PX);
    expect(stored.width).toBe(800);
    expect(stored.height).toBe(600);
    expect(stored.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes the bytes at a sharded path and reads them back', async () => {
    const stored = await store.put(tall);
    const path = store.pathFor(stored.id);
    expect(path).toBe(join(dir, stored.id.slice(0, 2), `${stored.id}.jpg`));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(await store.has(stored.id)).toBe(true);
  });

  it('is content-addressed: the same input dedups to one id', async () => {
    const first = await store.put(tall);
    const second = await store.put(tall);
    expect(second.id).toBe(first.id);
  });

  it('does not upscale a small image', async () => {
    const small = await sharp({ create: { width: 120, height: 90, channels: 3, background: '#0c0' } }).png().toBuffer();
    const stored = await store.put(small);
    expect(stored.width).toBe(120);
    expect(stored.height).toBe(90);
  });

  it('strips metadata', async () => {
    const withExif = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#00c' } })
      .withMetadata({ exif: { IFD0: { Copyright: 'someone' } } })
      .jpeg()
      .toBuffer();
    const stored = await store.put(withExif);
    const bytes = readFileSync(store.pathFor(stored.id));
    expect(bytes.includes(Buffer.from('someone'))).toBe(false);
    const meta = await sharp(bytes).metadata();
    expect(meta.exif ?? undefined).toBeUndefined();
  });

  it('rejects a buffer that is not an image', async () => {
    await expect(store.put(Buffer.from('<!doctype html>not an image'))).rejects.toBeInstanceOf(ImageRejectedError);
  });

  it('reports a missing hash as absent rather than throwing', async () => {
    expect(await store.has('f'.repeat(64))).toBe(false);
  });
});
