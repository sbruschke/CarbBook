import { activeSettings, type DoseSettingsData } from '@carbbook/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState, useSyncExternalStore } from 'react';
import { useEligibleDoseVersions } from '../app/hooks';
import { useServices } from '../app/services';
import { getMeta } from '../db/meta';
import { NetworkError } from '../lib/api';
import { DoseSettingsEditor } from '../settings/DoseSettingsEditor';
import type { SyncPhase } from '../sync/engine';
import { dayKey, formatTime } from '../ui/format';
import { syncUsdaLibrary } from '../usda/bundle';

export const PHASE_TEXT: Record<SyncPhase, string> = {
  idle: 'Up to date',
  syncing: 'Syncing…',
  offline: 'Offline: changes sync when you reconnect',
  error: 'Sync failed; retrying automatically',
  signed_out: 'Signed out: sign in again to sync',
};

export const pendingText = (n: number) => `${n} pending change${n === 1 ? '' : 's'}`;
const when = (ms: number) => `${dayKey(ms)} ${formatTime(ms)}`;

const BLANK_SETTINGS: DoseSettingsData = {
  id: '',
  effective_from: 0,
  windows: [],
  correction: { threshold: Number.NaN, step: Number.NaN, units_per_step: Number.NaN, mode: 'started' },
  rounding: { increment: Number.NaN, round_down_below_bg: null },
};

function DoseSettingsSection() {
  const { user, now } = useServices();
  // Never the raw dose_settings table: excludes any version with a recorded server rejection,
  // both for picking "active" and for the editable version history (spec safety rule).
  const versions = useEligibleDoseVersions();
  const [draft, setDraft] = useState<DoseSettingsData | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (!versions) return <p>Loading…</p>;
  const active = activeSettings(versions, now());
  const canEdit = user.role === 'owner';
  const sorted = [...versions].sort((a, b) => b.effective_from - a.effective_from);

  return (
    <section className="card" aria-label="Dose settings">
      <h2>Dose settings</h2>
      {message && <p role="status">{message}</p>}
      {!canEdit && <p className="note">Only the owner can change dose settings.</p>}
      {draft ? (
        <DoseSettingsEditor
          initial={draft}
          onDone={(saved) => {
            setDraft(null);
            setMessage(saved ? 'Saved a new dose settings version.' : null);
          }}
        />
      ) : (
        canEdit && (
          <button
            type="button"
            className="primary"
            onClick={() => {
              setMessage(null);
              setDraft(active ?? BLANK_SETTINGS);
            }}
          >
            Edit dose settings
          </button>
        )
      )}
      <h3>Version history</h3>
      <ul className="list">
        {sorted.map((v) => (
          <li key={v.id} className="version" data-testid="settings-version">
            <p>
              <strong>From {when(v.effective_from)}</strong> {v.id === active?.id && <span className="tag">active</span>}
            </p>
            <p className="muted">{v.windows.map((w) => `${w.name} ${w.start} 1:${w.ratio_g_per_unit}`).join(' · ')}</p>
            <p className="muted">
              Correction above {v.correction.threshold}: {v.correction.units_per_step} u per {v.correction.step} mg/dL ({v.correction.mode});
              round to {v.rounding.increment} u{v.rounding.round_down_below_bg == null ? '' : `, down below BG ${v.rounding.round_down_below_bg}`}
            </p>
            {canEdit && !draft && (
              <button type="button" onClick={() => setDraft(v)}>
                Start a new version from this
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SyncSection() {
  const { db, engine } = useServices();
  const status = useSyncExternalStore(engine.subscribe, engine.getStatus);
  const pending = useLiveQuery(() => db.outbox.count(), [db]) ?? 0;
  const lastSynced = useLiveQuery(() => getMeta(db, 'last_synced_at'), [db]);
  const errors = useLiveQuery(() => db.sync_error.orderBy('at').reverse().toArray(), [db]) ?? [];
  return (
    <section className="card" aria-label="Sync">
      <h2>Sync</h2>
      <p data-testid="sync-phase">{PHASE_TEXT[status.phase]}</p>
      {status.error && <p role="alert">{status.error}</p>}
      <p data-testid="pending-count">{pendingText(pending)}</p>
      <p data-testid="last-synced">Last synced: {lastSynced ? when(lastSynced) : 'never'}</p>
      <button type="button" onClick={() => void engine.syncNow()}>
        Sync now
      </button>
      {errors.length > 0 && (
        <>
          <h3>Rejected by the server</h3>
          <p className="note">These changes were not saved on the server. Edit the item to try again.</p>
          <ul className="list">
            {errors.map((error) => (
              <li key={error.key} className="pending-row">
                <span>
                  {error.table} {error.id}: {error.message}
                </span>
                <button type="button" onClick={() => void db.sync_error.delete(error.key)}>
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function LibrarySection() {
  const { db, api } = useServices();
  const version = useLiveQuery(() => getMeta(db, 'usda_version'), [db]);
  const count = useLiveQuery(() => db.usda_food.count(), [db]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check() {
    setBusy(true);
    try {
      const result = await syncUsdaLibrary(db, api);
      if (result.status === 'not_imported') setMessage('The server has no USDA library yet.');
      else if (result.status === 'up_to_date') setMessage('USDA library is up to date.');
      else setMessage(`Downloaded USDA library ${result.version} (${result.food_count} foods).`);
    } catch (error) {
      setMessage(error instanceof NetworkError ? 'Offline: try again when connected.' : error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-label="USDA library">
      <h2>USDA library</h2>
      <p>{version ? `${version} · ${count ?? 0} foods on this device` : 'Not downloaded yet'}</p>
      <button type="button" disabled={busy} onClick={() => void check()}>
        Check for USDA update
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}

function AccountSection() {
  const { db, user, signOut } = useServices();
  const pending = useLiveQuery(() => db.outbox.count(), [db]) ?? 0;
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSignOut() {
    if (pending > 0 && !confirming) {
      setConfirming(true);
      return;
    }
    try {
      await signOut();
    } catch (e) {
      setError(`Sign out failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <section className="card" aria-label="Account">
      <h2>Account</h2>
      <p>
        Signed in as <strong>{user.username}</strong> ({user.role})
      </p>
      {confirming && (
        <p role="alert">
          {pendingText(pending)} will stay on this device and sync after you sign in again. Tap Sign out again to continue.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button type="button" className="danger" onClick={() => void onSignOut()}>
        Sign out
      </button>
    </section>
  );
}

export function Settings() {
  return (
    <div className="screen">
      <h1>Settings</h1>
      <DoseSettingsSection />
      <SyncSection />
      <LibrarySection />
      <AccountSection />
    </div>
  );
}
