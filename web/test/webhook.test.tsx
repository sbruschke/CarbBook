import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMeta, setMeta } from '../src/db/meta';
import { postWebhook, WebhookError } from '../src/lib/webhook';
import { LogEntryEditor } from '../src/log/LogEntryEditor';
import { Calculator } from '../src/screens/Calculator';
import { Settings } from '../src/screens/Settings';
import { foodData, synced } from './helpers';
import { makeServices, renderWith, seedSettings, type TestServices } from './render';

let services: TestServices;
afterEach(async () => {
  vi.unstubAllGlobals();
  await services.db.delete();
});

const HOOK = 'https://discord.com/api/webhooks/123456789012345678/token-here';

/** A fetch stub that records what was posted, answering with `status`. */
function stubFetch(status = 204) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(null, { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

async function setupCalculator() {
  services = makeServices();
  await seedSettings(services.db);
  await services.db.food.put(synced(foodData({ id: 'tortilla', name: 'Tortilla', carbs_per_100g: 48 })));
  return userEvent.setup();
}

async function addTortilla(user: ReturnType<typeof userEvent.setup>, grams: string) {
  await user.type(await screen.findByLabelText('Search foods and meals'), 'tort');
  await user.click(await screen.findByRole('button', { name: /Tortilla/ }));
  const amount = await screen.findByLabelText('Amount of Tortilla');
  await user.clear(amount);
  await user.type(amount, grams);
}

describe('postWebhook', () => {
  it('posts the message as Discord-shaped JSON without CarbBook cookies', async () => {
    services = makeServices();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    await postWebhook(HOOK, 'hello', { fetchImpl: fetchMock as unknown as typeof fetch });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(HOOK);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(String(init.body))).toEqual({ content: 'hello' });
  });

  it('names a wrong or deleted webhook rather than blaming the network', async () => {
    services = makeServices();
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(postWebhook(HOOK, 'hi', { fetchImpl: fetchMock as unknown as typeof fetch })).rejects.toThrow(
      /wrong or has been deleted/,
    );
  });

  it('gives up rather than hanging when the webhook never answers', async () => {
    services = makeServices();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    await expect(
      postWebhook(HOOK, 'hi', { fetchImpl: fetchMock as unknown as typeof fetch, timeoutMs: 5 }),
    ).rejects.toBeInstanceOf(WebhookError);
  });
});

describe('Webhook settings', () => {
  it('saves an https URL and refuses one that is not', async () => {
    services = makeServices();
    await seedSettings(services.db);
    const user = userEvent.setup();
    renderWith(<Settings />, services);

    const field = await screen.findByLabelText('Webhook URL');
    await user.type(field, 'http://discord.com/api/webhooks/1/abc');
    expect(screen.getByRole('alert')).toHaveTextContent('must start with https://');
    await user.click(screen.getByRole('button', { name: 'Save webhook' }));
    expect(await getMeta(services.db, 'webhook_url')).toBeUndefined();

    await user.clear(field);
    await user.type(field, HOOK);
    await user.click(screen.getByRole('button', { name: 'Save webhook' }));
    await waitFor(async () => expect(await getMeta(services.db, 'webhook_url')).toBe(HOOK));
    expect(screen.getByTestId('webhook-message')).toHaveTextContent('post to Discord');
  });

  it('clears the webhook when the field is emptied and saved', async () => {
    services = makeServices();
    await seedSettings(services.db);
    await setMeta(services.db, 'webhook_url', HOOK);
    const user = userEvent.setup();
    renderWith(<Settings />, services);

    await waitFor(() => expect(screen.getByLabelText('Webhook URL')).toHaveValue(HOOK));
    await user.clear(screen.getByLabelText('Webhook URL'));
    await user.click(screen.getByRole('button', { name: 'Save webhook' }));
    await waitFor(async () => expect(await getMeta(services.db, 'webhook_url')).toBeUndefined());
  });

  it('sends a test message that says what it is', async () => {
    services = makeServices();
    await seedSettings(services.db);
    await setMeta(services.db, 'webhook_url', HOOK);
    const calls = stubFetch();
    const user = userEvent.setup();
    renderWith(<Settings />, services);

    await waitFor(() => expect(screen.getByLabelText('Webhook URL')).toHaveValue(HOOK));
    await user.click(screen.getByRole('button', { name: 'Send test message' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(HOOK);
    expect((calls[0]!.body as { content: string }).content).toContain('CarbBook test message');
  });
});

describe('Calculator webhook posts', () => {
  it('posts the accountability text with a per-item breakdown when an entry is logged', async () => {
    const user = await setupCalculator();
    await setMeta(services.db, 'webhook_url', HOOK);
    const calls = stubFetch();
    renderWith(<Calculator />, services);
    await addTortilla(user, '150');
    await user.type(screen.getByLabelText('BG (mg/dL)'), '170');
    await user.click(screen.getByRole('button', { name: 'Log it' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    const content = (calls[0]!.body as { content: string }).content;
    expect(content).toContain('my blood sugar is 170.');
    expect(content).toContain('I am eating something with 72 carbs');
    expect(content).toContain('In it:\n• Tortilla — 150 g · 72 g carbs');
  });

  it('posts nothing when no webhook is set', async () => {
    const user = await setupCalculator();
    const calls = stubFetch();
    renderWith(<Calculator />, services);
    await addTortilla(user, '100');
    await user.click(screen.getByRole('button', { name: 'Log it' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Logged 48 g carbs');
    expect(calls).toHaveLength(0);
  });

  it('keeps the entry and says so when the webhook fails', async () => {
    const user = await setupCalculator();
    await setMeta(services.db, 'webhook_url', HOOK);
    stubFetch(404);
    renderWith(<Calculator />, services);
    await addTortilla(user, '100');
    await user.click(screen.getByRole('button', { name: 'Log it' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('wrong or has been deleted'));
    expect(screen.getByRole('status')).toHaveTextContent('Logged 48 g carbs');
    expect(await services.db.log_entry.count()).toBe(1);
  });

  it('does not post again when a logged entry is edited', async () => {
    const user = await setupCalculator();
    await setMeta(services.db, 'webhook_url', HOOK);
    const calls = stubFetch();
    renderWith(<Calculator />, services);
    await addTortilla(user, '100');
    await user.click(screen.getByRole('button', { name: 'Log it' }));
    await waitFor(() => expect(calls).toHaveLength(1));

    const entry = (await services.db.log_entry.toArray())[0]!;
    // The calculator must go first: two mounted trees would both answer to "Taken (units)".
    cleanup();
    renderWith(<LogEntryEditor entryId={entry.id} onDone={() => {}} />, services);
    const taken = await screen.findByLabelText('Taken dose (u)');
    await user.clear(taken);
    await user.type(taken, '9');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await services.db.log_entry.get(entry.id))?.taken_units).toBe(9));
    expect(calls).toHaveLength(1);
  });
});
