import type { FastifyInstance } from 'fastify';
import { requireAuth, SESSION_COOKIE, sessionCookieOptions } from '../auth/plugin';
import { hashPassword, verifyPassword } from '../auth/passwords';
import { createSession, revokeSession } from '../auth/sessions';
import { findUserByUsername } from '../auth/users';
import type { AppContext } from '../context';
import { ApiError } from '../errors';

interface LoginBody {
  username: string;
  password: string;
  client?: 'web' | 'ios';
  device_name?: string;
}

let dummyHash: Promise<string> | null = null;
/** Verifying against a throwaway hash keeps unknown-user logins as slow as wrong-password logins. */
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('carbbook-timing-equalizer');
  return dummyHash;
}

export async function loginRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post<{ Body: LoginBody }>(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          additionalProperties: false,
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 64 },
            password: { type: 'string', minLength: 1, maxLength: 256 },
            client: { type: 'string', enum: ['web', 'ios'] },
            device_name: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      const { username, password, client = 'web', device_name } = request.body;
      const user = findUserByUsername(ctx.db, username);
      const ok = user
        ? await verifyPassword(user.password_hash, password)
        : (await verifyPassword(await getDummyHash(), password), false);
      if (!user || !ok) throw new ApiError(401, 'invalid_credentials', 'Wrong username or password');

      const publicUser = { id: user.id, username: user.username, role: user.role };
      const now = ctx.deps.now();
      if (client === 'ios') {
        const { token, id } = createSession(ctx.db, { userId: user.id, kind: 'bearer', label: device_name ?? 'iOS' }, now);
        return { user: publicUser, token, token_id: id };
      }
      const { token } = createSession(ctx.db, { userId: user.id, kind: 'cookie', label: device_name ?? 'web' }, now);
      reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(ctx));
      return { user: publicUser };
    },
  );
}

/** Registered inside the authenticated scope. */
export async function sessionRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/auth/me', async (request) => ({ user: requireAuth(request).user }));

  app.post('/api/auth/logout', async (request, reply) => {
    const auth = requireAuth(request);
    revokeSession(ctx.db, auth.sessionId, auth.user.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
