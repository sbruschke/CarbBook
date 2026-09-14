import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { ApiError } from '../errors';
import { resolveSession, SESSION_TTL_MS, type SessionKind } from './sessions';
import type { User } from './users';

export const SESSION_COOKIE = 'carbbook_session';

export interface AuthContext {
  user: User;
  sessionId: string;
  kind: SessionKind;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export function sessionCookieOptions(ctx: AppContext) {
  return {
    path: '/',
    httpOnly: true,
    secure: ctx.config.cookieSecure,
    sameSite: 'lax' as const,
    maxAge: SESSION_TTL_MS / 1000,
  };
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1]! : null;
}

/** onRequest hook: accepts `Authorization: Bearer <token>` (iOS) or the session cookie (web). */
export function makeAuthenticate(ctx: AppContext) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const bearer = bearerToken(request);
    const token = bearer ?? request.cookies[SESSION_COOKIE] ?? null;
    if (!token) throw new ApiError(401, 'unauthorized', 'Sign in required');
    const resolved = resolveSession(ctx.db, token, ctx.deps.now());
    if (!resolved) throw new ApiError(401, 'unauthorized', 'Session expired or revoked');
    request.auth = { user: resolved.user, sessionId: resolved.session.id, kind: resolved.session.kind };
    if (resolved.renewed && bearer === null && resolved.session.kind === 'cookie') {
      reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(ctx));
    }
  };
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new ApiError(401, 'unauthorized', 'Sign in required');
  return request.auth;
}
