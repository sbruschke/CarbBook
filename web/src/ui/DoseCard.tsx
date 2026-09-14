import { type DoseEstimate, formatBreakdown, recentDoseWarning } from '@carbbook/core';
import { refusalMessage } from '../dose/dose';
import { formatTime, formatUnits } from './format';

/**
 * Dose display (spec §4.3 step 7, §9): always labelled an estimate with core's breakdown;
 * a refusal shows its reason and never a number.
 */
export function DoseCard(props: {
  /** null when no dose settings apply at this time. */
  estimate: DoseEstimate | null;
  hasItems: boolean;
  bg: number | null;
  lastDoseAt: number | null;
  now: number;
}) {
  const { estimate } = props;
  return (
    <section className="card dose" aria-label="Dose estimate">
      <h2>Dose estimate</h2>
      {!props.hasItems ? (
        <p className="muted">Add foods or meals to estimate a dose.</p>
      ) : estimate === null ? (
        <p role="alert">No dose estimate: no dose settings apply at this time. Sync, or add settings in Settings.</p>
      ) : estimate.ok ? (
        <>
          <p className="dose-units">
            <span data-testid="dose-units">{formatUnits(estimate.units)}</span> <span className="tag">estimate</span>
          </p>
          <p className="breakdown" data-testid="dose-breakdown">
            {formatBreakdown(estimate)}
          </p>
          {props.bg === null && <p className="note">No BG entered: correction not included.</p>}
        </>
      ) : (
        <p role="alert" data-testid="dose-refusal">
          {refusalMessage(estimate.reason)}
        </p>
      )}
      {props.lastDoseAt !== null && recentDoseWarning(props.lastDoseAt, props.now) && (
        <p role="alert" className="warning">
          A dose was logged at {formatTime(props.lastDoseAt)}, within the last 4 hours. This estimate does not subtract
          insulin on board.
        </p>
      )}
      <p className="fineprint">Estimate only. Check it before dosing.</p>
    </section>
  );
}
