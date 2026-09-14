import { useEffect, useMemo, useState } from 'react';
import { Login } from './app/Login';
import { type Services, ServicesProvider } from './app/services';
import { Shell } from './app/Shell';
import { logout, restoreSession, type Session } from './auth/session';
import { type StartScanner, startScanner as browserScanner } from './barcode/scanner';
import type { CarbBookDb } from './db/db';
import { getDeviceId } from './db/meta';
import { createStore } from './db/store';
import type { Api } from './lib/api';
import { SIGNED_OUT_MESSAGE, SyncEngine } from './sync/engine';
import { syncOnce } from './sync/sync';
import { syncUsdaLibrary } from './usda/bundle';

type Boot = { phase: 'loading' } | { phase: 'ready'; deviceId: string; session: Session };

export function App(props: { db: CarbBookDb; api: Api; startScanner?: StartScanner }) {
  const { db, api } = props;
  const startScanner = props.startScanner ?? browserScanner;
  const [boot, setBoot] = useState<Boot>({ phase: 'loading' });
  const signOutLocally = () => setBoot((b) => (b.phase === 'ready' ? { ...b, session: { status: 'signed_out' } } : b));

  // Auth expiry keeps IndexedDB (and the outbox) intact and just shows the login screen (spec §9).
  const engine = useMemo(() => new SyncEngine({ run: () => syncOnce(db, api), onAuthExpired: signOutLocally }), [db, api]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const deviceId = await getDeviceId(db);
      const session = await restoreSession(db, api);
      if (!cancelled) setBoot({ phase: 'ready', deviceId, session });
    })();
    return () => {
      cancelled = true;
    };
  }, [db, api]);

  const deviceId = boot.phase === 'ready' ? boot.deviceId : null;
  const user = boot.phase === 'ready' && boot.session.status === 'signed_in' ? boot.session.user : null;
  const userId = user?.id ?? null;

  useEffect(() => {
    if (userId === null) return;
    engine.resume();
    engine.start();
    syncUsdaLibrary(db, api).catch((error: unknown) => console.warn('USDA library update failed', error));
    return () => engine.stop();
  }, [userId, engine, db, api]);

  const store = useMemo(() => (deviceId ? createStore(db, deviceId, { onWrite: engine.requestSync }) : null), [db, deviceId, engine]);

  const services = useMemo<Services | null>(
    () =>
      store && user
        ? {
            db,
            api,
            store,
            engine,
            user,
            now: Date.now,
            startScanner,
            signOut: async () => {
              await logout(db, api);
              engine.stop();
              signOutLocally();
            },
          }
        : null,
    [db, api, store, engine, user, startScanner],
  );

  if (boot.phase === 'loading' || !store) return <p className="boot">Loading CarbBook…</p>;
  if (!services) {
    return (
      <Login
        db={db}
        api={api}
        message={engine.getStatus().phase === 'signed_out' ? SIGNED_OUT_MESSAGE : null}
        onSignedIn={(signedIn) =>
          setBoot((b) => (b.phase === 'ready' ? { ...b, session: { status: 'signed_in', user: signedIn, offline: false } } : b))
        }
      />
    );
  }
  return (
    <ServicesProvider services={services}>
      <Shell />
    </ServicesProvider>
  );
}
