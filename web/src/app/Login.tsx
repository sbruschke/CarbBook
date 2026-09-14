import { useState } from 'react';
import { login, type LoginResult, loginErrorMessage } from '../auth/session';
import type { CarbBookDb } from '../db/db';
import type { Api } from '../lib/api';
import type { User } from '../lib/wire';

export function Login(props: { db: CarbBookDb; api: Api; message: string | null; onSignedIn: (user: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // login() may return with the new session live on the server but outboxConflict true: it
  // deliberately leaves the cached local user (and outbox) alone so a different signed-in user's
  // unsynced edits are never pushed under this session. Surface that before continuing.
  const [conflict, setConflict] = useState<LoginResult | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await login(props.db, props.api, username.trim(), password);
      if (result.outboxConflict) setConflict(result);
      else props.onSignedIn(result.user);
    } catch (e) {
      setError(loginErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (conflict) {
    return (
      <main className="login">
        <h1>CarbBook</h1>
        <p role="alert">
          {conflict.held!.count} unsynced change{conflict.held!.count === 1 ? '' : 's'} from {conflict.held!.username} are on this
          device. They are not being uploaded. Sign in as {conflict.held!.username} first to sync them, or continue as{' '}
          {conflict.user.username} and leave them queued for later.
        </p>
        <div className="button-row">
          <button type="button" className="primary" onClick={() => props.onSignedIn(conflict.user)}>
            Continue as {conflict.user.username}
          </button>
          <button type="button" onClick={() => setConflict(null)}>
            Cancel
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="login">
      <h1>CarbBook</h1>
      {props.message && <p className="note">{props.message}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          Username
          <input autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={busy || !username.trim() || !password}>
          Sign in
        </button>
      </form>
    </main>
  );
}
