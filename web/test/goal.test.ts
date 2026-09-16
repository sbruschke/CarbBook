import { describe, expect, it } from 'vitest';
import vectors from '../../testdata/goal-vectors.json';
import { GOAL_WORDS, goalView } from '../src/plan/goal';

describe('goalView', () => {
  it('renders carbs, the goal range, a status word and a full aria-label', () => {
    const view = goalView({ carbs_g: 68, complete: true }, { min: 50, max: 80 });
    expect(view.status).toBe('in');
    expect(view.text).toBe('68 g · goal 50–80');
    expect(view.word).toBe('on target');
    expect(view.className).toBe('goal goal-in');
    expect(view.ariaLabel).toBe('68 g, goal 50 to 80, on target');
  });

  it('shows the carbs alone when the window has no goal', () => {
    const view = goalView({ carbs_g: 68, complete: true }, null);
    expect(view.status).toBe('none');
    expect(view.text).toBe('68 g');
    expect(view.word).toBe('');
    expect(view.ariaLabel).toBe('68 g');
  });

  it('says "missing data" instead of a number when carbs are incomplete', () => {
    const view = goalView({ carbs_g: 0, complete: false }, { min: 50, max: 80 });
    expect(view.status).toBe('none');
    expect(view.text).toBe('missing data · goal 50–80');
    expect(view.ariaLabel).toBe('missing data, goal 50 to 80');
  });

  it('agrees with the shared core vectors on every banding case', () => {
    // Actual testdata/goal-vectors.json (not the `{ cases: [...] }` shape this plan assumed) uses
    // `status_cases` with `carbs`/`expect` field names and an optional `complete` (default true).
    expect(vectors.status_cases.length).toBeGreaterThan(0);
    for (const c of vectors.status_cases) {
      const view = goalView({ carbs_g: c.carbs, complete: c.complete ?? true }, c.goal);
      expect(view.status, `${c.name}: ${c.carbs} g vs ${JSON.stringify(c.goal)}`).toBe(c.expect);
      expect(GOAL_WORDS[view.status]).toBeDefined();
    }
  });
});
