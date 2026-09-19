import { describe, expect, it } from 'vitest';
import { SYNC_TABLES } from '../src/db/db';

describe('web sync tables', () => {
  it('includes image last, matching the server pull order', () => {
    expect(SYNC_TABLES.at(-1)).toBe('image');
  });
});
