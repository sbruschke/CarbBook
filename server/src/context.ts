import type { BgClient } from './bg/client';
import type { Config } from './config';
import type { Db } from './db';
import type { ImageSearchProvider } from './images/providers/types';
import type { ImageStore } from './images/store';
import type { OffClient } from './off/client';

/** External HTTP services and the clock, injected so tests never touch the network. */
export interface AppDeps {
  now: () => number;
  bg: BgClient;
  off: OffClient;
  /** Image byte store; see src/images/store.ts. */
  images: ImageStore;
  /** Search providers, in the order they are offered. */
  imageProviders: ImageSearchProvider[];
  /** Fetches an already-guarded URL for adoption. Separate from provider search so tests can stub it. */
  fetchImage: (url: string) => Promise<Buffer>;
  /** Hostname resolution for the adopt guard. Injected so route tests stay hermetic. */
  dnsLookup?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

export interface AppContext {
  db: Db;
  config: Config;
  deps: AppDeps;
}
