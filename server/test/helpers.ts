import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { createUser, type Role, type User } from '../src/auth/users';
import type { BgClient } from '../src/bg/client';
import { type Config, loadConfig } from '../src/config';
import type { AppDeps } from '../src/context';
import type { Db } from '../src/db';
import { initDatabase } from '../src/init';
import type { OffClient } from '../src/off/client';

export const TEST_PASSWORD = 'correct horse battery';
export const T0 = Date.parse('2026-09-14T17:00:00Z');

export class TestClock {
  constructor(public ms = T0) {}
  now = () => this.ms;
  advance(ms: number) {
    this.ms += ms;
  }
}

export const unusedBg: BgClient = {
  latest: () => Promise.reject(new Error('bg client not stubbed in this test')),
};

export const unusedOff: OffClient = {
  lookup: () => Promise.reject(new Error('off client not stubbed in this test')),
};

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  clock: TestClock;
  config: Config;
}

export async function makeTestApp(
  options: { env?: Record<string, string>; deps?: Partial<AppDeps> } = {},
): Promise<TestApp> {
  const config = loadConfig({ DATABASE_PATH: ':memory:', COOKIE_SECURE: 'false', ...options.env });
  const db = initDatabase(':memory:');
  const clock = new TestClock();
  const app = await buildApp({ db, config, deps: { now: clock.now, bg: unusedBg, off: unusedOff, ...options.deps } });
  return { app, db, clock, config };
}

export function addUser(db: Db, username: string, role: Role, password = TEST_PASSWORD): Promise<User> {
  return createUser(db, { username, password, role }, T0);
}

/** Logs in as a web client and returns the Cookie header value to send on later requests. */
export async function loginCookie(app: FastifyInstance, username: string, password = TEST_PASSWORD): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  if (response.statusCode !== 200) throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  const cookie = response.cookies.find((c) => c.name === 'carbbook_session');
  if (!cookie) throw new Error('no session cookie');
  return `carbbook_session=${cookie.value}`;
}

/** Logs in as the iOS client and returns an Authorization header value. */
export async function loginBearer(app: FastifyInstance, username: string, password = TEST_PASSWORD): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password, client: 'ios', device_name: 'Test iPhone' },
  });
  if (response.statusCode !== 200) throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  return `Bearer ${response.json().token}`;
}
