/**
 * The webhook message: the accountability text plus a short breakdown of what the entry was made
 * of. Only the webhook gets the breakdown — the copy-pasteable text on screen stays the single
 * sentence pair it has always been, because that is what gets pasted into a conversation.
 *
 * Item lines arrive already formatted (`name`, `amount`), for the same reason `when` does in
 * `AccountabilityInput`: turning a unit id and a portion into "1 cup" or "8 fl oz" needs the food
 * catalog and the device's locale, which is client work. Core's job is only to agree on the shape
 * of the message so the web and iOS send the same thing.
 */
import { accountabilityText, type AccountabilityInput } from './accountability';

/** Discord refuses a message whose `content` is longer than this. */
export const DISCORD_CONTENT_LIMIT = 2000;

export interface WebhookItemLine {
  /** The item's logged display name. */
  name: string;
  /**
   * The amount with its unit, already formatted, e.g. "1 cup". Empty when there is nothing worth
   * saying — a quick-carbs row's amount is its carb figure, which the line already ends with.
   */
  amount: string;
  /** Carbs for this item in grams; non-finite means the snapshot is missing. */
  carbs_g: number;
}

export interface WebhookMessageInput extends AccountabilityInput {
  /** The entry's items, in logged order. May be empty. */
  items: WebhookItemLine[];
}

/** Trailing zeros are noise: 24 not 24.0. Mirrors accountability.ts's `number`. */
function grams(value: number): string {
  return String(Number(value.toFixed(1)));
}

function itemLine(item: WebhookItemLine): string {
  const amount = item.amount.trim();
  const carbs = Number.isFinite(item.carbs_g) ? `${grams(item.carbs_g)} g carbs` : null;
  const tail = [amount, carbs].filter((part) => part !== null && part !== '').join(' · ');
  return tail === '' ? `• ${item.name}` : `• ${item.name} — ${tail}`;
}

/**
 * The full webhook message. The sentence always survives: if the breakdown would push the message
 * past `limit`, item lines are dropped from the end and replaced with a count, rather than the
 * message being cut mid-word or the post being refused by Discord.
 */
export function webhookMessage(input: WebhookMessageInput, limit: number = DISCORD_CONTENT_LIMIT): string {
  const sentence = accountabilityText(input);
  if (input.items.length === 0) return sentence;

  const lines = input.items.map(itemLine);
  const build = (kept: string[], dropped: number): string => {
    const shown = dropped > 0 ? [...kept, `• …and ${dropped} more`] : kept;
    return `${sentence}\n\nIn it:\n${shown.join('\n')}`;
  };

  let kept = lines;
  let message = build(kept, 0);
  while (message.length > limit && kept.length > 1) {
    kept = kept.slice(0, -1);
    message = build(kept, lines.length - kept.length);
  }
  // Not even one line fits: the sentence alone is the most that can be said. A breakdown that is
  // nothing but "…and 3 more" would take up room to say less than nothing.
  return message.length > limit ? sentence : message;
}

const DISCORD_HOSTS = ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'];

/**
 * scheme, host and path of an absolute URL, or null when it is not one.
 *
 * Hand-rolled rather than `new URL()`: core is shared with a Swift mirror and is built without DOM
 * or Node lib types, so it has no URL to lean on. The shapes that matter here are narrow — an
 * absolute https URL with a host — and doing the split the same way in both languages is what keeps
 * the two from disagreeing about which URLs are acceptable.
 */
function parts(url: string): { scheme: string; host: string; path: string } | null {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/.exec(url);
  if (!match) return null;
  // Strip any userinfo and port; whitespace anywhere in the authority means it is not a URL.
  const authority = match[2]!;
  if (/\s/.test(authority)) return null;
  const host = authority.slice(authority.lastIndexOf('@') + 1).split(':')[0]!;
  return { scheme: match[1]!.toLowerCase(), host: host.toLowerCase(), path: match[3]! };
}

/** True for a Discord webhook endpoint. Only a hint for the UI — any https URL is accepted. */
export function isDiscordWebhookUrl(url: string): boolean {
  const parsed = parts(url.trim());
  return (
    parsed !== null &&
    parsed.scheme === 'https' &&
    DISCORD_HOSTS.includes(parsed.host) &&
    /^\/api(\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/.test(parsed.path)
  );
}

/**
 * Why this URL cannot be used as a webhook, or null when it can. https only: the URL is a bearer
 * secret in its own right — anyone holding it can post as you — so it must never travel in clear.
 */
export function webhookUrlProblem(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === '') return 'Enter a webhook URL.';
  const parsed = parts(trimmed);
  if (parsed === null || parsed.host === '') return 'That is not a valid URL.';
  if (parsed.scheme === 'https') return null;
  // An http URL is a real address that is simply refused; anything else (ftp:, javascript:) is not
  // a webhook address at all.
  return parsed.scheme === 'http' ? 'The webhook URL must start with https://.' : 'That is not a valid URL.';
}
