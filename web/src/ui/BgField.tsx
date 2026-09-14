import type { BgSource } from '@carbbook/core';
import type { BgPrefill, BgResult } from '../bg/bg';
import { formatAge, parseNonNegative } from './format';

export interface BgEntry {
  mgdl: number | null;
  source: BgSource;
  trend: string | null;
}

/** Dexcom prefill unless the user switched to manual entry; manual text otherwise (spec §4.4). */
export function resolveBg(prefill: BgPrefill | null, manualMode: boolean, manualText: string): BgEntry {
  if (prefill && !manualMode) return { mgdl: prefill.mgdl, source: 'dexcom', trend: prefill.trend };
  const mgdl = parseNonNegative(manualText);
  return mgdl === null ? { mgdl: null, source: 'none', trend: null } : { mgdl, source: 'manual', trend: null };
}

function statusNote(status: BgResult | null): string {
  if (status === null) return 'Loading Dexcom…';
  if (status.kind === 'offline') return 'Offline: enter BG manually.';
  if (status.kind === 'unavailable') return `Dexcom unavailable (${status.message}): enter BG manually.`;
  return 'No Dexcom reading from the last 15 minutes: enter BG manually.';
}

export function BgField(props: {
  status: BgResult | null;
  prefill: BgPrefill | null;
  manualMode: boolean;
  manualText: string;
  onManualModeChange: (manual: boolean) => void;
  onManualTextChange: (text: string) => void;
}) {
  const { prefill } = props;
  if (prefill && !props.manualMode) {
    return (
      <div className="bg-field">
        <p data-testid="bg-reading">
          BG <strong>{prefill.mgdl}</strong> {prefill.arrow ?? ''} · {formatAge(prefill.age_ms)} (Dexcom)
        </p>
        <button type="button" onClick={() => props.onManualModeChange(true)}>
          Enter BG manually
        </button>
      </div>
    );
  }
  return (
    <div className="bg-field">
      <label>
        BG (mg/dL)
        <input inputMode="numeric" value={props.manualText} onChange={(e) => props.onManualTextChange(e.target.value)} />
      </label>
      {prefill ? (
        <button type="button" onClick={() => props.onManualModeChange(false)}>
          Use Dexcom {prefill.mgdl}
        </button>
      ) : (
        <p className="note">{statusNote(props.status)}</p>
      )}
    </div>
  );
}
