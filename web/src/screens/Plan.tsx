import type { Catalog } from '@carbbook/core';
import { useState } from 'react';
import { useCatalogData, useEligibleDoseVersions, usePlanData } from '../app/hooks';
import { useServices } from '../app/services';
import { buildCatalog } from '../db/catalog';
import { uuidv7 } from '../lib/ids';
import { applyCopy, conflictDates, type CopyMode, copyChanges } from '../plan/copy';
import { CopyDialog } from '../plan/CopyDialog';
import { goalView } from '../plan/goal';
import { SlotEditor } from '../plan/SlotEditor';
import { buildSlots, dayTotal, type Slot, windowsFor } from '../plan/slots';
import { dayKey, formatDayLabel, shiftDay, startOfWeek, weekDates } from '../ui/format';
import { itemName } from '../ui/ItemEditor';

export function Plan() {
  const { now, store } = useServices();
  const data = useCatalogData();
  const versions = useEligibleDoseVersions();
  const plan = usePlanData();
  const [monday, setMonday] = useState(() => startOfWeek(dayKey(now())));
  // A separate display value for the week-starting <input>: keeping the raw typed value in its
  // own state (even transiently empty, mid-edit) keeps React's DOM value tracker in sync on every
  // keystroke, which the snapped `monday` value alone does not when a snap resolves to an
  // unchanged Monday (no state change → no re-render → the native input value never resets).
  const [weekInput, setWeekInput] = useState(monday);
  const [editing, setEditing] = useState<{ date: string; windowName: string } | null>(null);
  const [copyForm, setCopyForm] = useState<{ from: string; to: string } | null>(null);
  const [pending, setPending] = useState<{ pairs: { from: string; to: string }[]; conflicts: string[] } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  if (!data || !versions || !plan) return <p>Loading…</p>;

  const catalog = buildCatalog(data);
  const dates = weekDates(monday);
  const byDate = new Map(
    dates.map((date) => [
      date,
      buildSlots({ dates: [date], windows: windowsFor(versions, date), entries: plan.entries, items: plan.items, catalog }),
    ]),
  );

  async function run(pairs: { from: string; to: string }[], mode: CopyMode) {
    const result = copyChanges({ pairs, entries: plan!.entries, items: plan!.items, mode, newId: () => uuidv7(now()) });
    await applyCopy(store, result);
    setPending(null);
    setCopyForm(null);
    setMessage(result.changes.length === 0 ? 'Nothing copied.' : `Copied ${pairs.length === 1 ? 'the day' : 'the week'}.`);
  }

  /** Asks replace/merge/skip only when at least one target day is not empty. */
  function start(pairs: { from: string; to: string }[]) {
    const conflicts = conflictDates(plan!.entries, pairs.map((p) => p.to));
    if (conflicts.length === 0) return void run(pairs, 'skip');
    setPending({ pairs, conflicts });
  }

  if (editing) {
    const slot = (byDate.get(editing.date) ?? []).find((s) => s.windowName === editing.windowName) ?? null;
    return (
      <SlotEditor
        date={editing.date}
        windowName={editing.windowName}
        slot={slot && slot.entry ? slot : null}
        data={data}
        onDone={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="screen plan">
      <h1>Plan</h1>
      <div className="day-nav">
        <button
          type="button"
          aria-label="Previous week"
          onClick={() => {
            const next = shiftDay(monday, -7);
            setMonday(next);
            setWeekInput(next);
          }}
        >
          ‹
        </button>
        <input
          type="date"
          aria-label="Week starting"
          value={weekInput}
          onChange={(e) => {
            const value = e.target.value;
            setWeekInput(value);
            if (value) {
              const snapped = startOfWeek(value);
              setMonday(snapped);
              setWeekInput(snapped);
            }
          }}
        />
        <button
          type="button"
          aria-label="Next week"
          onClick={() => {
            const next = shiftDay(monday, 7);
            setMonday(next);
            setWeekInput(next);
          }}
        >
          ›
        </button>
      </div>
      {message && (
        <p role="status" className="message">
          {message}
        </p>
      )}
      <div className="button-row">
        <button type="button" onClick={() => start(dates.map((date) => ({ from: date, to: shiftDay(date, 7) })))}>
          Copy week to next week
        </button>
      </div>
      {pending && (
        <CopyDialog conflicts={pending.conflicts} onChoose={(mode) => void run(pending.pairs, mode)} onCancel={() => setPending(null)} />
      )}
      {copyForm && (
        <form
          className="card"
          aria-label="Copy day"
          onSubmit={(e) => {
            e.preventDefault();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(copyForm.to)) {
              setCopyError('Enter a valid date to copy to.');
              return;
            }
            if (copyForm.to === copyForm.from) {
              setCopyError('Choose a different date to copy to.');
              return;
            }
            setCopyError(null);
            start([copyForm]);
          }}
        >
          <label>
            Copy to
            <input
              type="date"
              value={copyForm.to}
              onChange={(e) => setCopyForm({ ...copyForm, to: e.target.value })}
            />
          </label>
          {copyError && <p role="alert">{copyError}</p>}
          <div className="button-row">
            <button type="submit" className="primary">
              Copy
            </button>
            <button
              type="button"
              onClick={() => {
                setCopyForm(null);
                setCopyError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      <div className="plan-week">
        {dates.map((date) => (
          <section className="plan-day" key={date} aria-label={formatDayLabel(date)}>
            <h2>{formatDayLabel(date)}</h2>
            <button
              type="button"
              aria-label={`Copy ${formatDayLabel(date)} to another day`}
              onClick={() => {
                setCopyForm({ from: date, to: shiftDay(date, 1) });
                setCopyError(null);
              }}
            >
              Copy day
            </button>
            {(byDate.get(date) ?? []).length === 0 && <p className="muted">No time windows apply to this day.</p>}
            {(byDate.get(date) ?? []).map((slot) => (
              <PlanCell
                key={slot.key}
                slot={slot}
                catalog={catalog}
                onEdit={() => setEditing({ date: slot.date, windowName: slot.windowName })}
              />
            ))}
            <p className="total">
              <GoalReadout
                view={goalView(dayTotal(byDate.get(date) ?? []).carbs, dayTotal(byDate.get(date) ?? []).goal)}
                testId={`plan-day-total-${date}`}
              />
            </p>
          </section>
        ))}
      </div>
    </div>
  );
}

const STATUS_WORDS = { planned: 'planned', logged: 'logged', skipped: 'skipped' } as const;

function GoalReadout(props: { view: ReturnType<typeof goalView>; testId: string }) {
  const { view } = props;
  return (
    <span className={view.className} aria-label={view.ariaLabel} data-testid={props.testId}>
      <span aria-hidden="true">{view.text}</span>
      {view.word && (
        <span className="goal-word" aria-hidden="true">
          {view.word}
        </span>
      )}
    </span>
  );
}

function PlanCell(props: { slot: Slot; catalog: Catalog; onEdit: () => void }) {
  const { slot, catalog } = props;
  const view = goalView(slot.carbs, slot.goal);
  const names = slot.items.map((i) => itemName(catalog, i.ref_type, i.ref_id)).join(', ');
  return (
    <div className="plan-cell" data-testid={`plan-cell-${slot.date}-${slot.windowName}`}>
      <h3>{slot.windowName}</h3>
      {slot.entry ? (
        <>
          <p className="muted">{names || 'No items'}</p>
          <GoalReadout view={view} testId={`plan-carbs-${slot.date}-${slot.windowName}`} />
          <span className="tag">{STATUS_WORDS[slot.entry.status]}</span>
          <button type="button" aria-label={`Edit ${slot.windowName} on ${formatDayLabel(slot.date)}`} onClick={props.onEdit}>
            Edit
          </button>
        </>
      ) : (
        <button type="button" aria-label={`Add to ${slot.windowName} on ${formatDayLabel(slot.date)}`} onClick={props.onEdit}>
          +
        </button>
      )}
    </div>
  );
}
