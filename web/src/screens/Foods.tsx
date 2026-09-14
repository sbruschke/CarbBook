import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useServices } from '../app/services';
import { type BarcodeResolution, resolveBarcode } from '../barcode/resolve';
import { isLive } from '../db/db';
import { FoodEditor } from '../foods/FoodEditor';
import { type FoodPrefill, prefillFromDraft } from '../foods/label';
import { formatCarbs, formatTime } from '../ui/format';
import { ScannerDialog } from '../ui/ScannerDialog';

type Mode = { kind: 'list' } | { kind: 'edit'; id: string } | { kind: 'new'; prefill?: FoodPrefill };

const SOURCE = { custom: 'My food', off: 'Open Food Facts', usda: 'USDA' } as const;

export function Foods() {
  const { db, api, now } = useServices();
  const foods = useLiveQuery(() => db.food.filter(isLive).toArray(), [db]);
  const pending = useLiveQuery(() => db.pending_barcode.toArray(), [db]);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [filter, setFilter] = useState('');
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const editId = mode.kind === 'edit' ? mode.id : null;
  const editing = useLiveQuery(
    async () =>
      editId
        ? { food: await db.food.get(editId), portions: await db.portion.where('food_id').equals(editId).filter(isLive).toArray() }
        : null,
    [db, editId],
  );

  function apply(result: BarcodeResolution) {
    switch (result.kind) {
      case 'local':
      case 'known':
        setMessage(`Already saved: ${result.food.name}`);
        setMode({ kind: 'edit', id: result.food.id });
        return;
      case 'draft':
        setMessage(null);
        setMode({ kind: 'new', prefill: prefillFromDraft(result.draft) });
        return;
      case 'manual':
        setMessage(null);
        setMode({ kind: 'new', prefill: { barcode: result.code, note: result.message } });
        return;
      case 'queued':
        setMessage(`No connection. Barcode ${result.code} is saved to look up when you're back online.`);
        return;
    }
  }

  async function lookUp(code: string) {
    setScanning(false);
    try {
      apply(await resolveBarcode(db, api, code, now));
    } catch (error) {
      setMessage(`Barcode lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const done = () => setMode({ kind: 'list' });
  if (mode.kind === 'new') return <FoodEditor prefill={mode.prefill} onDone={done} />;
  if (mode.kind === 'edit') {
    if (!editing?.food) return <p>Loading…</p>;
    return <FoodEditor key={editing.food.id} existing={{ food: editing.food, portions: editing.portions }} onDone={done} />;
  }

  const needle = filter.trim().toLowerCase();
  const shown = (foods ?? [])
    .filter((f) => !needle || `${f.name} ${f.brand ?? ''}`.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="screen">
      <h1>Foods</h1>
      {message && (
        <p role="status" className="message">
          {message}
        </p>
      )}
      <div className="button-row">
        <button type="button" className="primary" onClick={() => setMode({ kind: 'new' })}>
          New food
        </button>
        <button type="button" onClick={() => setScanning(true)}>
          Scan barcode
        </button>
      </div>
      {scanning && <ScannerDialog onCode={(code) => void lookUp(code)} onClose={() => setScanning(false)} />}
      {pending && pending.length > 0 && (
        <section className="card" aria-label="Barcodes to look up">
          <h2>Look up later</h2>
          <ul className="list">
            {pending.map((row) => (
              <li key={row.code} className="pending-row">
                <span>
                  {row.code} <span className="muted">scanned {formatTime(row.created_at)}</span>
                </span>
                <button type="button" onClick={() => void lookUp(row.code)}>
                  Look up
                </button>
                <button type="button" onClick={() => void db.pending_barcode.delete(row.code)}>
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <input type="search" aria-label="Filter foods" placeholder="Filter saved foods" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ul className="list">
        {shown.map((food) => (
          <li key={food.id}>
            <button type="button" className="list-item" onClick={() => setMode({ kind: 'edit', id: food.id })}>
              <span>{food.name}</span>
              <span className="muted">
                {[food.brand, SOURCE[food.source ?? 'custom'], food.carbs_per_100g === null ? 'no carb data' : `${formatCarbs(food.carbs_per_100g)} / 100 g`]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {foods && shown.length === 0 && <p className="muted">No saved foods{needle ? ' match' : ' yet'}.</p>}
    </div>
  );
}
