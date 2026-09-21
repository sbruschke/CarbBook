import { accountabilityText } from '@carbbook/core';
import { useEffect, useState } from 'react';
import { formatStamp } from './format';

/**
 * The copy-pasteable accountability message for a log entry. The text is always visible and
 * selectable, so it can be copied by hand when the Clipboard API is unavailable (an insecure
 * origin, or a browser that refuses without a user gesture it recognises).
 */
export function AccountabilityText(props: { eatenAt: number; bg: number | null; carbs: number; units: number | null }) {
  const text = accountabilityText({
    when: Number.isFinite(props.eatenAt) ? formatStamp(props.eatenAt) : 'an unknown time',
    bg_mgdl: props.bg,
    carbs_g: props.carbs,
    units: props.units,
  });
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');

  // The message changes as the fields above it are edited; a stale "Copied" would claim the
  // clipboard holds something it does not.
  useEffect(() => setCopied('idle'), [text]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  }

  return (
    <section className="accountability">
      <h2>Accountability text</h2>
      <textarea readOnly aria-label="Accountability text" data-testid="accountability-text" rows={4} value={text} onFocus={(e) => e.currentTarget.select()} />
      <div className="button-row">
        <button type="button" onClick={() => void copy()}>
          Copy text
        </button>
        {copied !== 'idle' && (
          <span role="status" className="muted">
            {copied === 'ok' ? 'Copied.' : 'Could not copy — select the text and copy it by hand.'}
          </span>
        )}
      </div>
    </section>
  );
}
