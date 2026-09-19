import { describe, expect, it } from 'vitest';
import { createOffClient, OFF_FIELDS, OffUnavailableError } from '../src/off/client';
import { barcodeCandidates, normalizeOffProduct, offImageCandidate } from '../src/off/normalize';

/** Trimmed from a live response for 0737628064502 (2026-09-14). */
const THAI_KITCHEN = {
  code: '0737628064502',
  status: 1,
  status_verbose: 'product found',
  product: {
    brands: 'Simply Asia, Thai Kitchen',
    code: '0737628064502',
    product_name: 'Thai peanut noodle kit includes stir-fry rice noodles & thai peanut seasoning',
    serving_quantity: 52,
    serving_quantity_unit: 'g',
    serving_size: '0.333 PACKAGE (52 g)',
    nutriments: { carbohydrates_100g: 71.15, carbohydrates_serving: 37, fiber_100g: 1.9, fiber_serving: 0.988 },
  },
};

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const options = (fetch: typeof globalThis.fetch) => ({
  baseUrl: 'https://world.openfoodfacts.org',
  userAgent: 'CarbBook/0.1 (owner@example.com)',
  timeoutMs: 5000,
  fetch,
});

describe('createOffClient', () => {
  it('calls API v2 with the field list and a custom User-Agent', async () => {
    const { fetch, calls } = stubFetch(() => Response.json(THAI_KITCHEN));
    const product = await createOffClient(options(fetch)).lookup('737628064502');
    expect(product?.code).toBe('0737628064502');
    expect(calls[0]!.url).toBe(`https://world.openfoodfacts.org/api/v2/product/737628064502?fields=${OFF_FIELDS}`);
    expect(new Headers(calls[0]!.init?.headers).get('user-agent')).toBe('CarbBook/0.1 (owner@example.com)');
  });

  it('returns null for HTTP 404 and for status 0', async () => {
    const notFound = stubFetch(() => Response.json({ code: '3017624010070', status: 0, status_verbose: 'product not found' }, { status: 404 }));
    expect(await createOffClient(options(notFound.fetch)).lookup('3017624010070')).toBeNull();
    const invalid = stubFetch(() => Response.json({ code: '00000000', status: 0, status_verbose: 'no code or invalid code' }));
    expect(await createOffClient(options(invalid.fetch)).lookup('00000000')).toBeNull();
  });

  it('throws OffUnavailableError on network errors, timeouts and 5xx', async () => {
    const failures = [
      stubFetch(() => {
        throw new TypeError('fetch failed');
      }),
      stubFetch(() => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }),
      stubFetch(() => new Response('busy', { status: 503 })),
    ];
    for (const { fetch } of failures) {
      await expect(createOffClient(options(fetch)).lookup('123456')).rejects.toBeInstanceOf(OffUnavailableError);
    }
  });

  it('throws OffUnavailableError when the 200 body is not valid JSON', async () => {
    const { fetch } = stubFetch(() => new Response('<html>not json</html>', { status: 200 }));
    await expect(createOffClient(options(fetch)).lookup('123456')).rejects.toBeInstanceOf(OffUnavailableError);
  });

  it('throws OffUnavailableError when the body stream rejects mid-read', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    const { fetch } = stubFetch(() => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(createOffClient(options(fetch)).lookup('123456')).rejects.toBeInstanceOf(OffUnavailableError);
  });
});

describe('normalizeOffProduct', () => {
  it('builds a food draft with a label-serving portion', () => {
    expect(normalizeOffProduct({ ...THAI_KITCHEN.product }, '737628064502')).toEqual({
      food: {
        name: 'Thai peanut noodle kit includes stir-fry rice noodles & thai peanut seasoning',
        brand: 'Simply Asia',
        source: 'off',
        source_ref: '0737628064502',
        carbs_per_100g: 71.15,
        carbs_per_100ml: null,
        fiber_per_100g: 1.9,
      },
      portions: [{ label: 'label serving', kind: 'serving', quantity: 1, grams: 52, carbs_g: null }],
      barcode: '0737628064502',
      serving_size: '0.333 PACKAGE (52 g)',
    });
  });

  it('handles missing names, missing nutrients, string quantities and non-gram servings', () => {
    const draft = normalizeOffProduct({ code: '3017620422003', serving_quantity: '15', nutriments: {} }, '3017620422003');
    expect(draft.food).toMatchObject({ name: 'Barcode 3017620422003', brand: null, carbs_per_100g: null, carbs_per_100ml: null, fiber_per_100g: null });
    expect(draft.portions).toEqual([{ label: 'label serving', kind: 'serving', quantity: 1, grams: 15, carbs_g: null }]);
    expect(normalizeOffProduct({ code: '1', serving_quantity: 330, serving_quantity_unit: 'ml' }, '1').portions).toEqual([]);
  });
});

describe('normalizeOffProduct nutrition clamping', () => {
  it('rejects carbs/fiber per 100g outside 0..100', () => {
    const draft = normalizeOffProduct(
      { code: '1', nutriments: { carbohydrates_100g: 150, fiber_100g: -1 } },
      '1',
    );
    expect(draft.food.carbs_per_100g).toBeNull();
    expect(draft.food.fiber_per_100g).toBeNull();
  });

  it('rejects unparseable nutriment strings, including comma-decimal', () => {
    const draft = normalizeOffProduct(
      { code: '1', nutriments: { carbohydrates_100g: 'not a number', fiber_100g: '12,5' } },
      '1',
    );
    expect(draft.food.carbs_per_100g).toBeNull();
    expect(draft.food.fiber_per_100g).toBeNull();
  });

  it('rejects NaN', () => {
    const draft = normalizeOffProduct({ code: '1', nutriments: { carbohydrates_100g: NaN } }, '1');
    expect(draft.food.carbs_per_100g).toBeNull();
  });

  it('nulls fiber when it exceeds carbs, keeping carbs', () => {
    const draft = normalizeOffProduct(
      { code: '1', nutriments: { carbohydrates_100g: 10, fiber_100g: 15 } },
      '1',
    );
    expect(draft.food.carbs_per_100g).toBe(10);
    expect(draft.food.fiber_per_100g).toBeNull();
  });

  it('accepts boundary values 0 and 100', () => {
    const draft = normalizeOffProduct(
      { code: '1', nutriments: { carbohydrates_100g: 100, fiber_100g: 0 } },
      '1',
    );
    expect(draft.food.carbs_per_100g).toBe(100);
    expect(draft.food.fiber_per_100g).toBe(0);
  });
});

describe('barcodeCandidates', () => {
  it('covers UPC-A and EAN-13 spellings', () => {
    expect(barcodeCandidates('737628064502')).toEqual(['737628064502', '0737628064502']);
    expect(barcodeCandidates('0737628064502')).toEqual(['0737628064502', '737628064502']);
  });
});

describe('OFF image candidate', () => {
  it('requests the image fields', () => {
    expect(OFF_FIELDS).toContain('image_front_url');
    expect(OFF_FIELDS).toContain('image_front_small_url');
  });

  it('maps an OFF photo to a candidate on an allowlisted host', () => {
    const candidate = offImageCandidate({
      ...THAI_KITCHEN.product,
      code: '0737628064502',
      product_name: 'Thai peanut noodle kit',
      image_front_url: 'https://images.openfoodfacts.org/images/products/073/762/806/4502/front_en.4.400.jpg',
      image_front_small_url: 'https://images.openfoodfacts.org/images/products/073/762/806/4502/front_en.4.200.jpg',
    });
    expect(candidate).toEqual({
      provider: 'off',
      thumb_url: 'https://images.openfoodfacts.org/images/products/073/762/806/4502/front_en.4.200.jpg',
      full_url: 'https://images.openfoodfacts.org/images/products/073/762/806/4502/front_en.4.400.jpg',
      width: null,
      height: null,
      license: 'CC-BY-SA-3.0',
      attribution: 'Open Food Facts',
      title: 'Thai peanut noodle kit',
    });
  });

  it('falls back to the full url when no small variant is offered', () => {
    const candidate = offImageCandidate({
      code: '1',
      image_front_url: 'https://images.openfoodfacts.org/images/products/1/front.jpg',
    });
    expect(candidate?.thumb_url).toBe('https://images.openfoodfacts.org/images/products/1/front.jpg');
  });

  it('ignores an off-host small variant but keeps the allowlisted full url', () => {
    const candidate = offImageCandidate({
      code: '1',
      image_front_url: 'https://static.openfoodfacts.org/images/products/1/front.jpg',
      image_front_small_url: 'https://evil.test/thumb.jpg',
    });
    expect(candidate?.thumb_url).toBe('https://static.openfoodfacts.org/images/products/1/front.jpg');
  });

  it('returns null when OFF has no photo or the URL is off-host', () => {
    expect(offImageCandidate({ code: '1' })).toBeNull();
    expect(offImageCandidate({ code: '1', image_front_url: 'https://evil.test/x.jpg' })).toBeNull();
    expect(offImageCandidate({ code: '1', image_front_url: '   ' })).toBeNull();
  });

  it('carries a null title when OFF has no product name', () => {
    const candidate = offImageCandidate({
      code: '1',
      image_front_url: 'https://images.openfoodfacts.org/images/products/1/front.jpg',
    });
    expect(candidate?.title).toBeNull();
  });
});
