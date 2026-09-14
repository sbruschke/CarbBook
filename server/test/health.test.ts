import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors';
import { makeTestApp } from './helpers';

describe('app skeleton', () => {
  it('serves /api/health without auth', async () => {
    const { app } = await makeTestApp();
    const response = await app.inject({ url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const { app } = await makeTestApp();
    const response = await app.inject({ url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found', message: 'No route for GET /api/nope' });
  });

  it('maps ApiError, validation errors and unexpected errors to { error, message }', async () => {
    const { app } = await makeTestApp();
    app.get('/test/api-error', async () => {
      throw new ApiError(409, 'conflict', 'Already exists');
    });
    app.post('/test/validated', { schema: { body: { type: 'object', required: ['n'] } } }, async () => ({ ok: true }));
    app.get('/test/boom', async () => {
      throw new Error('secret internals');
    });

    const apiError = await app.inject({ url: '/test/api-error' });
    expect(apiError.statusCode).toBe(409);
    expect(apiError.json()).toEqual({ error: 'conflict', message: 'Already exists' });

    const invalid = await app.inject({ method: 'POST', url: '/test/validated', payload: {} });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe('invalid_request');

    const boom = await app.inject({ url: '/test/boom' });
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({ error: 'internal', message: 'Internal server error' });
  });
});
