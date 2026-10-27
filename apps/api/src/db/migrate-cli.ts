import { loadEnv } from '../env.js';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';

const env = loadEnv();
const db = createPool(env.DATABASE_URL);
try {
  const applied = await migrate(db, (m) => console.log(m));
  console.log(applied.length ? `done (${applied.length} applied)` : 'database is up to date');
} finally {
  await db.end();
}
