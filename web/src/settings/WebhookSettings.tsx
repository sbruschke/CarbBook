import { isDiscordWebhookUrl, webhookMessage, webhookUrlProblem } from '@carbbook/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useServices } from '../app/services';
import { deleteMeta, getMeta, setMeta } from '../db/meta';
import { postWebhook, WebhookError } from '../lib/webhook';
import { formatStamp } from '../ui/format';

/** What a test post says, so a channel that receives one knows why. */
export function testMessage(now: number): string {
  return webhookMessage({
    when: formatStamp(now),
    bg_mgdl: 120,
    carbs_g: 45,
    units: 4,
    items: [
      { name: 'CarbBook test message', amount: '', carbs_g: Number.NaN },
      { name: 'Example food', amount: '1 cup', carbs_g: 45 },
    ],
  });
}

/**
 * The webhook a log posts to. Set per device on purpose: the URL is the whole secret for posting
 * into a chat, so it stays in this browser's IndexedDB rather than syncing to the server and to
 * every other device that signs in.
 */
export function WebhookSettings() {
  const { db, now } = useServices();
  const saved = useLiveQuery(() => getMeta(db, 'webhook_url'), [db]);
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // `saved` is undefined both while the query runs and when no webhook was ever set; an empty
  // field is the right showing for either, and an unsaved draft always wins over both.
  const value = draft ?? saved ?? '';
  const problem = value.trim() === '' ? null : webhookUrlProblem(value);

  async function save() {
    const trimmed = value.trim();
    if (trimmed === '') {
      await deleteMeta(db, 'webhook_url');
      setDraft(null);
      setMessage('Webhook cleared. Logging posts nothing from this device.');
      return;
    }
    const bad = webhookUrlProblem(trimmed);
    if (bad) return setMessage(bad);
    await setMeta(db, 'webhook_url', trimmed);
    setDraft(null);
    setMessage(isDiscordWebhookUrl(trimmed) ? 'Saved. New log entries post to Discord.' : 'Saved. New log entries post to this URL.');
  }

  async function test() {
    const trimmed = value.trim();
    const bad = webhookUrlProblem(trimmed);
    if (bad) return setMessage(bad);
    setBusy(true);
    setMessage(null);
    try {
      await postWebhook(trimmed, testMessage(now()));
      setMessage('Test message sent.');
    } catch (error) {
      setMessage(error instanceof WebhookError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-label="Webhook">
      <h2>Webhook</h2>
      <p className="note">
        When this device logs an entry, the accountability text is posted here, with a breakdown of what was in the meal. Paste a
        Discord channel&apos;s webhook URL (Channel settings → Integrations → Webhooks → Copy Webhook URL). Editing an entry later posts
        nothing — only logging does.
      </p>
      <label>
        Webhook URL
        <input
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://discord.com/api/webhooks/…"
          aria-label="Webhook URL"
          data-testid="webhook-url"
          value={value}
          onChange={(e) => {
            setDraft(e.target.value);
            setMessage(null);
          }}
        />
      </label>
      {problem && <p role="alert">{problem}</p>}
      <p className="note">
        This URL is kept on this device only — it is never synced to the server or to your other devices. Anyone who has it can post to
        that channel, so treat it like a password.
      </p>
      <div className="button-row">
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          Save webhook
        </button>
        <button type="button" disabled={busy || value.trim() === ''} onClick={() => void test()}>
          Send test message
        </button>
      </div>
      {message && (
        <p role="status" data-testid="webhook-message">
          {message}
        </p>
      )}
    </section>
  );
}
