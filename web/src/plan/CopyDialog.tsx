import type { CopyMode } from './copy';

/**
 * Asked once per copy action (not once per day): the chosen mode applies to every conflicting
 * date, which are listed so the choice is informed.
 */
export function CopyDialog(props: { conflicts: string[]; onChoose: (mode: CopyMode) => void; onCancel: () => void }) {
  return (
    <div className="card" role="dialog" aria-modal="true" aria-label="Target already has plans">
      <p>
        {props.conflicts.length === 1 ? 'This day already has plans:' : 'These days already have plans:'}{' '}
        {props.conflicts.join(', ')}
      </p>
      <div className="button-row">
        <button type="button" onClick={() => props.onChoose('replace')}>
          Replace
        </button>
        <button type="button" onClick={() => props.onChoose('merge')}>
          Merge
        </button>
        <button type="button" onClick={() => props.onChoose('skip')}>
          Skip
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
