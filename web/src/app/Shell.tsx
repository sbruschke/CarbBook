import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Calculator } from '../screens/Calculator';
import { Foods } from '../screens/Foods';
import { Log } from '../screens/Log';
import { Meals } from '../screens/Meals';
import { Settings } from '../screens/Settings';
import type { SyncPhase } from '../sync/engine';
import { useServices } from './services';

interface Route {
  path: string;
  label: string;
  render: () => ReactNode;
}

export const ROUTES: Route[] = [
  { path: '/', label: 'Calculator', render: () => <Calculator /> },
  { path: '/foods', label: 'Foods', render: () => <Foods /> },
  { path: '/meals', label: 'Meals', render: () => <Meals /> },
  { path: '/log', label: 'Log', render: () => <Log /> },
  { path: '/settings', label: 'Settings', render: () => <Settings /> },
];

export function routeFor(pathname: string): Route {
  return ROUTES.find((r) => r.path !== '/' && (pathname === r.path || pathname.startsWith(`${r.path}/`))) ?? ROUTES[0]!;
}

/** Minimal history-API router; the server falls back to index.html for these paths. */
function usePath(): [string, (path: string) => void] {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((next: string) => {
    if (next !== window.location.pathname) window.history.pushState(null, '', next);
    setPath(next);
  }, []);
  return [path, navigate];
}

const BADGE: Record<SyncPhase, string> = { idle: '', syncing: 'Syncing…', offline: 'Offline', error: 'Sync error', signed_out: 'Signed out' };

export function Shell() {
  const { db, engine } = useServices();
  const status = useSyncExternalStore(engine.subscribe, engine.getStatus);
  const pending = useLiveQuery(() => db.outbox.count(), [db]) ?? 0;
  const [path, navigate] = usePath();
  const route = routeFor(path);
  const badge = [BADGE[status.phase], pending > 0 ? `${pending} pending` : ''].filter(Boolean).join(' · ');

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">CarbBook</span>
        <span data-testid="sync-badge">{badge}</span>
      </header>
      <main>{route.render()}</main>
      <nav className="tabbar" aria-label="Main">
        {ROUTES.map((r) => (
          <a
            key={r.path}
            href={r.path}
            aria-current={r === route ? 'page' : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate(r.path);
            }}
          >
            {r.label}
          </a>
        ))}
      </nav>
    </div>
  );
}
