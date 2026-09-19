import { describe, expect, it } from 'vitest';
import { assertAdoptableUrl, isPublicAddress, PROVIDER_HOSTS, UrlRejectedError } from '../src/images/urlguard';

/** Resolver stub: the guard never does real DNS in tests. */
const resolvesTo = (address: string) => async () => [{ address, family: address.includes(':') ? 6 : 4 }];
const publicResolver = resolvesTo('93.184.216.34');

describe('PROVIDER_HOSTS', () => {
  it('lists exactly the hosts each provider serves bytes from', () => {
    expect(PROVIDER_HOSTS).toEqual({
      openverse: ['api.openverse.org'],
      wikimedia: ['upload.wikimedia.org'],
      themealdb: ['www.themealdb.com'],
      off: ['images.openfoodfacts.org', 'static.openfoodfacts.org'],
    });
  });
});

describe('isPublicAddress', () => {
  it('rejects loopback, private, link-local, CGNAT and metadata addresses', () => {
    for (const address of [
      '127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.210',
      '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '::1', 'fe80::1', 'fc00::1', 'fd7a:115c:a1e0::8a37:bd0e', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('rejects private IPv4 addresses hidden in every IPv6 spelling', () => {
    // A resolver may hand back any legal encoding; judging spellings rather than the address
    // itself is what let these through before.
    for (const address of [
      '::ffff:7f00:1',           // IPv4-mapped 127.0.0.1, hex halves
      '0:0:0:0:0:ffff:7f00:1',   // the same, uncompressed
      '::ffff:a00:1',            // IPv4-mapped 10.0.0.1
      '::ffff:0:127.0.0.1',      // IPv4-translated ::ffff:0:0/96
      '::ffff:0:7f00:1',         // IPv4-translated, hex halves
      '::127.0.0.1',             // deprecated IPv4-compatible
      '::7f00:1',                // IPv4-compatible, hex halves
      '64:ff9b::7f00:1',         // NAT64 of 127.0.0.1
      '64:ff9b::a00:1',          // NAT64 of 10.0.0.1
      '64:ff9b::192.168.1.210',  // NAT64 of the Pi itself
      '2002:c0a8:1ca::1',        // 6to4 of 192.168.1.210
      '2001:0:c0a8:1ca::1',      // Teredo of 192.168.1.210
      '::',                      // unspecified
      'ff02::1',                 // multicast
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('rejects anything it cannot parse, including the empty string', () => {
    for (const address of ['', '   ', 'not-an-address', ':::1', '1:2:3:4:5:6:7:8:9', 'gggg::1', '::ffff:999.1.1.1']) {
      expect(isPublicAddress(address), JSON.stringify(address)).toBe(false);
    }
  });

  it('accepts ordinary public addresses', () => {
    for (const address of [
      '93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700::1111',
      '2001:4860:4860::8888',    // Google DNS: 2001:4860:, not Teredo's 2001:0:
      '2a02:ec80:600:ed1a::1',   // Wikimedia
    ]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });
});

describe('assertAdoptableUrl', () => {
  const ok = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/b/soup.jpg/800px-soup.jpg';

  it('accepts a provider URL that resolves publicly', async () => {
    await expect(assertAdoptableUrl(ok, 'wikimedia', { lookup: publicResolver })).resolves.toBeUndefined();
  });

  it('rejects http, credentials, a non-default port and a query-smuggled host', async () => {
    const bad = [
      'http://upload.wikimedia.org/x.jpg',
      'https://user:pass@upload.wikimedia.org/x.jpg',
      'https://upload.wikimedia.org:8080/x.jpg',
      'ftp://upload.wikimedia.org/x.jpg',
      'file:///etc/passwd',
      'https://upload.wikimedia.org.evil.test/x.jpg',
      'https://evil.test/x.jpg?host=upload.wikimedia.org',
      'not a url',
    ];
    for (const url of bad) {
      await expect(assertAdoptableUrl(url, 'wikimedia', { lookup: publicResolver }), url).rejects.toBeInstanceOf(UrlRejectedError);
    }
  });

  it('rejects a host belonging to a different provider', async () => {
    await expect(assertAdoptableUrl(ok, 'openverse', { lookup: publicResolver })).rejects.toBeInstanceOf(UrlRejectedError);
  });

  it('rejects an allowlisted host that resolves into a private range (DNS rebinding)', async () => {
    await expect(assertAdoptableUrl(ok, 'wikimedia', { lookup: resolvesTo('169.254.169.254') })).rejects.toBeInstanceOf(UrlRejectedError);
    await expect(assertAdoptableUrl(ok, 'wikimedia', { lookup: resolvesTo('::1') })).rejects.toBeInstanceOf(UrlRejectedError);
  });

  it('rejects when any resolved address is private, not just the first', async () => {
    const mixed = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ];
    await expect(assertAdoptableUrl(ok, 'wikimedia', { lookup: mixed })).rejects.toBeInstanceOf(UrlRejectedError);
  });

  it('rejects when DNS fails', async () => {
    const fails = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(assertAdoptableUrl(ok, 'wikimedia', { lookup: fails })).rejects.toBeInstanceOf(UrlRejectedError);
  });
});

/**
 * Adversarial cases. These pin down the behaviour that makes the two gates hold, so that a later
 * refactor of either gate cannot quietly reopen one of them.
 */
describe('assertAdoptableUrl under attack', () => {
  const guard = (url: string) => assertAdoptableUrl(url, 'wikimedia', { lookup: publicResolver });

  it('rejects IP-literal hosts in every spelling WHATWG normalises', async () => {
    // WHATWG parses all of these into an IP literal, and no IP literal equals an allowlisted
    // name, so the hostname gate stops them before DNS is ever consulted.
    for (const url of [
      'https://3232235986/x.jpg',          // decimal, = 192.168.1.210
      'https://2130706433/x.jpg',          // decimal, = 127.0.0.1
      'https://0xc0a80101/x.jpg',          // hex, = 192.168.1.1
      'https://0177.0.0.1/x.jpg',          // octal, = 127.0.0.1
      'https://[::1]/x.jpg',               // bracketed loopback
      'https://[::ffff:127.0.0.1]/x.jpg',  // bracketed IPv4-mapped loopback
      'https://[fd7a:115c:a1e0::1]/x.jpg', // bracketed tailnet address
    ]) {
      await expect(guard(url), url).rejects.toBeInstanceOf(UrlRejectedError);
    }
  });

  it('rejects a trailing-dot host, which WHATWG keeps verbatim', async () => {
    // url.hostname is "upload.wikimedia.org." — not an exact match, so it is refused. That is the
    // safe direction to fail in: a fully-qualified spelling is merely unusable, never trusted.
    await expect(guard('https://upload.wikimedia.org./x.jpg')).rejects.toBeInstanceOf(UrlRejectedError);
  });

  it('rejects lookalike and encoded-separator hostnames', async () => {
    for (const url of [
      'https://upload.wikimediа.org/x.jpg',            // Cyrillic а, punycoded to xn--wikimedi-86g
      'https://xn--upload-wikimedia-evil.test/x.jpg',  // punycode that merely reads like the host
      'https://upload.wikimedia.org%2eevil.test/x.jpg', // %2e decodes to a label separator
      'https://upload.wikimedia.org.evil.test./x.jpg',
      'https://wikimedia.org/x.jpg',                   // the parent domain is not an image host
    ]) {
      await expect(guard(url), url).rejects.toBeInstanceOf(UrlRejectedError);
    }
  });

  it('rejects userinfo trickery, where the real host follows the @', async () => {
    // WHATWG reads everything before the last @ as userinfo: the host here is evil.test.
    for (const url of [
      'https://upload.wikimedia.org@evil.test/x.jpg',
      'https://evil.test\\@upload.wikimedia.org/x.jpg',
      'https://user@upload.wikimedia.org/x.jpg',   // caught by the credentials gate instead
      'https://:pass@upload.wikimedia.org/x.jpg',
    ]) {
      await expect(guard(url), url).rejects.toBeInstanceOf(UrlRejectedError);
    }
  });

  it('rejects empty, blank and non-http(s) schemes', async () => {
    for (const url of ['', '   ', 'javascript:alert(1)', 'data:image/jpeg;base64,AAAA', '//upload.wikimedia.org/x.jpg']) {
      await expect(guard(url), url).rejects.toBeInstanceOf(UrlRejectedError);
    }
  });

  it('rejects a host that resolves to nothing', async () => {
    const empty = async () => [];
    await expect(assertAdoptableUrl('https://upload.wikimedia.org/x.jpg', 'wikimedia', { lookup: empty }))
      .rejects.toBeInstanceOf(UrlRejectedError);
  });

  it('accepts spellings WHATWG normalises back to the genuine host', async () => {
    for (const url of [
      'https://UPLOAD.WIKIMEDIA.ORG/x.jpg',                    // case folded by the parser
      'https://upload。wikimedia。org/x.jpg',                    // ideographic full stops become dots
      'https://upload.wikimedia.org:443/x.jpg',                 // the default port is stripped
      '  https://upload.wikimedia.org/x.jpg  ',                 // surrounding whitespace is trimmed
      'https://upload.wikimedia.org#@evil.test/x.jpg',          // the @ lands in the fragment
      'https://upload.wikimedia.org/x.jpg?next=http://169.254.169.254/', // a query cannot move the host
    ]) {
      await expect(guard(url), url).resolves.toBeUndefined();
    }
  });
});
