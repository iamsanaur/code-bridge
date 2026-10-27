import type { Db } from '../db/pool.js';
import { hashToken } from './crypto.js';

export interface DeviceIdentity {
  deviceId: string;
  userId: string;
}

/**
 * Resolves a device credential to its device. The device id is derived from the
 * credential itself – a client-supplied device id is never trusted.
 */
export async function authenticateDevice(
  db: Db,
  secret: string | undefined,
): Promise<DeviceIdentity | null> {
  if (!secret || !secret.startsWith('cbd_') || secret.length > 128) return null;
  const h = hashToken(secret);
  const { rows } = await db.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM devices
      WHERE revoked_at IS NULL
        AND (secret_hash = $1 OR (prev_secret_hash = $1 AND prev_secret_valid_until > now()))`,
    [h],
  );
  const row = rows[0];
  return row ? { deviceId: row.id, userId: row.user_id } : null;
}

export function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m?.[1];
}
