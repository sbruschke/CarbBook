import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli';
import { USDA_FIXTURES } from './fixtures';
import { addUser, loginCookie, makeTestApp } from './helpers';

describe('carbbook import-usda + /api/usda', () => {
  it('404s before import, then serves the manifest and both bundle files', async () => {
    const usdaDir = mkdtempSync(join(tmpdir(), 'carbbook-usda-routes-'));
    const { app, db } = await makeTestApp({ env: { USDA_DIR: usdaDir } });
    await addUser(db, 'brett', 'owner');
    const cookie = await loginCookie(app, 'brett');

    const before = await app.inject({ url: '/api/usda/manifest', headers: { cookie } });
    expect(before.statusCode).toBe(404);
    expect(before.json().error).toBe('usda_not_imported');

    const out: string[] = [];
    const code = await runCli(['import-usda', ...USDA_FIXTURES], {
      env: { USDA_DIR: usdaDir },
      stdout: (line) => out.push(line),
      stderr: (line) => out.push(line),
      readPassword: async () => '',
      db,
      now: () => 7,
    });
    expect(code).toBe(0);
    expect(out[0]).toBe('Imported 12 foods and 28 portions (3 skipped) from 3 datasets');
    expect(out[1]).toMatch(/^USDA bundle fdc-[0-9a-f]{12} written to /);

    const manifest = (await app.inject({ url: '/api/usda/manifest', headers: { cookie } })).json();
    expect(manifest).toMatchObject({ food_count: 12, portion_count: 28, created_at: 7 });
    expect(manifest.json_url).toBe(`/api/usda/files/${manifest.json_file}`);

    const json = await app.inject({ url: manifest.json_url, headers: { cookie } });
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-type']).toBe('application/gzip');
    expect(json.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(createHash('sha256').update(json.rawPayload).digest('hex')).toBe(manifest.json_sha256);

    const sqlite = await app.inject({ url: manifest.sqlite_url, headers: { cookie } });
    expect(sqlite.headers['content-type']).toBe('application/vnd.sqlite3');
    expect(createHash('sha256').update(sqlite.rawPayload).digest('hex')).toBe(manifest.sqlite_sha256);

    for (const name of ['manifest.json', '..%2Fcarbbook.db', 'usda-fdc-000000000000.sqlite', `${manifest.sqlite_file}.tmp`]) {
      expect((await app.inject({ url: `/api/usda/files/${name}`, headers: { cookie } })).statusCode).toBe(404);
    }
  });

  it('prints usage when no directory is given', async () => {
    const err: string[] = [];
    const code = await runCli(['import-usda'], {
      env: {},
      stdout: () => {},
      stderr: (line) => err.push(line),
      readPassword: async () => '',
    });
    expect(code).toBe(2);
    expect(err[0]).toMatch(/import-usda <csv-dir>/);
  });
});
