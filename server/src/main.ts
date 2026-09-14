import { buildApp } from './app';
import { loadConfig } from './config';
import { initDatabase } from './init';

const config = loadConfig(process.env);
const db = initDatabase(config.databasePath);
const app = await buildApp({ db, config, logger: true });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
