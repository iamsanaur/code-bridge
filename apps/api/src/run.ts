import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { migrate } from './db/migrate.js';
import { createPool, type Db } from './db/pool.js';
import type { Env } from './env.js';
import { startMaintenance } from './maintenance.js';

export interface RunningRelay {
  app: FastifyInstance;
  db: Db;
  stop: () => Promise<void>;
}

/** Opens the database, applies migrations and starts listening. Shared by the server and the CLI. */
export async function runRelay(
  env: Env,
  log: (m: string) => void = () => undefined,
): Promise<RunningRelay> {
  const db = createPool(env.DATABASE_URL);
  await migrate(db, log);
  const app = await buildApp({ env, db });
  app.ctx.cloud.startSweeper();
  const stopMaintenance = startMaintenance(db, app.log);
  await app.listen({ host: env.HOST, port: env.PORT });
  return {
    app,
    db,
    stop: async () => {
      stopMaintenance();
      await app.close();
      await db.end();
    },
  };
}
