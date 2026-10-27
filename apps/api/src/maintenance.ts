import type { FastifyBaseLogger } from 'fastify';
import type { Db } from './db/pool.js';

/**
 * Data-retention housekeeping (documented in docs/SECURITY.md):
 * - pairings: deleted 1 day after expiry/completion (they contain no secrets, only hashes)
 * - commands (idempotency records): 7 days
 * - auth sessions: 30 days after revocation or refresh expiry
 * - audit events: 365 days
 */
export async function runMaintenance(db: Db): Promise<Record<string, number>> {
  const q = async (sql: string) => (await db.query(sql)).rowCount ?? 0;
  return {
    pairings: await q(`DELETE FROM pairings WHERE expires_at < now() - interval '1 day'`),
    commands: await q(`DELETE FROM commands WHERE created_at < now() - interval '7 days'`),
    authSessions: await q(
      `DELETE FROM auth_sessions WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days') OR refresh_expires_at < now() - interval '30 days'`,
    ),
    auditEvents: await q(`DELETE FROM audit_events WHERE created_at < now() - interval '365 days'`),
  };
}

export function startMaintenance(
  db: Db,
  log: FastifyBaseLogger,
  intervalMs = 60 * 60_000,
): () => void {
  const tick = () =>
    runMaintenance(db)
      .then((r) => log.info({ deleted: r }, 'maintenance complete'))
      .catch((err: unknown) => log.error({ err }, 'maintenance failed'));
  void tick();
  const t = setInterval(tick, intervalMs);
  t.unref();
  return () => clearInterval(t);
}
