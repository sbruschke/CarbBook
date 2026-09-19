import { createCatalog, type StackEntry } from '@carbbook/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ImageStack } from '../src/ui/ImageStack';
import { ImageThumb } from '../src/ui/ImageThumb';
import { itemStackEntries } from '../src/ui/ItemEditor';
import { foodData, mealData } from './helpers';

/** Image ids are content hashes; `imageUrl` refuses anything else, so tests use real shapes. */
const hash = (seed: string) => seed.repeat(64).slice(0, 64);
const RICE = hash('a');
const CHICKEN = hash('b');
const BEANS = hash('c');
const OIL = hash('d');

const entry = (imageId: string | null, carbs: number | null): StackEntry => ({ imageId, carbs });

/** alt="" makes each photo presentational, so they are found by tag, not by role. */
const photos = () => [...document.querySelectorAll<HTMLImageElement>('.image-stack img')];

describe('ImageStack', () => {
  it('draws three photos biggest-carbs-first with a badge for the rest', () => {
    render(
      <ImageStack
        entries={[entry(OIL, 2), entry(RICE, 40), entry(null, 5), entry(CHICKEN, 12), entry(BEANS, 20)]}
      />,
    );
    expect(photos().map((img) => img.getAttribute('src'))).toEqual([
      `/api/images/${RICE}`,
      `/api/images/${BEANS}`,
      `/api/images/${CHICKEN}`,
    ]);
    expect(screen.getByLabelText('5 items')).toHaveTextContent('+2');
  });

  it('renders nothing at all when no item in the group has a photo', () => {
    const { container } = render(<ImageStack entries={[entry(null, 30), entry(null, null)]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('counts a quick-carbs row into the badge even though it references no food', () => {
    const catalog = createCatalog({
      foods: [foodData({ id: 'rice', name: 'Rice', image_id: RICE }), foodData({ id: 'beans', name: 'Beans', image_id: BEANS })],
      portions: [],
      meals: [],
      meal_items: [],
    });
    render(
      <ImageStack
        entries={itemStackEntries(catalog, [
          { ref_type: 'food', ref_id: 'rice', amount: 100, unit: 'g' },
          { ref_type: 'quick', ref_id: '', amount: 7, unit: 'carbs' },
          { ref_type: 'food', ref_id: 'beans', amount: 100, unit: 'g' },
        ])}
      />,
    );
    expect(photos()).toHaveLength(2);
    expect(screen.getByLabelText('3 items')).toHaveTextContent('+1');
  });

  it('overlaps each layer by 55% of the size and keeps the front photo on top', () => {
    render(<ImageStack entries={[entry(RICE, 40), entry(BEANS, 20), entry(CHICKEN, 10)]} size={40} />);
    const layers = [...screen.getByLabelText('3 items').querySelectorAll('.image-stack-layer')] as HTMLElement[];
    expect(layers.map((layer) => layer.style.marginLeft)).toEqual(['0px', '-22px', '-22px']);
    expect(layers.map((layer) => layer.style.zIndex)).toEqual(['3', '2', '1']);
  });

  it('takes an explicit label instead of the item count', () => {
    render(<ImageStack entries={[entry(RICE, 40)]} label="Lunch photos" />);
    expect(screen.getByLabelText('Lunch photos')).toBeInTheDocument();
  });

  it('derives entries from a meal component list, unknown carbs last but still shown', () => {
    const catalog = createCatalog({
      foods: [foodData({ id: 'mystery', name: 'Mystery', carbs_per_100g: null, image_id: OIL }), foodData({ id: 'rice', name: 'Rice', carbs_per_100g: 80, image_id: RICE })],
      portions: [],
      meals: [mealData({ id: 'bowl' })],
      meal_items: [],
    });
    expect(
      itemStackEntries(catalog, [
        { ref_type: 'food', ref_id: 'mystery', amount: 100, unit: 'g' },
        { ref_type: 'food', ref_id: 'rice', amount: 100, unit: 'g' },
      ]),
    ).toEqual([
      { imageId: OIL, carbs: null },
      { imageId: RICE, carbs: 80 },
    ]);
  });
});

describe('ImageThumb shape', () => {
  it('is a circle by default and rectangular only when asked', () => {
    const { rerender } = render(<ImageThumb imageId={RICE} alt="Rice" />);
    expect(screen.getByAltText('Rice').className).toBe('image-thumb image-thumb-circle');
    rerender(<ImageThumb imageId={RICE} alt="Rice" shape="rounded" />);
    expect(screen.getByAltText('Rice').className).toBe('image-thumb image-thumb-rounded');
  });
});
