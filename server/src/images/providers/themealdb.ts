import { isProviderHost } from '../urlguard';
import { getJson, type ImageCandidate, type ImageSearchProvider, type ProviderOptions } from './types';

/**
 * TheMealDB: a small catalogue of prepared dishes with good photos, free on the public test
 * key `1`. High relevance when it hits, nothing when it misses — a miss is reported as
 * `{"meals": null}`, not an empty array. Appending /medium to a thumb yields a 350x350 version,
 * sharp enough for a retina grid cell while staying far smaller than the 700x700 original —
 * /preview is only 150x150, blurry at 2x/3x device pixel ratio.
 *
 * The stored original is 700x700, the largest size TheMealDB offers, so images adopted from this
 * provider top out at 700px rather than the usual 800px cap — that is this source's own ceiling,
 * not a URL we chose wrong.
 *
 * The API has no licence field; images are the site's own, credited as "TheMealDB".
 */
interface MealDbMeal {
  idMeal?: string;
  strMeal?: string;
  strMealThumb?: string;
}

export function createMealDbProvider(options: ProviderOptions): ImageSearchProvider {
  return {
    name: 'themealdb',
    async search(query, limit) {
      const url = `${options.baseUrl}/api/json/v1/1/search.php?s=${encodeURIComponent(query)}`;
      const body = await getJson<{ meals?: MealDbMeal[] | null }>('themealdb', url, options);
      const meals = Array.isArray(body.meals) ? body.meals : [];

      return meals
        .flatMap((meal) => {
          const thumb = meal.strMealThumb?.trim();
          if (!thumb || !isProviderHost(thumb, 'themealdb')) return [];
          const candidate: ImageCandidate = {
            provider: 'themealdb',
            thumb_url: `${thumb}/medium`,
            full_url: thumb,
            width: null,
            height: null,
            license: null,
            attribution: 'TheMealDB',
            title: meal.strMeal ?? null,
          };
          return [candidate];
        })
        // The API has no page_size, so the limit is applied here.
        .slice(0, limit);
    },
  };
}
