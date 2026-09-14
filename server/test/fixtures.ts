import { fileURLToPath } from 'node:url';

/** Extracted-CSV fixture folders trimmed from the real FDC downloads (see test/fixtures/usda/). */
export const USDA_FIXTURES = ['foundation', 'sr_legacy', 'survey'].map((dataset) =>
  fileURLToPath(new URL(`./fixtures/usda/${dataset}/`, import.meta.url)),
);

export const WEB_FIXTURE = fileURLToPath(new URL('./fixtures/web/', import.meta.url));
