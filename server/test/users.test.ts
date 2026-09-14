import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/passwords';
import { createUser, findUserByUsername, getUser, UserError } from '../src/auth/users';
import { initDatabase } from '../src/init';

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const stored = await hashPassword('hunter2hunter2');
    expect(stored.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(stored, 'hunter2hunter2')).toBe(true);
    expect(await verifyPassword(stored, 'wrong')).toBe(false);
  });

  it('treats a malformed stored hash as a mismatch', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});

describe('users', () => {
  it('creates and finds users case-insensitively', async () => {
    const db = initDatabase(':memory:');
    const user = await createUser(db, { username: 'Brett', password: 'long enough', role: 'owner' }, 1);
    expect(user).toEqual({ id: 1, username: 'Brett', role: 'owner' });
    expect(findUserByUsername(db, 'brett')?.id).toBe(1);
    expect(getUser(db, 1)).toEqual(user);
  });

  it('rejects duplicates, short passwords, bad usernames and roles', async () => {
    const db = initDatabase(':memory:');
    await createUser(db, { username: 'brett', password: 'long enough', role: 'owner' }, 1);
    await expect(createUser(db, { username: 'BRETT', password: 'long enough', role: 'viewer' }, 1)).rejects.toThrow(UserError);
    await expect(createUser(db, { username: 'kim', password: 'short', role: 'viewer' }, 1)).rejects.toThrow(/at least 8/);
    await expect(createUser(db, { username: 'no spaces', password: 'long enough', role: 'viewer' }, 1)).rejects.toThrow(/Username/);
    await expect(
      createUser(db, { username: 'kim', password: 'long enough', role: 'admin' as 'owner' }, 1),
    ).rejects.toThrow(/Role/);
  });
});
