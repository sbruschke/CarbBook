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

/**
 * Is this URL on a host the given provider serves image bytes from?
 *
 * Providers use this to drop candidates they know could never be adopted, so an unadoptable
 * result never reaches the picker. It is NOT a substitute for assertAdoptableUrl, which also
 * checks the scheme, credentials, port and resolved addresses — this is only the host gate.
 */
export function isProviderHost(url: string, provider: AdoptProvider): boolean {
  if (!URL.canParse(url)) return false;
  const hosts = PROVIDER_HOSTS[provider];
  if (!hosts) return false;
  const hostname = new URL(url).hostname.toLowerCase();
  return hosts.includes(hostname);
}

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

/**
 * Expand an IPv6 address to its 16 bytes, or return null when it is not a legal address.
 *
 * Written out rather than delegated to net.isIPv6 because we need the bytes, not merely a verdict
 * on validity: judging spellings is precisely what let hex encodings of private addresses through.
 * Handles "::" compression, the full eight-group form, and a trailing embedded dotted quad.
 */
function ipv6ToBytes(text: string): Uint8Array | null {
  if (!text.includes(':')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const compressed = halves.length === 2;

  /** One side of the "::", as bytes. A dotted quad is legal only as the very last group. */
  const sideToBytes = (side: string, isLastSide: boolean): number[] | null => {
    if (side === '') return [];
    const groups = side.split(':');
    const out: number[] = [];
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i]!;
      if (group.includes('.')) {
        if (!isLastSide || i !== groups.length - 1) return null;
        if (!isIPv4(group)) return null;
        for (const part of group.split('.')) out.push(Number(part));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      const value = Number.parseInt(group, 16);
      out.push(value >> 8, value & 0xff);
    }
    return out;
  };

  const left = sideToBytes(halves[0]!, !compressed);
  const right = compressed ? sideToBytes(halves[1]!, true) : [];
  if (left === null || right === null) return null;

  // Uncompressed must be exactly 16 bytes; "::" stands for at least one all-zero group, so a
  // compressed form must leave room for it.
  if (compressed ? left.length + right.length > 14 : left.length !== 16) return null;

  const bytes = new Uint8Array(16);
  bytes.set(left, 0);
  bytes.set(right, 16 - right.length);
  return bytes;
}

function ipv6IsPublic(bytes: Uint8Array): boolean {
  const b = bytes;
  const allZero = (from: number, to: number): boolean => b.subarray(from, to).every((byte) => byte === 0);
  const embeddedIpv4 = (): string => `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;

  if (allZero(0, 15) && b[15]! <= 1) return false;                        // unspecified ::, loopback ::1
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return false;             // link-local fe80::/10
  if ((b[0]! & 0xfe) === 0xfc) return false;                              // unique-local fc00::/7, incl. Tailscale's fd7a::/48
  if (b[0] === 0xff) return false;                                        // multicast ff00::/8

  // 6to4 and Teredo both embed an IPv4 address that may be private, and no legitimate provider
  // image host ever resolves into either range, so we refuse them wholesale rather than decode.
  if (b[0] === 0x20 && b[1] === 0x02) return false;                       // 6to4 2002::/16
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return false; // Teredo 2001:0::/32

  // Anything carrying an IPv4 address is judged by the IPv4 rules, whatever the spelling.
  const mapped = allZero(0, 10) && b[10] === 0xff && b[11] === 0xff;      // ::ffff:0:0/96
  const translated = allZero(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0; // ::ffff:0:0:0/96
  const nat64 = b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(4, 12); // 64:ff9b::/96
  const compatible = allZero(0, 12);                                      // deprecated ::/96
  if (mapped || translated || nat64 || compatible) return ipv4IsPublic(embeddedIpv4());

  return true;
}

export function isPublicAddress(address: string): boolean {
  if (isIPv4(address)) return ipv4IsPublic(address);
  const bytes = ipv6ToBytes(address.toLowerCase());
  if (bytes === null) return false;  // fail closed: an address we cannot normalise is never public
  return ipv6IsPublic(bytes);
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
