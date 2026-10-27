import { redactValue } from '@codebridge/shared';
import type { Db } from '../db/pool.js';

export type AuditAction =
  | 'user.register'
  | 'user.login'
  | 'user.login_failed'
  | 'user.logout'
  | 'user.delete'
  | 'auth.refresh_reuse_detected'
  | 'pairing.start'
  | 'pairing.claim'
  | 'pairing.claim_failed'
  | 'pairing.approve'
  | 'pairing.deny'
  | 'pairing.complete'
  | 'device.rename'
  | 'device.revoke'
  | 'device.rotate_secret'
  | 'device.auth_failed'
  | 'session.create'
  | 'session.signal'
  | 'session.approval'
  | 'command.rejected'
  | 'credential.set'
  | 'credential.delete'
  | 'cloud.session_create'
  | 'cloud.session_end'
  | 'cloud.cleanup';

export async function audit(
  db: Db,
  entry: {
    action: AuditAction;
    userId?: string | null;
    deviceId?: string | null;
    ip?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    'INSERT INTO audit_events (user_id, device_id, action, ip, metadata) VALUES ($1, $2, $3, $4, $5)',
    [
      entry.userId ?? null,
      entry.deviceId ?? null,
      entry.action,
      entry.ip ?? null,
      JSON.stringify(redactValue(entry.metadata ?? {})),
    ],
  );
}
