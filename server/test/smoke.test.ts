import { describe, expect, it } from 'vitest';
import { isNewer } from '@carbbook/core';

describe('server workspace', () => {
  it('imports @carbbook/core', () => {
    expect(isNewer({ updated_at: 2, updated_by: 'a' }, undefined)).toBe(true);
  });
});
