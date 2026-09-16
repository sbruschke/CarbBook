import { beforeEach, describe, expect, it } from 'vitest';
import { DISMISSED_KEY, dismissSlot, loadDismissed } from '../src/plan/dismissed';

describe('dismissed slots (per device, never synced)', () => {
  beforeEach(() => localStorage.clear());

  it('starts empty', () => {
    expect(loadDismissed().size).toBe(0);
  });

  it('remembers a dismissal keyed by date and window', () => {
    dismissSlot('2026-09-16|Lunch');
    expect(loadDismissed().has('2026-09-16|Lunch')).toBe(true);
    expect(loadDismissed().has('2026-09-16|Dinner')).toBe(false);
    expect(JSON.parse(localStorage.getItem(DISMISSED_KEY)!)).toEqual(['2026-09-16|Lunch']);
  });

  it('survives corrupt storage without throwing', () => {
    localStorage.setItem(DISMISSED_KEY, 'not json');
    expect(loadDismissed().size).toBe(0);
    dismissSlot('2026-09-16|Lunch');
    expect(loadDismissed().has('2026-09-16|Lunch')).toBe(true);
  });

  it('does not throw when storage is unavailable', () => {
    const broken = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(loadDismissed(broken).size).toBe(0);
    expect(() => dismissSlot('2026-09-16|Lunch', broken)).not.toThrow();
  });
});
