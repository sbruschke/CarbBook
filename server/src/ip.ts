import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import type { Config } from './config';

/**
 * The only network path to this server is `cloudflared` on `pi_net` (no published
 * ports), so `request.ip` is never trustworthy on its own: Fastify's `trustProxy`
 * would take the *leftmost* X-Forwarded-For entry, which is fully client-controlled.
 *
 * When `TRUST_PROXY` is on, trust only Cloudflare's `CF-Connecting-IP` header (set by
 * Cloudflare's edge, not forwarded from the client) after validating it parses as an
 * IP address; otherwise fall back to the raw socket address. When `TRUST_PROXY` is
 * off, always use the raw socket address and ignore proxy headers entirely.
 */
export function clientIp(request: FastifyRequest, config: Config): string {
  if (config.trustProxy) {
    const header = request.headers['cf-connecting-ip'];
    const value = Array.isArray(header) ? header[0] : header;
    if (value && isIP(value.trim())) return value.trim();
  }
  return request.ip;
}
