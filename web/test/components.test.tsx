import { createCatalog, type LogEntryData, type LogItemData } from '@carbbook/core';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { type DraftItem, ItemEditor, newDraftItem } from '../src/ui/ItemEditor';
import { SearchPanel } from '../src/ui/SearchPanel';
import { foodData, mealData, mealItemData, portionData, synced } from './helpers';
import { makeServices, renderWith, type TestServices } from './render';

const catalog = createCatalog({
  foods: [foodData({ id: 'bread', name: 'Bread', carbs_per_100g: 50 }), foodData({ id: 'mystery', name: 'Mystery', carbs_per_100g: null })],
  portions: [portionData({ id: 'slice', food_id: 'bread', label: 'slice', kind: 'count', quantity: 1, grams: 30 })],
  meals: [mealData({ id: 'toast', name: 'Toast', yield_servings: 2 })],
  meal_items: [mealItemData({ id: 't1', meal_id: 'toast', ref_id: 'bread', amount: 2, unit: 'p:slice' })],
});

function Harness(props: { initial: DraftItem[]; reorderable?: boolean }) {
  const [items, setItems] = useState(props.initial);
  return (
    <>
      <ItemEditor items={items} catalog={catalog} onChange={setItems} reorderable={props.reorderable} />
      <p data-testid="order">{items.map((i) => i.ref_id).join(',')}</p>
    </>
  );
}

describe('ItemEditor', () => {
  it('defaults foods to their first count portion and meals to servings', () => {
    expect(newDraftItem(catalog, 'food', 'bread', 'k1')).toEqual({ key: 'k1', ref_type: 'food', ref_id: 'bread', amount: '1', unit: 'p:slice' });
    expect(newDraftItem(catalog, 'food', 'mystery', 'k2')).toMatchObject({ amount: '100', unit: 'g' });
    expect(newDraftItem(catalog, 'meal', 'toast', 'k3')).toMatchObject({ amount: '1', unit: 'serving' });
  });

  it('offers only valid units and shows live carbs from core', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[newDraftItem(catalog, 'food', 'bread', 'k1')]} />);
    const unit = screen.getByLabelText('Unit for Bread') as HTMLSelectElement;
    expect([...unit.options].map((o) => o.textContent)).toEqual(['g', 'kg', 'oz', 'lb', 'slice (30 g)']);
    expect(screen.getByLabelText('Carbs in Bread')).toHaveTextContent('15 g');
    const amount = screen.getByLabelText('Amount of Bread');
    await user.clear(amount);
    await user.type(amount, '3');
    expect(screen.getByLabelText('Carbs in Bread')).toHaveTextContent('45 g');
    await user.selectOptions(unit, 'g');
    expect(screen.getByLabelText('Carbs in Bread')).toHaveTextContent('1.5 g');
  });

  it('flags missing amounts, missing carb data and references that have not synced yet', () => {
    render(
      <Harness
        initial={[
          { key: 'a', ref_type: 'food', ref_id: 'bread', amount: '', unit: 'g' },
          { key: 'b', ref_type: 'food', ref_id: 'mystery', amount: '1', unit: 'g' },
          { key: 'c', ref_type: 'meal', ref_id: 'not-synced-yet', amount: '1', unit: 'serving' },
        ]}
      />,
    );
    expect(screen.getByText('enter an amount')).toBeInTheDocument();
    expect(screen.getAllByText('missing data')).toHaveLength(2);
    expect(screen.getByLabelText('Carbs in (missing item)')).toHaveTextContent('—');
  });

  it('reorders and removes items', async () => {
    const user = userEvent.setup();
    render(<Harness reorderable initial={[newDraftItem(catalog, 'food', 'bread', 'a'), newDraftItem(catalog, 'meal', 'toast', 'b')]} />);
    await user.click(screen.getByRole('button', { name: 'Move Toast up' }));
    expect(screen.getByTestId('order')).toHaveTextContent('toast,bread');
    await user.click(screen.getByRole('button', { name: 'Remove Bread' }));
    expect(screen.getByTestId('order')).toHaveTextContent('toast');
  });
});

describe('SearchPanel', () => {
  let services: TestServices;
  afterEach(async () => {
    await services.db.delete();
  });

  it('shows recent items before typing, then ranked results, and reports the pick', async () => {
    services = makeServices();
    await services.db.food.bulkPut([
      synced(foodData({ id: 'bread', name: 'Bread', carbs_per_100g: 50 })),
      synced(foodData({ id: 'brie', name: 'Brie', source: 'off', brand: 'Président', carbs_per_100g: 0.5 })),
    ]);
    await services.db.usda_food.put({ fdc_id: 1, name: 'Bread, wheat', carbs_per_100g: 43, fiber_per_100g: 6 });
    await services.db.log_entry.put(
      synced<LogEntryData>({ id: 'e1', eaten_at: 1, window_name: null, bg_mgdl: null, bg_source: 'none', total_carbs_g: 1, suggested_units: null, taken_units: null, settings_version_id: null }),
    );
    await services.db.log_item.put(
      synced<LogItemData>({ id: 'i1', log_entry_id: 'e1', ref_type: 'food', ref_id: 'brie', display_name: 'Brie', amount: 1, unit: 'g', carbs_g: 0 }),
    );
    const picks: string[] = [];
    const user = userEvent.setup();
    renderWith(<SearchPanel onPick={(result) => picks.push(result.id)} />, services);

    expect(await screen.findByRole('heading', { name: 'Recent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Brie/ })).toHaveTextContent('Président · Open Food Facts · 0.5 g carbs / 100 g');
    await user.type(screen.getByLabelText('Search foods and meals'), 'bre');
    const results = within(screen.getByRole('list', { name: 'Search results' })).getAllByRole('button');
    expect(results.map((b) => b.querySelector('.result-name')?.textContent)).toEqual(['Bread', 'Bread, wheat']);
    await user.click(results[1]!);
    expect(picks).toEqual(['usda-1']);
    expect(screen.getByLabelText('Search foods and meals')).toHaveValue('');
  });
});
