/** One image per food or meal (images spec 2026-09-18). Metadata syncs; bytes never do. */

/** Where an image came from. `upload` is the user's own photo. */
export const IMAGE_SOURCES = ['off', 'openverse', 'wikimedia', 'themealdb', 'upload'] as const;
export type ImageSource = (typeof IMAGE_SOURCES)[number];

/** Only JPEG is stored in this version; every adopt and upload is re-encoded to it. */
export const IMAGE_MIME_TYPES = ['image/jpeg'] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

/** Longest edge after normalisation. Smaller images are never upscaled. */
export const IMAGE_MAX_EDGE_PX = 800;
/** JPEG quality used on the way in. */
export const IMAGE_JPEG_QUALITY = 80;
/** Hard ceiling on stored bytes; at 800px/q80 this is generous and should not be reached. */
export const IMAGE_MAX_STORED_BYTES = 400 * 1024;
/** Ceiling on a download before normalisation, so a hostile URL cannot stream forever. */
export const IMAGE_MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
/** Attribution is displayed verbatim, so it stays short enough to render. */
export const IMAGE_ATTRIBUTION_MAX = 300;

/** id is the SHA-256 of the *normalised* bytes, so the same image dedups to one row. */
export const IMAGE_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function isImageHash(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_HASH_PATTERN.test(value);
}

export interface ImageData {
  id: string;
  mime: ImageMime;
  width: number;
  height: number;
  source: ImageSource;
  source_url?: string | null;
  license?: string | null;
  attribution?: string | null;
}
