import { IMAGE_HASH_PATTERN, IMAGE_MAX_EDGE_PX, type ImageData } from '@carbbook/core';
import type { Api } from './api';
import type { ImageCandidate, ImageSearchResult } from './wire';

/** Null for no image and for a malformed id, so a dangling reference renders as empty, never broken. */
export function imageUrl(imageId: string | null | undefined): string | null {
  if (!imageId || !IMAGE_HASH_PATTERN.test(imageId)) return null;
  return `/api/images/${imageId}`;
}

/**
 * Search never throws: an unavailable service degrades the picker, it must not break the editor.
 * A failure here is reported the same way the server reports a dead provider — a name in
 * `providers_failed` — so the UI has only one thing to render.
 */
export async function searchImages(api: Api, query: string, limit = 24): Promise<ImageSearchResult> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  try {
    return await api.get<ImageSearchResult>(`/api/images/search?${params.toString()}`);
  } catch {
    return { candidates: [], providers_failed: ['server'] };
  }
}

/**
 * Stores the candidate's bytes server-side and returns the `image` row. It does *not* attach the
 * image to anything: the caller writes `food.image_id` / `meal.image_id` through the ordinary sync
 * push, so that edit gets last-write-wins and offline queueing like every other change.
 */
export function adoptImage(api: Api, candidate: ImageCandidate): Promise<ImageData> {
  // Nulls are omitted rather than sent: the server's schema takes strings or nothing at all.
  const body: Record<string, string> = { url: candidate.full_url, source: candidate.provider };
  if (candidate.license !== null) body.license = candidate.license;
  if (candidate.attribution !== null) body.attribution = candidate.attribution;
  return api.post<ImageData>('/api/images/adopt', body);
}

/**
 * Downscale before upload so a phone photo never approaches the server's 5MB body limit.
 * The server re-encodes regardless — this is bandwidth, not validation. Always JPEG: the
 * server cannot decode HEIC, and a canvas re-encode gives us JPEG for free.
 */
export async function uploadPhoto(api: Api, file: File): Promise<ImageData> {
  const data_base64 = await downscaleToJpegBase64(file);
  return api.post<ImageData>('/api/images/upload', { data_base64, mime: 'image/jpeg' });
}

async function downscaleToJpegBase64(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    // Never upscale: a small image gains nothing and only costs bytes.
    const scale = Math.min(1, IMAGE_MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not prepare the photo for upload');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85).replace(/^data:[^,]*,/, '');
  } finally {
    bitmap.close();
  }
}
