import type { LogEntryData, LogItemData } from '@carbbook/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCatalogData } from '../src/db/catalog';
import { CLIPBOARD_KEY, copyToClipboard, pasteRows, readClipboard } from '../src/log/clipboard';
import { daysBetween, logReport, rangeLabel, reportLabels } from '../src/log/exportReport';
import { reportHtml } from '../src/log/reportHtml';
import { SlotEditor } from '../src/plan/SlotEditor';
import { Calculator } from '../src/screens/Calculator';
import { Log } from '../src/screens/Log';
import { foodData, synced } from './helpers';
import { makeServices, NOW, renderWith, SEED_SETTINGS, seedSettings, type TestServices } from './render';

let services: TestServices;
afterEach(async () => {
  await services?.db.delete();
});
beforeEach(() => localStorage.clear());

const HOUR = 3_600_000;
const entry = (fields: Partial<LogEntryData> & { id: string; eaten_at: number }) =>
  synced<LogEntryData>({
    window_name: 'Lunch', bg_mgdl: null, bg_source: 'none', total_carbs_g: 0, suggested_units: null, taken_units: null,
    settings_version_id: SEED_SETTINGS.id, notes: null, ...fields,
  });
const item = (fields: Partial<LogItemData> & { id: string; log_entry_id: string }) =>
  synced<LogItemData>({ ref_type: 'food', ref_id: 'tortilla', display_name: 'Tortilla', amount: 100, unit: 'g', carbs_g: 48, ...fields });

async function setup() {
  services = makeServices();
  await seedSettings(services.db);
  await services.db.food.put(synced(foodData({ id: 'tortilla', name: 'Tortilla', carbs_per_100g: 48 })));
  await services.db.log_entry.bulkPut([
    entry({ id: 'today', eaten_at: NOW - HOUR, bg_mgdl: 140, total_carbs_g: 54, suggested_units: 7, taken_units: 6, notes: 'tacos <3' }),
    entry({ id: 'older', eaten_at: NOW - 3 * 24 * HOUR, window_name: 'Dinner', total_carbs_g: 20, taken_units: 2 }),
  ]);
  await services.db.log_item.bulkPut([
    item({ id: 'li-1', log_entry_id: 'today', amount: 100 }),
    item({ id: 'li-2', log_entry_id: 'today', ref_type: 'quick', ref_id: 'li-2', display_name: 'Salsa', amount: 6, unit: 'carbs', carbs_g: 6 }),
    item({ id: 'li-3', log_entry_id: 'older', amount: 41.7, carbs_g: 20 }),
  ]);
  return userEvent.setup();
}

describe('copying from a log entry', () => {
  it('Copy meal puts every row on the clipboard and the Calculator pastes them as editable rows', async () => {
    const user = await setup();
    renderWith(<Log />, services);
    await user.click(await screen.findByRole('button', { name: /11:00 Lunch/ }));
    await user.click(await screen.findByRole('button', { name: 'Copy meal' }));
    expect(screen.getByRole('status')).toHaveTextContent('Copied 2 items.');
    expect(readClipboard()).toEqual({
      source: 'Lunch · Mon 14 Sep',
      items: [
        { ref_type: 'food', ref_id: 'tortilla', amount: 100, unit: 'g', label: null },
        { ref_type: 'quick', ref_id: 'li-2', amount: 6, unit: 'carbs', label: 'Salsa' },
      ],
    });

    renderWith(<Calculator />, services);
    expect(await screen.findByTestId('paste-card')).toHaveTextContent('Copied: Lunch · Mon 14 Sep · 2 items');
    await user.click(screen.getByRole('button', { name: 'Paste' }));
    expect(screen.getByLabelText('Amount of Tortilla')).toHaveValue('100');
    // Recomputed from today's food data, not the logged snapshot.
    expect(screen.getByLabelText('Carbs in Tortilla')).toHaveTextContent('48 g');
    expect(screen.getByDisplayValue('Salsa')).toBeInTheDocument();
    expect(screen.getByTestId('total-carbs')).toHaveTextContent('54 g');
  });

  it('copies a single row', async () => {
    const user = await setup();
    renderWith(<Log />, services);
    await user.click(await screen.findByRole('button', { name: /11:00 Lunch/ }));
    await user.click(await screen.findByRole('button', { name: 'Copy Tortilla' }));
    expect(readClipboard()).toEqual({ source: 'Tortilla', items: [{ ref_type: 'food', ref_id: 'tortilla', amount: 100, unit: 'g', label: null }] });
  });

  it('pastes into a plan slot, which saves fresh plan items', async () => {
    const user = await setup();
    copyToClipboard({ source: 'Lunch · Mon 14 Sep', items: [{ ref_type: 'quick', ref_id: 'li-2', amount: 6, unit: 'carbs', label: 'Salsa' }] });
    copyToClipboard({
      source: 'Lunch · Mon 14 Sep',
      items: [
        { ref_type: 'food', ref_id: 'tortilla', amount: 50, unit: 'g', label: null },
        { ref_type: 'quick', ref_id: 'li-2', amount: 6, unit: 'carbs', label: 'Salsa' },
      ],
    });
    const data = await loadCatalogData(services.db);
    renderWith(<SlotEditor date="2026-09-16" windowName="Lunch" slot={null} data={data} onDone={() => {}} />, services);
    await user.click(await screen.findByRole('button', { name: 'Paste' }));
    await user.click(screen.getByRole('button', { name: 'Save slot' }));
    await waitFor(async () => expect(await services.db.plan_item.count()).toBe(2));
    const items = (await services.db.plan_item.toArray()).sort((a, b) => a.position - b.position);
    expect(items[0]).toMatchObject({ ref_type: 'food', ref_id: 'tortilla', amount: 50, unit: 'g' });
    // A pasted quick row points at its own new id, never at the log row it came from.
    expect(items[1]).toMatchObject({ ref_type: 'quick', amount: 6, label: 'Salsa' });
    expect(items[1]!.ref_id).toBe(items[1]!.id);
    expect(items[1]!.id).not.toBe('li-2');
  });

  it('Clear empties the clipboard', async () => {
    const user = await setup();
    copyToClipboard({ source: 'Tortilla', items: [{ ref_type: 'food', ref_id: 'tortilla', amount: 1, unit: 'g', label: null }] });
    renderWith(<Calculator />, services);
    await user.click(await screen.findByRole('button', { name: 'Clear' }));
    expect(screen.queryByTestId('paste-card')).not.toBeInTheDocument();
    expect(localStorage.getItem(CLIPBOARD_KEY)).toBeNull();
  });
});

describe('clipboard storage', () => {
  it('treats malformed stored data as empty', () => {
    localStorage.setItem(CLIPBOARD_KEY, JSON.stringify({ source: 'x', items: [{ ref_type: 'food', ref_id: 'a', amount: 'lots', unit: 'g', label: null }] }));
    expect(readClipboard()).toBeNull();
    localStorage.setItem(CLIPBOARD_KEY, '{not json');
    expect(readClipboard()).toBeNull();
  });

  it('gives every pasted row a fresh key', () => {
    let n = 0;
    const rows = pasteRows(
      { source: 's', items: [{ ref_type: 'quick', ref_id: 'old', amount: 5, unit: 'carbs', label: null }] },
      () => `k${++n}`,
    );
    expect(rows).toEqual([{ key: 'k1', ref_type: 'quick', ref_id: 'k1', amount: '5', unit: 'carbs', label: '' }]);
  });
});

describe('log export', () => {
  it('lists every day of the range', () => {
    expect(daysBetween('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(daysBetween('2026-10-02', '2026-10-01')).toEqual([]);
    expect(rangeLabel('2026-09-30', '2026-10-06')).toBe('Sep 30 – Oct 6, 2026');
    expect(rangeLabel('2025-12-30', '2026-01-02')).toBe('Dec 30, 2025 – Jan 2, 2026');
  });

  it('builds the report from the log with goals, items and escaped notes', async () => {
    await setup();
    const data = await loadCatalogData(services.db);
    const report = logReport({
      from: '2026-09-11',
      to: '2026-09-14',
      entries: await services.db.log_entry.toArray(),
      items: await services.db.log_item.toArray(),
      portions: data.portions,
      versions: await services.db.dose_settings.toArray(),
    });
    expect(report.days.map((d) => d.entries.map((e) => e.id))).toEqual([['older'], [], [], ['today']]);
    expect(report.summary).toMatchObject({ entries: 2, logged_days: 2, carbs_g: 74, taken_units: 8 });
    const today = report.days[3]!.entries[0]!;
    expect(today.goal_status).toBe('in'); // 54 g against Lunch 50–80
    const html = reportHtml(report, reportLabels('2026-09-11', '2026-09-14', NOW));
    expect(html).toContain('Sep 11 – Sep 14, 2026');
    expect(html).toContain('Tortilla 100 g — 48 g');
    expect(html).toContain('Salsa — 6 g');
    expect(html).toContain('tacos &lt;3');
    expect(html).not.toContain('tacos <3');
    expect(html).toContain('Nothing logged');
  });

  it('opens the print dialog from the Log screen', async () => {
    const user = await setup();
    const print = vi.fn();
    const appendChild = document.body.appendChild.bind(document.body);
    const spy = vi.spyOn(document.body, 'appendChild').mockImplementation((node) => {
      const result = appendChild(node);
      if (node instanceof HTMLIFrameElement) {
        Object.defineProperty(node, 'contentWindow', { value: { print, focus: () => {}, addEventListener: () => {} } });
        node.onload?.(new Event('load'));
      }
      return result;
    });
    renderWith(<Log />, services);
    await user.click(await screen.findByRole('button', { name: 'Export PDF…' }));
    await user.click(screen.getByRole('button', { name: 'Last 14 days' }));
    await user.click(screen.getByRole('button', { name: 'Create PDF' }));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    const frame = document.querySelector('iframe')!;
    expect(frame.srcdoc).toContain('Sep 1 – Sep 14, 2026');
    expect(frame.srcdoc).toContain('Monday, September 14');
    spy.mockRestore();
  });

  it('refuses a backwards range', async () => {
    const user = await setup();
    renderWith(<Log />, services);
    await user.click(await screen.findByRole('button', { name: 'Export PDF…' }));
    const from = screen.getByLabelText('From');
    await user.clear(from);
    await user.type(from, '2026-09-20');
    await user.click(screen.getByRole('button', { name: 'Create PDF' }));
    expect(screen.getByRole('alert')).toHaveTextContent('The start date is after the end date.');
  });
});
