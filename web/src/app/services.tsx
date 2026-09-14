import { createContext, type ReactNode, useContext } from 'react';
import type { StartScanner } from '../barcode/scanner';
import type { CarbBookDb } from '../db/db';
import type { Store } from '../db/store';
import type { Api } from '../lib/api';
import type { User } from '../lib/wire';
import type { SyncEngine } from '../sync/engine';

/** Everything a signed-in screen needs; tests pass fakes. */
export interface Services {
  db: CarbBookDb;
  api: Api;
  store: Store;
  engine: SyncEngine;
  user: User;
  now: () => number;
  startScanner: StartScanner;
  /** Signs out (Settings); App swaps to the login screen. */
  signOut: () => Promise<void>;
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices must be used inside <ServicesProvider>');
  return services;
}
