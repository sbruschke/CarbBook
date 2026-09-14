import type { BgSource } from '@carbbook/core';
import type { BgPrefill, BgResult } from '../bg/bg';
import { formatAge, parseWholeNumber } from './format';

export interface BgEntry {
  mgdl: number | null;
  source: BgSource;
  trend: string | null;
}

/**
 * Dexcom prefill unless the user switched to manual entry; manual text otherwise (spec §4.4).
 *
 * Empty/whitespace manual text means "no BG" (`mgdl: null`) — the dose card shows its
 * "No BG entered" note and still estimates from carbs alone. Non-empty text that fails to
 * parse as a whole number ("12O", "-5", "1,5", "0x64", "1e3") is NOT the same thing: it must
 * not silently become "no BG" either, because that would show a dose number with the
 * correction silently dropped for a type 1 diabetic. It resolves to `mgdl: NaN` instead, which
 * core's `estimateDose` refuses outright (`invalid_input`) rather than guess.
 */
export function resolveBg(prefill: BgPrefill | null, manualMode: boolean, manualText: string): BgEntry {
  if (prefill && !manualMode) return { mgdl: prefill.mgdl, source: 'dexcom', trend: prefill.trend };
  if (manualText.trim() === '') return { mgdl: null, source: 'none', trend: null };
  const mgdl = parseWholeNumber(manualText);
  return { mgdl: mgdl === null ? Number.NaN : mgdl, source: 'manual', trend: null };
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
  const manualInvalid = props.manualText.trim() !== '' && parseWholeNumber(props.manualText) === null;
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
      {manualInvalid && (
        <p className="flag" data-testid="bg-invalid">
          Invalid BG — enter a whole number in mg/dL
        </p>
      )}
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
