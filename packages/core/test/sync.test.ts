import { describe, expect, it } from 'vitest';
import { isNewer } from '../src/sync';

describe('isNewer', () => {
  it('accepts anything when nothing is stored', () => {
    expect(isNewer({ updated_at: 1, updated_by: 'a' }, undefined)).toBe(true);
  });
  it('compares timestamps first', () => {
    expect(isNewer({ updated_at: 2, updated_by: 'a' }, { updated_at: 1, updated_by: 'z' })).toBe(true);
    expect(isNewer({ updated_at: 1, updated_by: 'z' }, { updated_at: 2, updated_by: 'a' })).toBe(false);
  });
  it('breaks ties by device id and ignores exact replays', () => {
    expect(isNewer({ updated_at: 5, updated_by: 'phone' }, { updated_at: 5, updated_by: 'laptop' })).toBe(true);
    expect(isNewer({ updated_at: 5, updated_by: 'laptop' }, { updated_at: 5, updated_by: 'phone' })).toBe(false);
    expect(isNewer({ updated_at: 5, updated_by: 'phone' }, { updated_at: 5, updated_by: 'phone' })).toBe(false);
  });
});
