import { describe, expect, it } from 'vitest';
import { WEB_FIXTURE } from './fixtures';
import { makeTestApp } from './helpers';

describe('web app static serving', () => {
  it('serves index.html at / and for client-side routes', async () => {
    const { app } = await makeTestApp({ env: { WEB_DIR: WEB_FIXTURE } });
    for (const url of ['/', '/log/2026-09-14', '/settings?tab=sync']) {
      const response = await app.inject({ url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-type'], url).toMatch(/^text\/html/);
      expect(response.body, url).toContain('<title>CarbBook fixture</title>');
    }
  });

  it('serves assets and 404s missing assets and API routes as JSON', async () => {
    const { app } = await makeTestApp({ env: { WEB_DIR: WEB_FIXTURE } });
    const asset = await app.inject({ url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('fixture asset');
    for (const url of ['/assets/missing.js', '/api/unknown']) {
      const response = await app.inject({ url });
      expect(response.statusCode, url).toBe(404);
      expect(response.json().error, url).toBe('not_found');
    }
  });

  it('serves nothing but the API when WEB_DIR is unset', async () => {
    const { app } = await makeTestApp();
    const response = await app.inject({ url: '/' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('not_found');
  });
});
