import type { Config } from './config';
import type { Db } from './db';

/** External HTTP services and the clock, injected so tests never touch the network. */
export interface AppDeps {
  now: () => number;
}

export interface AppContext {
  db: Db;
  config: Config;
  deps: AppDeps;
}
