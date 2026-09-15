import { describe, expect, it } from 'vitest';
import vectors from '../../testdata/number-parse-vectors.json';
import { parseAmount, parseWholeNumber } from '../src/ui/format';

describe('shared number-entry vectors', () => {
  it('has non-empty accept/reject arrays', () => {
    expect(vectors.amount.accept.length).toBeGreaterThan(0);
    expect(vectors.amount.reject.length).toBeGreaterThan(0);
    expect(vectors.bg.accept.length).toBeGreaterThan(0);
    expect(vectors.bg.reject.length).toBeGreaterThan(0);
  });

  it('parses every amount.accept case to its exact value', () => {
    for (const { text, value } of vectors.amount.accept) {
      const parsed = parseAmount(text);
      expect(parsed, `parseAmount(${JSON.stringify(text)})`).not.toBeNull();
      expect(Math.abs(parsed! - value), `parseAmount(${JSON.stringify(text)}) = ${parsed}, want ${value}`).toBeLessThanOrEqual(
        vectors.tolerance,
      );
    }
  });

  it('rejects every amount.reject case', () => {
    for (const text of vectors.amount.reject) {
      expect(parseAmount(text), `parseAmount(${JSON.stringify(text)})`).toBeNull();
    }
  });

  it('parses every bg.accept case to its exact value', () => {
    for (const { text, value } of vectors.bg.accept) {
      expect(parseWholeNumber(text), `parseWholeNumber(${JSON.stringify(text)})`).toBe(value);
    }
  });

  it('rejects every bg.reject case', () => {
    for (const text of vectors.bg.reject) {
      expect(parseWholeNumber(text), `parseWholeNumber(${JSON.stringify(text)})`).toBeNull();
    }
  });
});
