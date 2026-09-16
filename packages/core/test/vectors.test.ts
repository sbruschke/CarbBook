import { describe, expect, it } from 'vitest';
import unitsVectors from '../../../testdata/units-vectors.json';
import doseVectors from '../../../testdata/dose-vectors.json';
import type { CorrectionRule, DoseSettingsData, FoodData, MealData, MealItemData, PortionData, RefType, RoundingRule } from '../src/types';
import { createCatalog, itemCarbs, wouldCreateCycle } from '../src/carbs';
import { estimateDose, formatBreakdown, parseHHMM } from '../src/dose';
import { foodAmountToGrams, foodUnits, mealUnits } from '../src/units';
import goalVectors from '../../../testdata/goal-vectors.json';
import type { CarbGoal, DoseWindow } from '../src/types';
import { dayGoal, goalStatus, isValidCarbGoal, type GoalStatus } from '../src/goal';

const u = unitsVectors as unknown as {
  tolerance: number;
  foods: FoodData[];
  portions: PortionData[];
  meals: MealData[];
  meal_items: MealItemData[];
  grams_cases: { name: string; food_id: string; amount: number; unit: string; expect: number | null }[];
  carb_cases: { name: string; ref_type: RefType; ref_id: string; amount: number; unit: string; expect: { carbs_g: number; complete: boolean } }[];
  unit_list_cases: { ref_type: RefType; ref_id: string; expect: string[] }[];
  cycle_cases: { meal_id: string; candidate: string; expect: boolean }[];
};

const d = doseVectors as unknown as {
  tolerance: number;
  settings: DoseSettingsData;
  cases: {
    name: string;
    time: string;
    carbs: number;
    complete?: boolean;
    bg: number | null;
    correction?: CorrectionRule;
    rounding?: RoundingRule;
    expect: Record<string, unknown>;
  }[];
};

const catalog = createCatalog(u);

describe('units vectors', () => {
  it('has cases to run', () => {
    expect(u.grams_cases.length).toBeGreaterThan(0);
    expect(u.carb_cases.length).toBeGreaterThan(0);
    expect(u.unit_list_cases.length).toBeGreaterThan(0);
    expect(u.cycle_cases.length).toBeGreaterThan(0);
  });
  for (const c of u.grams_cases) {
    it(`grams: ${c.name}`, () => {
      const food = catalog.food(c.food_id)!;
      const grams = foodAmountToGrams(c.amount, c.unit, food, catalog.portions(c.food_id));
      if (c.expect === null) expect(grams).toBeNull();
      else expect(Math.abs(grams! - c.expect)).toBeLessThan(u.tolerance);
    });
  }
  for (const c of u.carb_cases) {
    it(`carbs: ${c.name}`, () => {
      const r = itemCarbs(catalog, c.ref_type, c.ref_id, c.amount, c.unit);
      expect(r.complete).toBe(c.expect.complete);
      expect(Math.abs(r.carbs_g - c.expect.carbs_g)).toBeLessThan(u.tolerance);
    });
  }
  for (const c of u.unit_list_cases) {
    it(`unit list: ${c.ref_id}`, () => {
      const units =
        c.ref_type === 'food'
          ? foodUnits(catalog.food(c.ref_id)!, catalog.portions(c.ref_id))
          : mealUnits(catalog.meal(c.ref_id)!);
      expect(units).toEqual(c.expect);
    });
  }
  for (const c of u.cycle_cases) {
    it(`cycle: ${c.candidate} into ${c.meal_id}`, () => {
      expect(wouldCreateCycle(catalog, c.meal_id, c.candidate)).toBe(c.expect);
    });
  }
});

describe('dose vectors', () => {
  it('has cases to run', () => {
    expect(d.cases.length).toBeGreaterThan(0);
  });
  for (const c of d.cases) {
    it(c.name, () => {
      let settings = d.settings;
      if (c.correction) settings = { ...settings, correction: c.correction };
      if (c.rounding) settings = { ...settings, rounding: c.rounding };
      const r = estimateDose({
        settings,
        minutes: parseHHMM(c.time),
        carbs: { carbs_g: c.carbs, complete: c.complete ?? true },
        bg: c.bg,
      });
      const e = c.expect;
      expect(r.ok).toBe(e.ok);
      expect(r.window?.name ?? null).toBe(e.window ?? null);
      if (!r.ok) {
        expect(r.reason).toBe(e.reason);
        return;
      }
      for (const key of ['meal_units', 'correction_units', 'raw_units', 'units'] as const) {
        expect(Math.abs(r[key] - (e[key] as number)), key).toBeLessThan(d.tolerance);
      }
      expect(r.rounded_down).toBe(e.rounded_down);
      if (typeof e.breakdown === 'string') expect(formatBreakdown(r)).toBe(e.breakdown);
    });
  }
});

const g = goalVectors as unknown as {
  tolerance: number;
  status_cases: { name: string; carbs: number; complete?: boolean; goal: CarbGoal | null; expect: GoalStatus }[];
  day_cases: { name: string; windows: DoseWindow[]; expect: CarbGoal | null }[];
  day_status_cases: { name: string; carbs: number; day_goal: CarbGoal | null; expect: GoalStatus }[];
  valid_cases: { name: string; goal: CarbGoal; expect: boolean }[];
};

describe('goal vectors', () => {
  it('has cases to run', () => {
    expect(g.status_cases.length).toBeGreaterThan(0);
    expect(g.day_cases.length).toBeGreaterThan(0);
    expect(g.day_status_cases.length).toBeGreaterThan(0);
    expect(g.valid_cases.length).toBeGreaterThan(0);
  });
  for (const c of g.status_cases) {
    it(`status: ${c.name}`, () => {
      expect(goalStatus({ carbs_g: c.carbs, complete: c.complete ?? true }, c.goal)).toBe(c.expect);
    });
  }
  for (const c of g.day_cases) {
    it(`day goal: ${c.name}`, () => {
      const result = dayGoal(c.windows);
      if (c.expect === null) {
        expect(result).toBeNull();
        return;
      }
      expect(Math.abs(result!.min - c.expect.min)).toBeLessThan(g.tolerance);
      expect(Math.abs(result!.max - c.expect.max)).toBeLessThan(g.tolerance);
    });
  }
  for (const c of g.day_status_cases) {
    it(`day status: ${c.name}`, () => {
      expect(goalStatus({ carbs_g: c.carbs, complete: true }, c.day_goal)).toBe(c.expect);
    });
  }
  for (const c of g.valid_cases) {
    it(`validity: ${c.name}`, () => {
      expect(isValidCarbGoal(c.goal)).toBe(c.expect);
    });
  }
});
