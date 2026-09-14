import { fileURLToPath } from 'node:url';

export const WEB_FIXTURE = fileURLToPath(new URL('./fixtures/web/', import.meta.url));
