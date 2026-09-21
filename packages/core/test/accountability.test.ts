import { describe, expect, it } from 'vitest';
import vectors from '../../../testdata/accountability-vectors.json';
import { accountabilityText } from '../src/accountability';

const v = vectors as unknown as {
  cases: { name: string; input: { when: string; bg_mgdl: number | null; carbs_g: number; units: number | null }; expect: string }[];
};

describe('accountability vectors', () => {
  it('has cases to run', () => {
    expect(v.cases.length).toBeGreaterThan(0);
  });
  for (const c of v.cases) {
    it(`text: ${c.name}`, () => {
      expect(accountabilityText(c.input)).toBe(c.expect);
    });
  }
});

describe('accountabilityText', () => {
  it('never prints a non-finite carb total', () => {
    const text = accountabilityText({ when: 'now', bg_mgdl: 100, carbs_g: Number.NaN, units: 4 });
    expect(text).toBe('As of now my blood sugar is 100. I do not have a carb total for this meal.');
  });
  it('treats a non-finite BG as no reading', () => {
    const text = accountabilityText({ when: 'now', bg_mgdl: Number.NaN, carbs_g: 10, units: null });
    expect(text).toContain('I do not have a blood sugar reading.');
  });
  it('treats a non-finite dose as none recorded', () => {
    const text = accountabilityText({ when: 'now', bg_mgdl: 100, carbs_g: 10, units: Number.POSITIVE_INFINITY });
    expect(text).toContain('have not recorded a dose yet.');
  });
});
