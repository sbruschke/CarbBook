import { hash, verify } from '@node-rs/argon2';

/** argon2id with the library defaults (m=19456 KiB, t=2, p=1). */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}
