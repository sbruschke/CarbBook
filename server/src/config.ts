export interface Config {
  host: string;
  port: number;
  databasePath: string;
  /** Directory holding the built web PWA; null disables static serving. */
  webDir: string | null;
  /** Where USDA bundle files and manifest.json are written and served from. */
  usdaDir: string;
  /** Where normalised image bytes are stored, content-addressed. */
  imageDir: string;
  dexcomApiUrl: string;
  dexcomApiToken: string | null;
  offBaseUrl: string;
  offUserAgent: string;
  httpTimeoutMs: number;
  cookieSecure: boolean;
  trustProxy: boolean;
}

export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

function text(env: Env, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

function optionalText(env: Env, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function boolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${name} must be true or false, got "${raw}"`);
}

function absoluteUrl(env: Env, name: string, fallback: string): string {
  const value = text(env, name, fallback);
  if (!URL.canParse(value)) throw new ConfigError(`${name} must be an absolute URL, got "${value}"`);
  return value.replace(/\/+$/, '');
}

export function loadConfig(env: Env = process.env): Config {
  return {
    host: text(env, 'HOST', '0.0.0.0'),
    port: integer(env, 'PORT', 3000, 1, 65535),
    databasePath: text(env, 'DATABASE_PATH', '/data/carbbook.db'),
    webDir: optionalText(env, 'WEB_DIR'),
    usdaDir: text(env, 'USDA_DIR', '/data/usda'),
    imageDir: text(env, 'IMAGE_DIR', '/data/images'),
    dexcomApiUrl: absoluteUrl(env, 'DEXCOM_API_URL', 'http://dexcom-api:8000'),
    dexcomApiToken: optionalText(env, 'DEXCOM_API_TOKEN'),
    offBaseUrl: absoluteUrl(env, 'OFF_BASE_URL', 'https://world.openfoodfacts.org'),
    offUserAgent: text(env, 'OFF_USER_AGENT', 'CarbBook/0.1 (https://recipes.dxshdw.dev)'),
    httpTimeoutMs: integer(env, 'HTTP_TIMEOUT_MS', 5000, 100, 60000),
    cookieSecure: boolean(env, 'COOKIE_SECURE', true),
    trustProxy: boolean(env, 'TRUST_PROXY', false),
  };
}
