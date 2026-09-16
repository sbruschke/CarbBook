/**
 * Slots whose Calculator suggestion was dismissed on THIS device (spec §5). Deliberately
 * localStorage and never a synced record: dismissing hides the prompt here while the other device
 * still offers it. Keys are `slotKey(date, windowName)`.
 */
export const DISMISSED_KEY = 'carbbook.plan.dismissed';

const storageOrNull = (storage?: Storage): Storage | null => {
  try {
    return storage ?? window.localStorage;
  } catch {
    return null; // storage blocked (private mode, disabled cookies)
  }
};

export function loadDismissed(storage?: Storage): Set<string> {
  const store = storageOrNull(storage);
  if (!store) return new Set();
  try {
    const parsed: unknown = JSON.parse(store.getItem(DISMISSED_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Adds a key; returns the new set so React state can be replaced without re-reading. */
export function dismissSlot(key: string, storage?: Storage): Set<string> {
  const next = loadDismissed(storage).add(key);
  const store = storageOrNull(storage);
  try {
    store?.setItem(DISMISSED_KEY, JSON.stringify([...next]));
  } catch {
    // Storage full or blocked: the dismissal lasts for this session only, which is acceptable.
  }
  return next;
}
