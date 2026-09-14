import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { type Config, loadConfig } from '../src/config';
import type { AppDeps } from '../src/context';
import type { Db } from '../src/db';
import { initDatabase } from '../src/init';

export const T0 = Date.parse('2026-09-14T17:00:00Z');

export class TestClock {
  constructor(public ms = T0) {}
  now = () => this.ms;
  advance(ms: number) {
    this.ms += ms;
  }
}

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
  const app = await buildApp({ db, config, deps: { now: clock.now, ...options.deps } });
  return { app, db, clock, config };
}
