import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './errors';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BEARER_PATTERN = /^Bearer\s+\S+/i;

/**
 * Bearer credentials are never attached by a browser to a cross-origin request, so
 * only cookie (ambient-credential) requests are CSRF-exposed. We only need the
 * *shape* of the header here, not a validated token: forging the header requires
 * script access this server already trusts (e.g. a legitimate API client), which a
 * malicious page making a simple cross-origin request cannot do.
 */
function isBearerAuthenticated(request: FastifyRequest): boolean {
  return BEARER_PATTERN.test(request.headers.authorization ?? '');
}

/**
 * CSRF hardening for cookie-authenticated state-changing requests under /api.
 *
 * A cross-origin `<form>` or `fetch(..., {mode: 'no-cors'})` submission can ride the
 * session cookie automatically, but browsers restrict such "simple" requests to a
 * small set of Content-Type values that excludes `application/json` (sending it
 * forces a CORS preflight, which our lack of CORS headers then blocks). Requiring
 * `application/json` on every mutating /api request therefore blocks cookie-riding
 * CSRF without needing a separate token. Bearer-authenticated (non-browser) clients
 * are exempt, since they carry no ambient credential to ride in the first place.
 */
export async function csrfContentTypeGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.url.startsWith('/api/')) return;
  if (!STATE_CHANGING_METHODS.has(request.method)) return;
  if (isBearerAuthenticated(request)) return;

  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
}
