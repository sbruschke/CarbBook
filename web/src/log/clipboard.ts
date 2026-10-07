import type { ClipItem, RefType } from '@carbbook/core';
import { useSyncExternalStore } from 'react';
import type { DraftItem } from '../ui/ItemEditor';

/**
 * The in-app clipboard (log copy spec 2026-10-07): rows copied out of a log entry, waiting to be
 * pasted into the Calculator or a plan slot. Per device and never synced, like the plan dismissals —
 * it is a scratch space, not a record. One clipboard: a new copy replaces the old one.
 */
export const CLIPBOARD_KEY = 'carbbook.clipboard';

export interface Clipboard {
  /** What was copied, for the paste prompt: "Lunch · Tue 6 Oct" or "Calrose Rice". */
  source: string;
  items: ClipItem[];
}

const REF_TYPES: RefType[] = ['food', 'meal', 'quick'];

const isClipItem = (value: unknown): value is ClipItem => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    REF_TYPES.includes(v.ref_type as RefType) &&
    typeof v.ref_id === 'string' &&
    typeof v.amount === 'number' &&
    Number.isFinite(v.amount) &&
    typeof v.unit === 'string' &&
    (v.label === null || typeof v.label === 'string')
  );
};

const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null; // storage blocked (private mode, disabled cookies)
  }
};

/** Same-tab writes don't fire `storage`, so the screens listening are told directly. */
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: Clipboard | null = null;

export function readClipboard(): Clipboard | null {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(CLIPBOARD_KEY) ?? null;
  } catch {
    raw = null;
  }
  // useSyncExternalStore needs a stable snapshot: re-parse only when the stored text changed.
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  cached = null;
  try {
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const { source, items } = parsed as { source?: unknown; items?: unknown };
      // Anything malformed is treated as an empty clipboard rather than pasted half-right.
      if (typeof source === 'string' && Array.isArray(items) && items.length > 0 && items.every(isClipItem)) {
        cached = { source, items };
      }
    }
  } catch {
    cached = null;
  }
  return cached;
}

function write(value: Clipboard | null): void {
  try {
    if (value) storage()?.setItem(CLIPBOARD_KEY, JSON.stringify(value));
    else storage()?.removeItem(CLIPBOARD_KEY);
  } catch {
    // Storage full or blocked: nothing to paste later, which the screens show as an empty clipboard.
  }
  for (const listener of listeners) listener();
}

export const copyToClipboard = (value: Clipboard): void => write(value.items.length > 0 ? value : null);
export const clearClipboard = (): void => write(null);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab copying shows up here too.
  const onStorage = (e: StorageEvent) => {
    if (e.key === CLIPBOARD_KEY || e.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useClipboard(): Clipboard | null {
  return useSyncExternalStore(subscribe, readClipboard, () => null);
}

/**
 * Editable rows for pasting. Every row gets a fresh key — a pasted row must never share an id with
 * the row it came from, or with a second paste of the same clipboard — and a quick row points at
 * its own new key, as `newQuickItem` does.
 */
export function pasteRows(clipboard: Clipboard, newKey: () => string): DraftItem[] {
  return clipboard.items.map((item) => {
    const key = newKey();
    return {
      key,
      ref_type: item.ref_type,
      ref_id: item.ref_type === 'quick' ? key : item.ref_id,
      amount: String(item.amount),
      unit: item.unit,
      label: item.label ?? '',
    };
  });
}
