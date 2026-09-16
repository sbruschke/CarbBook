import { useState } from 'react';
import { useCatalogData, useEligibleDoseVersions, usePlanData } from '../app/hooks';
import { useServices } from '../app/services';
import { buildCatalog } from '../db/catalog';
import { SlotEditor } from '../plan/SlotEditor';
import { buildSlots, type Slot, windowsFor } from '../plan/slots';
import { dayKey, formatDayLabel, shiftDay, startOfWeek, weekDates } from '../ui/format';

export function Plan() {
  const { now } = useServices();
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

  if (!data || !versions || !plan) return <p>Loading…</p>;

  const catalog = buildCatalog(data);
  const dates = weekDates(monday);
  const byDate = new Map(
    dates.map((date) => [
      date,
      buildSlots({ dates: [date], windows: windowsFor(versions, date), entries: plan.entries, items: plan.items, catalog }),
    ]),
  );

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
      <div className="plan-week">
        {dates.map((date) => (
          <section className="plan-day" key={date} aria-label={formatDayLabel(date)}>
            <h2>{formatDayLabel(date)}</h2>
            {(byDate.get(date) ?? []).length === 0 && <p className="muted">No time windows apply to this day.</p>}
            {(byDate.get(date) ?? []).map((slot) => (
              <PlanCell key={slot.key} slot={slot} onEdit={() => setEditing({ date: slot.date, windowName: slot.windowName })} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function PlanCell(props: { slot: Slot; onEdit: () => void }) {
  const { slot } = props;
  return (
    <div className="plan-cell" data-testid="plan-cell">
      <h3>{slot.windowName}</h3>
      <button type="button" onClick={props.onEdit}>
        {slot.entry ? 'Edit' : '+'}
      </button>
    </div>
  );
}
