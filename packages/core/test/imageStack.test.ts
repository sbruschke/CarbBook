import { describe, expect, it } from 'vitest';
import stackVectors from '../../../testdata/image-stack-vectors.json';
import { IMAGE_STACK_MAX, imageStackLayout, type StackEntry } from '../src/imageStack';

const s = stackVectors as unknown as {
  cases: {
    name: string;
    entries: { image_id?: string | null; carbs?: number | null }[];
    max?: number;
    expect: { image_ids: string[]; overflow: number };
  }[];
};

const toEntries = (raw: { image_id?: string | null; carbs?: number | null }[]): StackEntry[] =>
  raw.map((e) => ({ imageId: e.image_id ?? null, carbs: e.carbs ?? null }));

describe('image stack vectors', () => {
  it('has cases to run', () => {
    expect(s.cases.length).toBeGreaterThan(0);
    expect(s.cases.some((c) => c.max !== undefined)).toBe(true);
  });
  for (const c of s.cases) {
    it(`stack: ${c.name}`, () => {
      const layout = c.max === undefined ? imageStackLayout(toEntries(c.entries)) : imageStackLayout(toEntries(c.entries), c.max);
      expect(layout.imageIds).toEqual(c.expect.image_ids);
      expect(layout.overflow).toBe(c.expect.overflow);
    });
  }
});

describe('imageStackLayout', () => {
  it('caps at three photos by default, so the clients and the CSS agree', () => {
    expect(IMAGE_STACK_MAX).toBe(3);
  });
  it('does not mutate the caller’s array', () => {
    const entries: StackEntry[] = [
      { imageId: 'img-milk', carbs: 12 },
      { imageId: 'img-rice', carbs: 48 },
    ];
    const before = [...entries];
    imageStackLayout(entries);
    expect(entries).toEqual(before);
  });
});
