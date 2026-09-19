import { useEffect, useState } from 'react';
import { imageUrl } from '../lib/images';

/**
 * One image, or nothing at all. There is deliberately no placeholder silhouette: an empty slot
 * is quieter than a fake image, and a dangling image_id must look like "no image", not an error.
 */
export function ImageThumb(props: { imageId: string | null | undefined; alt: string; size?: number }) {
  const src = imageUrl(props.imageId);
  // The bytes can be missing even when the row syncs (a server restored from a backup without
  // /data/images), and a broken-image glyph in every list row would be worse than nothing.
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);

  if (!src || broken) return null;
  const size = props.size ?? 40;
  return (
    <img
      className="image-thumb"
      src={src}
      alt={props.alt}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}
