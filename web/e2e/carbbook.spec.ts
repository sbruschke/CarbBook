import { expect, test } from '@playwright/test';

const USERNAME = 'brett';
const PASSWORD = 'e2e password';
const PB = 'Peanut butter, smooth style, with salt';
const KALE = 'Kale, raw';

type Record = { [field: string]: unknown };

test('log, save and edit a meal, then log offline and sync on reconnect (spec §10)', async ({ page, context, playwright, baseURL }) => {
  // Login
  await page.goto('/');
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Calculator' })).toBeVisible();

  // Search the downloaded USDA library and add items with units
  await page.getByLabel('Search foods and meals').fill('peanut');
  await page.getByRole('button', { name: new RegExp(PB) }).click();
  await page.getByLabel(`Amount of ${PB}`).fill('10');
  await page.getByLabel(`Unit for ${PB}`).selectOption('tbsp');
  await page.getByLabel('Search foods and meals').fill('kale');
  await page.getByRole('button', { name: new RegExp(KALE) }).click();
  await page.getByLabel('BG (mg/dL)').fill('120');
  await expect(page.getByTestId('dose-breakdown')).toContainText('BG 120');
  await expect(page.getByText('estimate', { exact: true })).toBeVisible();

  // Save as meal, then log
  await page.getByRole('button', { name: 'Save as meal' }).click();
  await page.getByLabel('Meal name').fill('PB kale bowl');
  await page.getByLabel('Yield (servings)').fill('2');
  await page.getByRole('button', { name: 'Save meal' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved meal "PB kale bowl".');
  await page.getByRole('button', { name: 'Log it' }).click();
  await expect(page.getByRole('status')).toContainText('Logged 40.1 g carbs');

  // Edit the meal: 200 g kale → (35.68 + 8.84) / 2 = 22.3 g per serving
  await page.getByRole('link', { name: 'Meals' }).click();
  await page.getByRole('button', { name: /PB kale bowl/ }).click();
  await page.getByLabel(`Amount of ${KALE}`).fill('200');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: /PB kale bowl/ })).toContainText('22.3 g per serving');

  // Everything reaches the server
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('pending-count')).toHaveText('0 pending changes');

  // Offline: the service worker serves the app shell, logging still works. Navigate back to
  // Calculator first: the history-API router preserves whatever path was current across a
  // reload (correct SPA behaviour), and this test wants to log a second entry after reconnecting.
  await page.getByRole('link', { name: 'Calculator' }).click();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Calculator' })).toBeVisible();
  await page.getByLabel('Search foods and meals').fill('PB kale');
  await page.getByRole('button', { name: /PB kale bowl/ }).click();
  await page.getByLabel('BG (mg/dL)').fill('180');
  await page.getByRole('button', { name: 'Log it' }).click();
  await expect(page.getByRole('status')).toContainText('Logged');
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('sync-phase')).toHaveText('Offline: changes sync when you reconnect');
  await expect(page.getByTestId('pending-count')).toHaveText('2 pending changes');

  // Reconnect: the engine syncs on the online event
  await context.setOffline(false);
  await expect(page.getByTestId('pending-count')).toHaveText('0 pending changes', { timeout: 15_000 });

  // Verify server state through the API
  const api = await playwright.request.newContext({ baseURL });
  expect((await api.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } })).ok()).toBe(true);
  const pull = (await (await api.get('/api/sync/pull?since=0&limit=1000')).json()) as { changes: { table: string; record: Record }[] };
  const rows = (table: string) => pull.changes.filter((c) => c.table === table).map((c) => c.record);

  expect(rows('log_entry').map((e) => e.bg_mgdl).sort()).toEqual([120, 180]);
  expect(rows('meal')).toEqual([expect.objectContaining({ name: 'PB kale bowl', yield_servings: 2, deleted: 0 })]);
  expect(rows('meal_item').find((i) => i.ref_id === 'usda-323505')).toMatchObject({ amount: 200, unit: 'g' });
  expect(rows('food').map((f) => f.id).sort()).toEqual(['usda-323505', 'usda-324860']);
  expect(rows('log_item').find((i) => i.ref_type === 'meal')).toMatchObject({ display_name: 'PB kale bowl', amount: 1, unit: 'serving' });
  await api.dispose();
});

test('plan a slot, copy the day, load it in the Calculator and log offline, then sync (spec §7)', async ({
  page,
  context,
  playwright,
  baseURL,
}) => {
  await page.goto('/');
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Calculator' })).toBeVisible();

  // Plan today's Lunch. The Plan screen's week always contains today, so the cell is on screen.
  const today = await page.evaluate(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });
  await page.getByRole('link', { name: 'Plan' }).click();
  await page.getByTestId(`plan-cell-${today}-Lunch`).getByRole('button').click();
  await page.getByLabel('Add to this slot').fill('peanut');
  await page.getByRole('button', { name: new RegExp(PB) }).click();
  await page.getByLabel(`Amount of ${PB}`).fill('2');
  await page.getByLabel(`Unit for ${PB}`).selectOption('tbsp');
  await page.getByRole('button', { name: 'Save slot' }).click();
  await expect(page.getByTestId(`plan-cell-${today}-Lunch`)).toContainText(PB);
  await expect(page.getByTestId(`plan-carbs-${today}-Lunch`)).toContainText('g');

  // Copy the day to tomorrow (empty target → no conflict dialog). Scoped to today's own
  // <section>: a plain .first() would grab Monday's button, which has nothing planned to copy.
  const todaySection = page.locator('.plan-day', { has: page.getByTestId(`plan-cell-${today}-Lunch`) });
  await todaySection.getByRole('button', { name: /^Copy .* to another day$/ }).click();
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Copied the day');

  // Go offline, load the plan in the Calculator and log it. The suggestion only appears for the
  // CURRENT window, which "Auto" only resolves to Lunch when the real wall clock is between
  // 11:00 and 14:00 — select Lunch explicitly so the test doesn't depend on the time of day it runs.
  await page.getByRole('link', { name: 'Calculator' }).click();
  await page.getByLabel('Window').selectOption('Lunch');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await context.setOffline(true);
  await page.reload();
  await page.getByLabel('Window').selectOption('Lunch');
  await expect(page.getByTestId('plan-suggestion')).toContainText('Planned:');
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.getByLabel(`Amount of ${PB}`)).toHaveValue('2');
  await page.getByRole('button', { name: 'Log it' }).click();
  await expect(page.getByRole('status')).toContainText('Logged');

  // The plan slot now reads "logged" even offline.
  await page.getByRole('link', { name: 'Plan' }).click();
  await expect(page.getByTestId(`plan-cell-${today}-Lunch`)).toContainText('logged');

  // Reconnect and drain the outbox.
  await context.setOffline(false);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('pending-count')).toHaveText('0 pending changes', { timeout: 15_000 });

  // The server has the plan rows, the link and the copy.
  const api = await playwright.request.newContext({ baseURL });
  expect((await api.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } })).ok()).toBe(true);
  const pull = (await (await api.get('/api/sync/pull?since=0&limit=1000')).json()) as { changes: { table: string; record: Record }[] };
  const rows = (table: string) => pull.changes.filter((c) => c.table === table).map((c) => c.record);

  const planned = rows('plan_entry').filter((e) => e.deleted === 0);
  const loggedSlot = planned.find((e) => e.date === today && e.window_name === 'Lunch')!;
  expect(loggedSlot.status).toBe('logged');
  expect(typeof loggedSlot.log_entry_id).toBe('string');
  expect(rows('log_entry').some((e) => e.id === loggedSlot.log_entry_id)).toBe(true);
  expect(planned.filter((e) => e.date !== today && e.window_name === 'Lunch')).toHaveLength(1);
  expect(rows('plan_item').filter((i) => i.deleted === 0).length).toBeGreaterThanOrEqual(2);
  await api.dispose();
});
