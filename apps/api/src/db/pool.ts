import { mkdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

/** The few pg-shaped operations the relay uses. Implemented by `pg` and by embedded PGlite. */
export interface QueryResult<R> {
  rows: R[];
  rowCount: number | null;
}
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<R extends Record<string, any> = any>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<R>>;
}
export interface DbClient extends Queryable {
  release(): void;
}
export interface Db extends Queryable {
  connect(): Promise<DbClient>;
  end(): Promise<void>;
}

/**
 * `postgres://…` uses a normal Postgres server. `pglite://<dir>` runs Postgres embedded
 * in this process (WebAssembly) and keeps its files in <dir>; `pglite://memory` is
 * throwaway. The embedded mode is what makes a personal relay a single process with
 * nothing else to install or pay for.
 */
export function createPool(connectionString: string): Db {
  if (connectionString.startsWith('pglite://')) return createPglite(connectionString);
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
  });
  return pool as unknown as Db;
}

function createPglite(url: string): Db {
  const target = url.slice('pglite://'.length);
  let dir: string | undefined;
  if (target && target !== 'memory') {
    dir = path.resolve(target);
    mkdirSync(dir, { recursive: true });
  }
  return new PgliteDb(new PGlite(dir));
}

/** bytea comes back as Uint8Array from PGlite but as Buffer from pg. Normalise to Buffer. */
function normaliseRows<R>(rows: unknown[]): R[] {
  for (const row of rows as Record<string, unknown>[]) {
    for (const k of Object.keys(row)) {
      const v = row[k];
      if (v instanceof Uint8Array && !Buffer.isBuffer(v)) row[k] = Buffer.from(v);
    }
  }
  return rows as R[];
}

class PgliteDb implements Db {
  /** PGlite has one connection, so a transaction must own it exclusively. */
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly pg: PGlite) {}

  private acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const ready = this.tail.then(() => release);
    this.tail = this.tail.then(() => held);
    return ready;
  }

  private async run<R>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
    if (params === undefined) {
      // No parameters: allow several statements (migrations), like pg's simple query protocol.
      const results = await this.pg.exec(sql);
      const last = results[results.length - 1];
      const rows = normaliseRows<R>(last?.rows ?? []);
      return { rows, rowCount: rows.length || (last?.affectedRows ?? 0) };
    }
    const r = await this.pg.query(sql, params);
    const rows = normaliseRows<R>(r.rows);
    return { rows, rowCount: rows.length || (r.affectedRows ?? 0) };
  }

  async query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<R>> {
    const release = await this.acquire();
    try {
      return await this.run<R>(sql, params);
    } finally {
      release();
    }
  }

  async connect(): Promise<DbClient> {
    const release = await this.acquire();
    let released = false;
    return {
      query: (sql, params) => this.run(sql, params),
      release: () => {
        if (released) return;
        released = true;
        release();
      },
    };
  }

  async end(): Promise<void> {
    await this.tail;
    await this.pg.close();
  }
}

/** Runs `fn` in a transaction, rolling back on any error. */
export async function withTx<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
