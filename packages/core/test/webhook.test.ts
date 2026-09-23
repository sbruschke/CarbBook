import { describe, expect, it } from 'vitest';
import vectors from '../../../testdata/webhook-vectors.json';
import { DISCORD_CONTENT_LIMIT, isDiscordWebhookUrl, webhookMessage, webhookUrlProblem } from '../src/webhook';

const v = vectors as unknown as {
  message_cases: {
    name: string;
    limit?: number;
    input: {
      when: string;
      bg_mgdl: number | null;
      carbs_g: number;
      units: number | null;
      items: { name: string; amount: string; carbs_g: number | null }[];
    };
    expect: string;
  }[];
  url_cases: { name: string; url: string; problem: string | null; discord: boolean }[];
};

/** JSON has no NaN: a null carbs snapshot in the vectors is the missing-value case. */
const load = (input: (typeof v.message_cases)[number]['input']) => ({
  ...input,
  items: input.items.map((item) => ({ ...item, carbs_g: item.carbs_g ?? Number.NaN })),
});

describe('webhook vectors', () => {
  it('has cases to run', () => {
    expect(v.message_cases.length).toBeGreaterThan(0);
    expect(v.url_cases.length).toBeGreaterThan(0);
  });
  for (const c of v.message_cases) {
    it(`message: ${c.name}`, () => {
      expect(webhookMessage(load(c.input), c.limit ?? DISCORD_CONTENT_LIMIT)).toBe(c.expect);
    });
  }
  for (const c of v.url_cases) {
    it(`url: ${c.name}`, () => {
      expect(webhookUrlProblem(c.url)).toBe(c.problem);
      expect(isDiscordWebhookUrl(c.url)).toBe(c.discord);
    });
  }
});

describe('webhookMessage', () => {
  it('never exceeds the Discord limit, however many items there are', () => {
    const items = Array.from({ length: 400 }, (_, i) => ({ name: `Item number ${i}`, amount: '1 cup', carbs_g: 12.5 }));
    const message = webhookMessage({ when: 'now', bg_mgdl: 100, carbs_g: 5000, units: 60, items });
    expect(message.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    expect(message).toContain('more');
  });

  it('opens with exactly the accountability text, so the webhook and the copy button agree', () => {
    const input = { when: 'now', bg_mgdl: 170, carbs_g: 59, units: 7 };
    const message = webhookMessage({ ...input, items: [{ name: 'Toast', amount: '1 slice', carbs_g: 15 }] });
    expect(message.split('\n')[0]).toBe(
      'As of now my blood sugar is 170. I am eating something with 59 carbs and so am giving myself 7 units of fast acting insulin.',
    );
  });
});
