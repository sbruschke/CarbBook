import { describe, expect, it } from 'vitest';
import {
  createSession,
  listBearerTokens,
  resolveSession,
  revokeSession,
  SESSION_SLIDE_INTERVAL_MS,
  SESSION_TTL_MS,
  sessionIdForToken,
} from '../src/auth/sessions';
import { createUser } from '../src/auth/users';
import { initDatabase } from '../src/init';

async function setup() {
  const db = initDatabase(':memory:');
  const user = await createUser(db, { username: 'brett', password: 'long enough', role: 'owner' }, 0);
  return { db, user };
}

describe('sessions', () => {
  it('stores only the sha256 of the token', async () => {
    const { db, user } = await setup();
    const { token, id } = createSession(db, { userId: user.id, kind: 'cookie', label: 'web' }, 1000);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(id).toBe(sessionIdForToken(token));
    expect(db.prepare('SELECT count(*) FROM auth_session WHERE id = ?').pluck().get(token)).toBe(0);
  });

  it('resolves cookie sessions, slides expiry hourly and expires after 30 idle days', async () => {
    const { db, user } = await setup();
    const { token } = createSession(db, { userId: user.id, kind: 'cookie', label: 'web' }, 0);

    expect(resolveSession(db, token, 10)).toMatchObject({ user: { username: 'brett', role: 'owner' }, renewed: false });
    const slid = resolveSession(db, token, SESSION_SLIDE_INTERVAL_MS);
    expect(slid).toMatchObject({ renewed: true, session: { expires_at: SESSION_SLIDE_INTERVAL_MS + SESSION_TTL_MS } });

    expect(resolveSession(db, token, SESSION_SLIDE_INTERVAL_MS + SESSION_TTL_MS)).toBeNull();
    expect(db.prepare('SELECT count(*) FROM auth_session').pluck().get()).toBe(0);
  });

  it('never expires bearer tokens', async () => {
    const { db, user } = await setup();
    const { token } = createSession(db, { userId: user.id, kind: 'bearer', label: 'iPhone' }, 0);
    expect(resolveSession(db, token, 5 * SESSION_TTL_MS)).toMatchObject({ session: { kind: 'bearer', expires_at: null } });
  });

  it('rejects unknown tokens', async () => {
    const { db } = await setup();
    expect(resolveSession(db, 'nope', 0)).toBeNull();
  });

  it('lists bearer tokens and revokes only the owner’s sessions', async () => {
    const { db, user } = await setup();
    const other = await createUser(db, { username: 'kim', password: 'long enough', role: 'viewer' }, 0);
    const phone = createSession(db, { userId: user.id, kind: 'bearer', label: 'iPhone' }, 5);
    createSession(db, { userId: user.id, kind: 'cookie', label: 'web' }, 6);

    expect(listBearerTokens(db, user.id)).toEqual([{ id: phone.id, label: 'iPhone', created_at: 5, last_used_at: 5 }]);
    expect(revokeSession(db, phone.id, other.id)).toBe(false);
    expect(revokeSession(db, phone.id, user.id)).toBe(true);
    expect(resolveSession(db, phone.token, 7)).toBeNull();
  });
});
