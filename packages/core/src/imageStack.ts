/**
 * Ordering rule for the overlapping photo stacks drawn where several items collapse onto one row
 * (a logged entry, a meal, a plan slot). Layout, size and colour are the clients' business; this
 * module only decides *which* photos and in what order.
 */

/** Photos drawn per stack. Shared so both clients and the CSS agree on the cap. */
export const IMAGE_STACK_MAX = 3;

export interface StackEntry {
  imageId: string | null;
  carbs: number | null;
}

export interface StackLayout {
  /** Photos to draw, frontmost first. */
  imageIds: string[];
  /** How many items in the group those photos do not account for. */
  overflow: number;
}

/**
 * The item driving the insulin dose is the one worth recognising first, so the biggest carbohydrate
 * contribution goes frontmost. Items with no image still count towards the overflow badge — they
 * exist, they simply have nothing to show (a food without a photo, or a quick-carb row that
 * references no food at all).
 */
export function imageStackLayout(entries: StackEntry[], max: number = IMAGE_STACK_MAX): StackLayout {
  const withImage = entries
    // Keep the original index so ties can be broken by it rather than by the sort's whim.
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => typeof entry.imageId === 'string' && entry.imageId.trim() !== '');

  withImage.sort((a, b) => {
    const ca = a.entry.carbs;
    const cb = b.entry.carbs;
    // An incomplete food still has an image worth showing, so unknown carbs sort last rather than
    // being hidden.
    const aKnown = typeof ca === 'number' && Number.isFinite(ca);
    const bKnown = typeof cb === 'number' && Number.isFinite(cb);
    if (aKnown && bKnown && ca !== cb) return cb! - ca!;
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    // Stable across renders, so the stack does not jitter when nothing has changed.
    return a.index - b.index;
  });

  // The id is a content hash used as a URL path, so it is passed through as stored.
  const imageIds = withImage.slice(0, Math.max(0, max)).map(({ entry }) => entry.imageId!);
  return { imageIds, overflow: Math.max(0, entries.length - imageIds.length) };
}
