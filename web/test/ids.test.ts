import { describe, expect, it } from 'vitest';
import { parseUsdaFoodId, usdaFoodId, usdaPortionId, uuidv7 } from '../src/lib/ids';

describe('uuidv7', () => {
  it('encodes the timestamp and sets the version and variant bits', () => {
    const id = uuidv7(0x0189_1234_5678, () => new Uint8Array(16).fill(0xff));
    expect(id).toBe('01891234-5678-7fff-bfff-ffffffffffff');
  });

  it('has the UUIDv7 layout and sorts by creation time', () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe('USDA ids', () => {
  it('are deterministic and reversible', () => {
    expect(usdaFoodId(324860)).toBe('usda-324860');
    expect(usdaPortionId(119207)).toBe('usda-portion-119207');
    expect(parseUsdaFoodId('usda-324860')).toBe(324860);
    expect(parseUsdaFoodId('usda-portion-119207')).toBeNull();
    expect(parseUsdaFoodId('0190f1e2-aaaa-7bbb-8ccc-dddddddddddd')).toBeNull();
  });
});
