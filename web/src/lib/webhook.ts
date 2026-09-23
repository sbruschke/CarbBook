/**
 * Posting a log entry's message to the user's webhook. Discord's incoming-webhook endpoint is the
 * target it was built for — it sends permissive CORS headers, so the PWA can post directly and the
 * URL never has to reach the CarbBook server — but the payload (`{ content }`) is plain enough that
 * any endpoint accepting it works.
 *
 * Nothing here is allowed to break logging: every caller treats a failure as a note to show, never
 * as a reason to unwind a saved entry.
 */

/** Longer than this and the post is abandoned rather than left hanging after a save. */
const TIMEOUT_MS = 8000;

export class WebhookError extends Error {}

export async function postWebhook(
  url: string,
  content: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: controller.signal,
      // The webhook is a third party: never attach CarbBook's cookies to it.
      credentials: 'omit',
    });
  } catch (error) {
    throw new WebhookError(
      controller.signal.aborted ? 'The webhook did not answer in time.' : `Could not reach the webhook: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    // Discord's 401/404 for a deleted or mistyped webhook is the one worth naming: it means the
    // URL in settings is wrong, not that the network hiccupped.
    const reason = response.status === 401 || response.status === 403 || response.status === 404
      ? 'the webhook URL is wrong or has been deleted'
      : `the webhook answered ${response.status}`;
    throw new WebhookError(`Not sent: ${reason}.`);
  }
}
