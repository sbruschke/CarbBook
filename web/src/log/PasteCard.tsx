import { clearClipboard, type Clipboard, useClipboard } from './clipboard';

/**
 * "Copied: Lunch · Tue 6 Oct (3 items) — Paste / Clear", shown above an item list while the in-app
 * clipboard holds something. Pasting appends and leaves the clipboard as it is, so the same meal
 * can go into several slots; Clear is how it goes away.
 */
export function PasteCard(props: { onPaste: (clipboard: Clipboard) => void }) {
  const clipboard = useClipboard();
  if (!clipboard) return null;
  const count = clipboard.items.length;
  return (
    <section className="card paste-card" data-testid="paste-card">
      <p>
        Copied: {clipboard.source} · {count} {count === 1 ? 'item' : 'items'}
      </p>
      <div className="button-row">
        <button type="button" className="primary" onClick={() => props.onPaste(clipboard)}>
          Paste
        </button>
        <button type="button" onClick={clearClipboard}>
          Clear
        </button>
      </div>
    </section>
  );
}
