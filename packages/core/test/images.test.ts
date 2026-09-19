import { describe, expect, it } from 'vitest';
import { IMAGE_HASH_PATTERN, IMAGE_MAX_EDGE_PX, IMAGE_SOURCES, isImageHash } from '../src/images';

describe('image constants', () => {
  it('accepts a lowercase 64-char hex hash', () => {
    expect(isImageHash('a'.repeat(64))).toBe(true);
  });

  it('rejects uppercase, wrong length and non-hex', () => {
    expect(isImageHash('A'.repeat(64))).toBe(false);
    expect(isImageHash('a'.repeat(63))).toBe(false);
    expect(isImageHash('a'.repeat(63) + 'z')).toBe(false);
    expect(isImageHash('')).toBe(false);
  });

  it('pins the shared limits', () => {
    expect(IMAGE_MAX_EDGE_PX).toBe(800);
    expect(IMAGE_SOURCES).toEqual(['off', 'openverse', 'wikimedia', 'themealdb', 'upload']);
    expect(IMAGE_HASH_PATTERN.source).toBe('^[0-9a-f]{64}$');
  });
});
