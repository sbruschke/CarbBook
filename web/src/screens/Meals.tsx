import { itemCarbs } from '@carbbook/core';
import { useState } from 'react';
import { useCatalogData } from '../app/hooks';
import { buildCatalog } from '../db/catalog';
import { MealEditor } from '../meals/MealEditor';
import { formatCarbs } from '../ui/format';
import { ImageThumb } from '../ui/ImageThumb';

export function Meals() {
  const data = useCatalogData();
  const [editing, setEditing] = useState<string | null>(null);
  if (!data) return <p>Loading…</p>;
  if (editing) {
    return <MealEditor key={editing} data={data} mealId={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />;
  }
  const catalog = buildCatalog(data);
  const meals = [...data.meals].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="screen">
      <h1>Meals</h1>
      <button type="button" className="primary" onClick={() => setEditing('new')}>
        New meal
      </button>
      {meals.length === 0 && <p className="muted">No meals yet. Build one here, or use Save as meal on the calculator.</p>}
      <ul className="list">
        {meals.map((meal) => {
          const perServing = itemCarbs(catalog, 'meal', meal.id, 1, 'serving');
          return (
            <li key={meal.id}>
              <button type="button" className="list-item" onClick={() => setEditing(meal.id)}>
                <ImageThumb imageId={meal.image_id} alt="" />
                <span>{meal.name}</span>
                <span className="muted">{perServing.complete ? `${formatCarbs(perServing.carbs_g)} per serving` : 'incomplete carb data'}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
