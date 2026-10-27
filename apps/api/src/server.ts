import { loadEnv } from './env.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './app.js';

const env = loadEnv();
const db = createPool(env.DATABASE_URL);
await migrate(db, (m) => console.log(m));
const app = await buildApp({ env, db });
app.ctx.cloud.startSweeper();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: env.HOST, port: env.PORT });
