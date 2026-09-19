import { describe, expect, it } from 'vitest';
import { sniffImageMime } from '../src/images/sniff';

const bytes = (...values: number[]) => Buffer.from(values);

describe('sniffImageMime', () => {
  it('detects the formats sharp can decode', () => {
    expect(sniffImageMime(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toBe('image/jpeg');
    expect(sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(sniffImageMime(Buffer.from('GIF89a       '))).toBe('image/gif');
    expect(sniffImageMime(Buffer.concat([Buffer.from('RIFF'), bytes(0, 0, 0, 0), Buffer.from('WEBP')]))).toBe('image/webp');
    expect(sniffImageMime(Buffer.concat([bytes(0, 0, 0, 0x18), Buffer.from('ftypheic')]))).toBe('image/heic');
    expect(sniffImageMime(Buffer.concat([bytes(0, 0, 0, 0x18), Buffer.from('ftypavif')]))).toBe('image/avif');
  });

  it('returns null for things that are not images', () => {
    expect(sniffImageMime(Buffer.from('<!doctype html><html>oops'))).toBeNull();
    expect(sniffImageMime(Buffer.from('{"error":"not found"}'))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
    expect(sniffImageMime(bytes(0xff, 0xd8))).toBeNull(); // truncated JPEG signature
  });
});
