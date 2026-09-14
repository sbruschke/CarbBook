import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      host: '0.0.0.0',
      port: 3000,
      databasePath: '/data/carbbook.db',
      webDir: null,
      usdaDir: '/data/usda',
      dexcomApiUrl: 'http://dexcom-api:8000',
      dexcomApiToken: null,
      offBaseUrl: 'https://world.openfoodfacts.org',
      offUserAgent: 'CarbBook/0.1 (https://recipes.dxshdw.dev)',
      httpTimeoutMs: 5000,
      cookieSecure: true,
      trustProxy: false,
    });
  });

  it('reads overrides and trims trailing slashes from URLs', () => {
    const config = loadConfig({
      PORT: '8080',
      WEB_DIR: '/srv/web',
      DEXCOM_API_URL: 'http://localhost:9000/',
      DEXCOM_API_TOKEN: 'secret',
      COOKIE_SECURE: 'false',
      TRUST_PROXY: 'true',
    });
    expect(config.port).toBe(8080);
    expect(config.webDir).toBe('/srv/web');
    expect(config.dexcomApiUrl).toBe('http://localhost:9000');
    expect(config.dexcomApiToken).toBe('secret');
    expect(config.cookieSecure).toBe(false);
    expect(config.trustProxy).toBe(true);
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ COOKIE_SECURE: 'maybe' })).toThrow(ConfigError);
    expect(() => loadConfig({ OFF_BASE_URL: 'not a url' })).toThrow(ConfigError);
  });
});
