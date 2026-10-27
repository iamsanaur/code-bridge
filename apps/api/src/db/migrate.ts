import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Finds the migrations directory whether running from src/ (tsx) or dist/src/ (node). */
async function migrationsDir(): Promise<string> {
  for (const candidate of [
    process.env.CODEBRIDGE_MIGRATIONS_DIR ?? '',
    path.resolve(here, '../migrations'), // bundled: dist/relay.js next to migrations/
    path.resolve(here, '../../migrations'),
    path.resolve(here, '../../../migrations'),
  ]) {
    try {
      await readdir(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error('migrations directory not found');
}

/**
 * Applies pending *.sql migrations in lexical order, each in its own transaction,
 * guarded by an advisory lock so concurrent instances don't race.
 */
export async function migrate(
  db: Db,
  log: (msg: string) => void = () => undefined,
): Promise<string[]> {
  const dir = await migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727272)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied migration ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727272)').catch(() => undefined);
    client.release();
  }
  return applied;
}
