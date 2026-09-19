/**
 * Decide what a buffer actually is from its leading bytes. A remote content-type header is
 * attacker- or bug-controlled; this is not. Only formats sharp can decode are recognised, so
 * anything returning non-null is safe to hand to normalisation.
 */
export type SniffedMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/heic' | 'image/avif';

const startsWith = (buffer: Buffer, ...signature: number[]): boolean =>
  buffer.length >= signature.length && signature.every((byte, index) => buffer[index] === byte);

export function sniffImageMime(buffer: Buffer): SniffedMime | null {
  if (startsWith(buffer, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(buffer, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('latin1') === 'GIF87a' || buffer.subarray(0, 6).toString('latin1') === 'GIF89a')) {
    return 'image/gif';
  }
  // RIFF....WEBP
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  // ISO-BMFF: 4-byte box size, 'ftyp', then the brand.
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1');
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif';
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('hevc') || brand.startsWith('mif1')) {
      return 'image/heic';
    }
  }
  return null;
}
