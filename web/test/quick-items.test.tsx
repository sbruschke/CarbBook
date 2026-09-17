import { createCatalog } from '@carbbook/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { unitLabel } from '../src/ui/format';
import {
  type DraftItem,
  draftAmount,
  draftItemCarbs,
  draftLabel,
  ItemEditor,
  itemLabel,
  newDraftItem,
  newQuickItem,
  quickRowText,
  unitsFor,
} from '../src/ui/ItemEditor';

const catalog = createCatalog({ foods: [{ id: 'taquitos', name: 'Taquitos', carbs_per_100g: 20 }] });
const quick = (amount: string, label = ''): DraftItem => ({ ...newQuickItem('k1'), amount, label });

describe('quick carbs draft rows', () => {
  it('start empty with the carbs unit and their own key as ref_id', () => {
    expect(newQuickItem('k1')).toEqual({ key: 'k1', ref_type: 'quick', ref_id: 'k1', amount: '', unit: 'carbs', label: '' });
    expect(newDraftItem(catalog, 'quick', 'ignored', 'k2')).toEqual(newQuickItem('k2'));
    expect(unitsFor(catalog, 'quick', 'k1')).toEqual(['carbs']);
  });

  it('parse grams of carbs as a plain decimal within the dose limit (fail closed)', () => {
    expect(draftAmount(quick('7'))).toBe(7);
    expect(draftAmount(quick(' 7,5 '))).toBe(7.5);
    expect(draftAmount(quick('2000'))).toBe(2000);
    for (const bad of ['', ' ', '1/2', '½', '-1', '2001', '1e3', 'abc']) expect(draftAmount(quick(bad)), bad).toBeNull();
    // Food rows keep the fraction parser.
    expect(draftAmount({ key: 'f', ref_type: 'food', ref_id: 'taquitos', amount: '1/2', unit: 'g' })).toBe(0.5);
  });

  it('count a valid quick row as complete carbs and an invalid one as incomplete', () => {
    expect(draftItemCarbs(catalog, quick('7'))).toEqual({ carbs_g: 7, complete: true });
    expect(draftItemCarbs(catalog, quick('2001'))).toEqual({ carbs_g: 0, complete: false });
    expect(draftItemCarbs(catalog, quick(''))).toEqual({ carbs_g: 0, complete: false });
  });

  it('name quick rows by their label, or "Extra carbs" when blank', () => {
    expect(itemLabel(catalog, { ref_type: 'quick', ref_id: 'x', label: '  Ranch & salad ' })).toBe('Ranch & salad');
    expect(itemLabel(catalog, { ref_type: 'quick', ref_id: 'x', label: null })).toBe('Extra carbs');
    expect(itemLabel(catalog, { ref_type: 'quick', ref_id: 'x' })).toBe('Extra carbs');
    expect(itemLabel(catalog, { ref_type: 'food', ref_id: 'taquitos' })).toBe('Taquitos');
    expect(itemLabel(catalog, { ref_type: 'food', ref_id: 'gone' })).toBe('(missing item)');
  });

  it('store a trimmed label for quick rows and null for everything else', () => {
    expect(draftLabel(quick('7', '  Salsa '))).toBe('Salsa');
    expect(draftLabel(quick('7', '   '))).toBeNull();
    expect(draftLabel({ key: 'f', ref_type: 'food', ref_id: 'taquitos', amount: '1', unit: 'g', label: 'stray' })).toBeNull();
  });

  it('describe a quick row as "label — N g carbs"', () => {
    expect(quickRowText('Ranch & salad', '7')).toBe('Ranch & salad — 7 g carbs');
    expect(quickRowText('', '7.25')).toBe('Extra carbs — 7.3 g carbs');
    expect(quickRowText(undefined, 'x')).toBe('Extra carbs — enter grams of carbs');
    expect(quickRowText('Big', '2001')).toBe('Big — enter grams of carbs');
  });

  it('shows the carbs unit as "g carbs"', () => {
    expect(unitLabel('carbs', [])).toBe('g carbs');
  });
});

function Harness(props: { initial: DraftItem[] }) {
  const [items, setItems] = useState(props.initial);
  return (
    <>
      <ItemEditor items={items} catalog={catalog} onChange={setItems} reorderable />
      <output data-testid="state">{JSON.stringify(items)}</output>
    </>
  );
}

describe('ItemEditor quick rows', () => {
  it('edits the label and grams, shows "label — N g carbs", and removes the row', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[{ key: 'f1', ref_type: 'food', ref_id: 'taquitos', amount: '100', unit: 'g' }, newQuickItem('q1')]} />);

    expect(screen.getByText('Extra carbs — enter grams of carbs')).toBeInTheDocument();
    expect(screen.getByLabelText('Carbs in carbs row 1')).toHaveTextContent('—');
    expect(screen.queryByLabelText('Unit for carbs row 1')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Label for carbs row 1'), 'Ranch & salad');
    await user.type(screen.getByLabelText('Grams of carbs for carbs row 1'), '7');
    expect(screen.getByText('Ranch & salad — 7 g carbs')).toBeInTheDocument();
    expect(screen.getByLabelText('Carbs in carbs row 1')).toHaveTextContent('7 g');
    expect(screen.getByLabelText('Label for carbs row 1')).toHaveAttribute('maxlength', '80');

    await user.click(screen.getByRole('button', { name: 'Move carbs row 1 up' }));
    expect(JSON.parse(screen.getByTestId('state').textContent!).map((i: DraftItem) => i.key)).toEqual(['q1', 'f1']);

    await user.click(screen.getByRole('button', { name: 'Remove carbs row 1' }));
    expect(JSON.parse(screen.getByTestId('state').textContent!).map((i: DraftItem) => i.key)).toEqual(['f1']);
  });

  it('numbers several quick rows in order', () => {
    render(<Harness initial={[newQuickItem('a'), { ...newQuickItem('b'), label: 'Salsa', amount: '6' }]} />);
    expect(screen.getByLabelText('Label for carbs row 2')).toHaveValue('Salsa');
    expect(screen.getByLabelText('Grams of carbs for carbs row 2')).toHaveValue('6');
  });
});
