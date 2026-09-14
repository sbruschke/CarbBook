import { describe, expect, it } from 'vitest';
import * as core from '../src/index';

describe('core package', () => {
  it('exports the public API', () => {
    expect(core.CORE_VERSION).toBe('0.1.0');
    for (const name of [
      'createCatalog', 'itemCarbs', 'sumCarbs', 'wouldCreateCycle',
      'foodAmountToGrams', 'foodUnits', 'mealUnits', 'densityOf',
      'estimateDose', 'formatBreakdown', 'pickWindow', 'correctionUnits', 'roundDose',
      'activeSettings', 'recentDoseWarning', 'parseHHMM', 'minutesOfDay', 'isNewer',
    ]) {
      expect(typeof (core as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});
