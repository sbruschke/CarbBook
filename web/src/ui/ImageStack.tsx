import { imageStackLayout, type StackEntry } from '@carbbook/core';
import { ImageThumb } from './ImageThumb';

/**
 * How much of the photo behind each layer covers. The offset per layer is therefore
 * `size * (1 - OVERLAP)`; at 55% enough of every photo stays visible to recognise it while the
 * group still reads as one cluster rather than a row of separate icons.
 */
const OVERLAP = 0.55;

/**
 * The overlapping photo cluster drawn where several items collapse onto one row — a logged entry,
 * a meal without its own photo, a plan slot. Which photos, and in what order, is core's decision
 * (`imageStackLayout`): biggest carb contribution frontmost.
 */
export function ImageStack({
  entries,
  size = 40,
  label,
}: {
  entries: StackEntry[];
  size?: number;
  /** Overrides the default "N items" accessible label. */
  label?: string;
}) {
  const { imageIds, overflow } = imageStackLayout(entries);
  // Nothing to show renders nothing at all, exactly as a single missing thumbnail does: an empty
  // ring where a photo might one day be is noisier than a plain row.
  if (imageIds.length === 0) return null;

  return (
    // role="img" so the label is actually exposed: an aria-label on a bare span is not
    // reliably announced. The photos themselves stay hidden — the row names its contents in text.
    <span className="image-stack" role="img" aria-label={label ?? `${entries.length} items`}>
      {imageIds.map((imageId, index) => (
        <span
          key={`${index}-${imageId}`}
          className="image-stack-layer"
          aria-hidden="true"
          // Runtime geometry only: the shift depends on the caller's size, and the first photo
          // must sit on top of the second, so z-index descends with depth.
          style={{ marginLeft: index === 0 ? 0 : -(size * OVERLAP), zIndex: imageIds.length - index }}
        >
          <ImageThumb imageId={imageId} alt="" size={size} />
        </span>
      ))}
      {/* Items the photos do not account for — including quick-carb rows, which reference no food. */}
      {overflow > 0 && (
        <span className="image-stack-more" aria-hidden="true">
          +{overflow}
        </span>
      )}
    </span>
  );
}
