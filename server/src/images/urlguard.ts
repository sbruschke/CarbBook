import { lookup as dnsLookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';

/**
 * The SSRF boundary for POST /api/images/adopt, which fetches a URL a client supplied.
 *
 * Two independent gates, both required:
 *   1. The host must be one the named provider itself serves bytes from. We never adopt from the
 *      arbitrary origin an Openverse or Commons result points at — only from the provider's own
 *      host — which is what keeps this list short enough to be auditable.
 *   2. Every address that host resolves to must be public, which blocks a DNS entry (hostile or
 *      compromised) pointing an allowlisted name at the Pi's LAN, the loopback interface, the
 *      Tailscale range, or a cloud metadata endpoint.
 */
export class UrlRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlRejectedError';
  }
}

export type AdoptProvider = 'openverse' | 'wikimedia' | 'themealdb' | 'off';

/** Exact hostnames, never suffix matches: "upload.wikimedia.org.evil.test" must not pass. */
export const PROVIDER_HOSTS: Record<AdoptProvider, string[]> = {
  openverse: ['api.openverse.org'],
  wikimedia: ['upload.wikimedia.org'],
  themealdb: ['www.themealdb.com'],
  off: ['images.openfoodfacts.org', 'static.openfoodfacts.org'],
};

type LookupResult = { address: string; family: number };
export interface UrlGuardOptions {
  /** Injected so tests never touch real DNS. */
  lookup?: (hostname: string) => Promise<LookupResult[]>;
}

const defaultLookup = (hostname: string): Promise<LookupResult[]> => dnsLookup(hostname, { all: true, verbatim: true });

function ipv4IsPublic(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;                    // this-network, private, loopback
  if (a === 169 && b === 254) return false;                              // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return false;                     // private
  if (a === 192 && b === 168) return false;                              // private
  if (a === 100 && b >= 64 && b <= 127) return false;                    // CGNAT, which Tailscale uses
  if (a === 192 && b === 0) return false;                                // IETF protocol assignments
  if (a >= 224) return false;                                            // multicast, reserved, broadcast
  return true;
}

export function isPublicAddress(address: string): boolean {
  if (isIPv4(address)) return ipv4IsPublic(address);
  const lower = address.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) must be judged by its IPv4 half.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return ipv4IsPublic(mapped[1]!);
  if (lower === '::' || lower === '::1') return false;                   // unspecified, loopback
  if (lower.startsWith('fe80')) return false;                            // link-local
  if (/^f[cd]/.test(lower)) return false;                                // unique-local, incl. Tailscale's fd7a::/48
  if (lower.startsWith('ff')) return false;                              // multicast
  return true;
}

export async function assertAdoptableUrl(
  raw: string,
  provider: AdoptProvider,
  options: UrlGuardOptions = {},
): Promise<void> {
  if (!URL.canParse(raw)) throw new UrlRejectedError('not a URL');
  const url = new URL(raw);

  if (url.protocol !== 'https:') throw new UrlRejectedError('only https URLs can be adopted');
  if (url.username !== '' || url.password !== '') throw new UrlRejectedError('URL must not carry credentials');
  if (url.port !== '') throw new UrlRejectedError('URL must use the default https port');

  const allowed = PROVIDER_HOSTS[provider];
  if (!allowed) throw new UrlRejectedError(`unknown provider ${provider}`);
  if (!allowed.includes(url.hostname.toLowerCase())) {
    throw new UrlRejectedError(`${url.hostname} is not a host ${provider} serves images from`);
  }

  let addresses: LookupResult[];
  try {
    addresses = await (options.lookup ?? defaultLookup)(url.hostname);
  } catch (error) {
    throw new UrlRejectedError(`could not resolve ${url.hostname}: ${(error as Error).message}`);
  }
  if (addresses.length === 0) throw new UrlRejectedError(`${url.hostname} resolved to nothing`);
  for (const { address } of addresses) {
    if (!isPublicAddress(address)) {
      throw new UrlRejectedError(`${url.hostname} resolves to a non-public address`);
    }
  }
}
