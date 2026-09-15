import { describe, expect, it } from 'vitest';
import vectors from '../../testdata/number-parse-vectors.json';
import { parseAmount, parseNonNegative, parseWholeNumber } from '../src/ui/format';

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

  it('parses every decimal.accept case to its exact value', () => {
    expect(vectors.decimal.accept.length).toBeGreaterThan(0);
    for (const { text, value } of vectors.decimal.accept) {
      const parsed = parseNonNegative(text);
      expect(parsed, `parseNonNegative(${JSON.stringify(text)})`).not.toBeNull();
      expect(Math.abs(parsed! - value), `parseNonNegative(${JSON.stringify(text)}) = ${parsed}, want ${value}`).toBeLessThanOrEqual(
        vectors.tolerance,
      );
    }
  });

  it('rejects every decimal.reject case (no fractions, no non-finite values)', () => {
    expect(vectors.decimal.reject).toEqual(expect.arrayContaining(['1/2', '5/2', '½', '1 1/2']));
    for (const text of vectors.decimal.reject) {
      expect(parseNonNegative(text), `parseNonNegative(${JSON.stringify(text)})`).toBeNull();
    }
  });

  it('rejects amounts with irregular spacing, a leading comma or a sign', () => {
    for (const text of [',5', '1  1/2', '1\t½', '1 ½', '+1', '1  ½']) {
      expect(vectors.amount.reject).toContain(text);
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
