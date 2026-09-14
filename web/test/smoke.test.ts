import { CORE_VERSION } from '@carbbook/core';
import { describe, expect, it } from 'vitest';

describe('web test environment', () => {
  it('resolves @carbbook/core and provides the DOM and IndexedDB', () => {
    expect(CORE_VERSION).toBe('0.1.0');
    expect(document.createElement('div')).toBeInstanceOf(HTMLElement);
    expect(typeof indexedDB.open).toBe('function');
  });
});
