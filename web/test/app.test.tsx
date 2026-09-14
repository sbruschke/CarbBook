import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import type { CarbBookDb } from '../src/db/db';
import { setMeta } from '../src/db/meta';
import { createStore } from '../src/db/store';
import { ApiError, NetworkError } from '../src/lib/api';
import { SIGNED_OUT_MESSAGE } from '../src/sync/engine';
import { FakeApi, foodData, openTestDb } from './helpers';
import { noScanner, OWNER, VIEWER } from './render';

let db: CarbBookDb;
afterEach(async () => {
  window.history.replaceState(null, '', '/');
  await db.delete();
});

function serverApi() {
  return new FakeApi()
    .on('GET', '/api/sync/pull', () => ({ changes: [], next_since: 0, has_more: false }))
    .on('GET', '/api/usda/manifest', () => {
      throw new ApiError(404, 'usda_not_imported', 'not imported');
    })
    .on('GET', '/api/bg', () => {
      throw new ApiError(503, 'bg_unavailable', 'dexcom-api unreachable');
    });
}

describe('App', () => {
  it('signs in, then navigates between screens', async () => {
    db = openTestDb();
    const api = serverApi()
      .on('GET', '/api/auth/me', () => {
        throw new ApiError(401, 'unauthorized', 'Sign in required');
      })
      .on('POST', '/api/auth/login', () => ({ user: OWNER }));
    const user = userEvent.setup();
    render(<App db={db} api={api} startScanner={noScanner} />);
    await user.type(await screen.findByLabelText('Username'), 'brett');
    await user.type(screen.getByLabelText('Password'), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Calculator' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Foods' }));
    expect(await screen.findByRole('heading', { name: 'Foods' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/foods');
    await waitFor(() => expect(api.calls.some((c) => c.path.startsWith('/api/sync/pull'))).toBe(true));
  });

  it('shows login errors', async () => {
    db = openTestDb();
    const api = serverApi()
      .on('GET', '/api/auth/me', () => {
        throw new ApiError(401, 'unauthorized', 'Sign in required');
      })
      .on('POST', '/api/auth/login', () => {
        throw new ApiError(401, 'invalid_credentials', 'Wrong username or password');
      });
    const user = userEvent.setup();
    render(<App db={db} api={api} startScanner={noScanner} />);
    await user.type(await screen.findByLabelText('Username'), 'brett');
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong username or password');
  });

  it('opens offline with the last signed-in user', async () => {
    db = openTestDb();
    await setMeta(db, 'user', OWNER);
    const offline = () => {
      throw new NetworkError('Failed to fetch');
    };
    const api = new FakeApi().on('GET', '/api/auth/me', offline).on('GET', '/api/sync/pull', offline).on('GET', '/api/bg', offline);
    render(<App db={db} api={api} startScanner={noScanner} />);
    expect(await screen.findByRole('heading', { name: 'Calculator' })).toBeInTheDocument();
    expect(await screen.findByText('Offline: enter BG manually.')).toBeInTheDocument();
  });

  it('returns to the login screen when the session expires, keeping unsynced changes', async () => {
    db = openTestDb();
    await createStore(db, 'device-a').save('food', foodData({ id: 'f1' }));
    const api = serverApi()
      .on('GET', '/api/auth/me', () => ({ user: OWNER }))
      .on('POST', '/api/sync/push', () => {
        throw new ApiError(401, 'unauthorized', 'Session expired or revoked');
      });
    render(<App db={db} api={api} startScanner={noScanner} />);
    expect(await screen.findByText(SIGNED_OUT_MESSAGE)).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(await db.outbox.count()).toBe(1);
  });

  it('holds a different user’s unsynced changes instead of pushing them under a new session, even across a reload', async () => {
    db = openTestDb();
    // brett has an unsynced edit queued and cached locally, as if signed in on this device already.
    await setMeta(db, 'user', OWNER);
    await createStore(db, 'device-old', { owner: OWNER }).save('food', foodData({ id: 'f1' }));

    let pushedTables: string[] = [];
    const api = serverApi()
      .on('GET', '/api/auth/me', () => {
        throw new ApiError(401, 'unauthorized', 'Sign in required');
      })
      .on('POST', '/api/auth/login', () => ({ user: VIEWER }))
      .on('POST', '/api/sync/push', (body) => {
        const changes = (body as { changes: { table: string; record: { id: string } }[] }).changes;
        pushedTables.push(...changes.map((c) => c.table));
        return { results: changes.map((c) => ({ table: c.table, id: c.record.id, status: 'accepted', server_seq: 1 })), server_seq: 1 };
      });
    const user = userEvent.setup();
    const { unmount } = render(<App db={db} api={api} startScanner={noScanner} />);
    await user.type(await screen.findByLabelText('Username'), 'kim');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('1 unsynced change from brett');
    await user.click(screen.getByRole('button', { name: 'Continue as kim' }));
    expect(await screen.findByRole('heading', { name: 'Calculator' })).toBeInTheDocument();
    await waitFor(() => expect(api.calls.some((c) => c.path.startsWith('/api/sync/pull'))).toBe(true));

    // Never pushed under kim's session; still queued, still owned by brett.
    expect(pushedTables).toEqual([]);
    expect(await db.outbox.count()).toBe(1);
    expect((await db.outbox.toArray())[0]).toMatchObject({ ownerId: OWNER.id });
    unmount();

    // Reload: the server now answers /api/auth/me as kim (the live cookie), so restoreSession
    // overwrites the cached local user to kim — but ownership lives on the outbox entry, not the
    // cache, so brett's change is still held.
    api.on('GET', '/api/auth/me', () => ({ user: VIEWER }));
    const { unmount: unmount2 } = render(<App db={db} api={api} startScanner={noScanner} />);
    expect(await screen.findByRole('heading', { name: 'Calculator' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Settings' }));
    expect(await screen.findByText(/1 unsynced change from brett is held on this device/)).toBeInTheDocument();
    unmount2();
    window.history.replaceState(null, '', '/');

    // brett signs back in: no false conflict, and their held change now pushes normally.
    pushedTables = [];
    api.on('GET', '/api/auth/me', () => {
      throw new ApiError(401, 'unauthorized', 'Sign in required');
    }).on('POST', '/api/auth/login', () => ({ user: OWNER }));
    render(<App db={db} api={api} startScanner={noScanner} />);
    await user.type(await screen.findByLabelText('Username'), 'brett');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Calculator' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(pushedTables).toEqual(['food']));
    await waitFor(async () => expect(await db.outbox.count()).toBe(0));
  });
});
