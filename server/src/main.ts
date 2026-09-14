import { buildApp } from './app';
import { loadConfig } from './config';
import { initDatabase } from './init';
import { createShutdownHandler } from './shutdown';

const config = loadConfig(process.env);
const db = initDatabase(config.databasePath);
const app = await buildApp({ db, config, logger: true });

const shutdown = createShutdownHandler({
  close: () => app.close(),
  closeDb: () => db.close(),
  log: (message, signal) => app.log.info({ signal }, message),
  exit: (code) => process.exit(code),
  setTimeout: setTimeout,
});
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
