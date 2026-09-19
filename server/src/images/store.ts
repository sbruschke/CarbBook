import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp, { type OutputInfo } from 'sharp';
import {
  IMAGE_HASH_PATTERN,
  IMAGE_JPEG_QUALITY,
  IMAGE_MAX_EDGE_PX,
  IMAGE_MAX_STORED_BYTES,
} from '@carbbook/core';
import { sniffImageMime } from './sniff';

/** Bad input, not a server fault: routes map this to a 4xx. */
export class ImageRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageRejectedError';
  }
}

export interface StoredImage {
  /** sha256 of the normalised bytes, lowercase hex. */
  id: string;
  mime: 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
}

export interface ImageStore {
  /** Normalise, hash, and write. Idempotent: the same input yields the same id and rewrites nothing. */
  put(input: Buffer): Promise<StoredImage>;
  pathFor(hash: string): string;
  has(hash: string): Promise<boolean>;
  /** Stream for the serving route; the caller has already validated the hash shape. */
  read(hash: string): ReturnType<typeof createReadStream>;
  remove(hash: string): Promise<void>;
}

export interface ImageStoreOptions {
  imageDir: string;
}

export function createImageStore(options: ImageStoreOptions): ImageStore {
  const pathFor = (hash: string): string => {
    if (!IMAGE_HASH_PATTERN.test(hash)) throw new ImageRejectedError('not an image hash');
    return join(options.imageDir, hash.slice(0, 2), `${hash}.jpg`);
  };

  return {
    pathFor,

    async put(input) {
      if (sniffImageMime(input) === null) throw new ImageRejectedError('not a recognised image format');

      let normalised: { data: Buffer; info: OutputInfo };
      try {
        normalised = await sharp(input, { failOn: 'error' })
          // rotate() applies the EXIF orientation, and since we never call withMetadata()
          // the output carries no EXIF at all — including any GPS tag from a phone photo.
          .rotate()
          .resize({ width: IMAGE_MAX_EDGE_PX, height: IMAGE_MAX_EDGE_PX, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: IMAGE_JPEG_QUALITY })
          .toBuffer({ resolveWithObject: true });
      } catch (error) {
        throw new ImageRejectedError(`could not decode image: ${(error as Error).message}`);
      }

      if (normalised.data.byteLength > IMAGE_MAX_STORED_BYTES) {
        throw new ImageRejectedError(
          `image is ${normalised.data.byteLength} bytes after resizing, over the ${IMAGE_MAX_STORED_BYTES} limit`,
        );
      }

      const id = createHash('sha256').update(normalised.data).digest('hex');
      const target = pathFor(id);
      await mkdir(dirname(target), { recursive: true });
      // Write to a unique temp name then rename: concurrent puts of the same image cannot
      // leave a half-written file visible at the content-addressed path.
      const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, normalised.data);
      await rename(temp, target);

      return {
        id,
        mime: 'image/jpeg',
        width: normalised.info.width,
        height: normalised.info.height,
        bytes: normalised.data.byteLength,
      };
    },

    async has(hash) {
      if (!IMAGE_HASH_PATTERN.test(hash)) return false;
      try {
        const stats = await stat(pathFor(hash));
        return stats.isFile();
      } catch {
        return false;
      }
    },

    read(hash) {
      return createReadStream(pathFor(hash));
    },

    async remove(hash) {
      try {
        await unlink(pathFor(hash));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}
