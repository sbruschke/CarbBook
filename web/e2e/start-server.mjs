// Starts carbs-server for Playwright: fresh temp database, owner "brett", USDA fixture library,
// the built PWA from web/dist. dexcom-api and Open Food Facts point at a closed port.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const serverDir = resolve(webDir, '../server');
const dataDir = mkdtempSync(join(tmpdir(), 'carbbook-e2e-'));

const env = {
  ...process.env,
  DATABASE_PATH: join(dataDir, 'carbbook.db'),
  USDA_DIR: join(dataDir, 'usda'),
  WEB_DIR: join(webDir, 'dist'),
  HOST: '127.0.0.1',
  PORT: '3998',
  COOKIE_SECURE: 'false',
  DEXCOM_API_URL: 'http://127.0.0.1:9',
  OFF_BASE_URL: 'http://127.0.0.1:9',
  CARBBOOK_PASSWORD: 'e2e password',
};

const carbbook = (...args) => execFileSync('pnpm', ['-s', 'carbbook', ...args], { cwd: serverDir, env, stdio: 'inherit' });
carbbook('user', 'add', 'brett', '--role', 'owner');
// A second owner sharing the same household data. The login rate limit is 5 per 15 minutes keyed
// by IP *and* username (server/src/routes/auth.ts), and "brett" already spends all five across
// the other specs, so a further spec signs in as this user rather than exhausting the budget.
carbbook('user', 'add', 'dana', '--role', 'owner');
carbbook('import-usda', ...['foundation', 'sr_legacy', 'survey'].map((d) => join(serverDir, 'test/fixtures/usda', d)));

const server = spawn('pnpm', ['-s', 'start'], { cwd: serverDir, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code ?? 0));
