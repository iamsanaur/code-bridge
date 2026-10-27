import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { uuidSchema, type DeviceDto } from '@codebridge/protocol';
import { audit } from '../lib/audit.js';
import { generateToken, hashToken } from '../lib/crypto.js';
import { authenticateDevice, bearer } from '../lib/deviceAuth.js';
import { notFound, unauthorized } from '../lib/errors.js';

interface DeviceRow {
  id: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  agent_version: string | null;
  capabilities: DeviceDto['capabilities'];
  workspaces: DeviceDto['workspaces'];
  presets: DeviceDto['presets'];
  last_seen_at: Date | null;
  created_at: Date;
}

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  const { db, relay } = app.ctx;

  const toDto = (r: DeviceRow): DeviceDto => ({
    id: r.id,
    name: r.name,
    hostname: r.hostname,
    platform: r.platform,
    agentVersion: r.agent_version,
    online: relay.isOnline(r.id),
    lastSeenAt: r.last_seen_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    capabilities: r.capabilities,
    workspaces: r.workspaces ?? [],
    presets: r.presets ?? [],
  });

  app.get('/v1/devices', { preHandler: app.authenticate }, async (req) => {
    const { rows } = await db.query<DeviceRow>(
      'SELECT * FROM devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at',
      [req.auth!.userId],
    );
    return { devices: rows.map(toDto) };
  });

  app.get('/v1/devices/:id', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: uuidSchema }).parse(req.params);
    const { rows } = await db.query<DeviceRow>(
      'SELECT * FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [id, req.auth!.userId],
    );
    if (!rows[0]) throw notFound('Device not found');
    return toDto(rows[0]);
  });

  app.patch('/v1/devices/:id', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: uuidSchema }).parse(req.params);
    const { name } = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    const { rowCount } = await db.query(
      'UPDATE devices SET name = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [id, req.auth!.userId, name],
    );
    if (!rowCount) throw notFound('Device not found');
    await audit(db, {
      action: 'device.rename',
      userId: req.auth!.userId,
      deviceId: id,
      ip: req.ip,
    });
    return { ok: true };
  });

  /** Revokes a device immediately: its credential stops working and live connections close. */
  app.delete('/v1/devices/:id', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: uuidSchema }).parse(req.params);
    await revoke(id, req.auth!.userId, req.ip, 'revoked by user');
    return { ok: true };
  });

  async function revoke(deviceId: string, userId: string, ip: string, reason: string) {
    const { rowCount } = await db.query(
      `UPDATE devices SET revoked_at = now(), prev_secret_hash = NULL, prev_secret_valid_until = NULL
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [deviceId, userId],
    );
    if (!rowCount) throw notFound('Device not found');
    const live = await db.query<{ id: string }>(
      `UPDATE sessions SET status = 'killed', ended_at = now(), updated_at = now()
        WHERE device_id = $1 AND status NOT IN ('completed', 'failed', 'killed', 'lost') RETURNING id`,
      [deviceId],
    );
    relay.revokeDevice(deviceId, reason);
    for (const s of live.rows)
      relay.broadcastToUser(userId, {
        type: 'session.status',
        sessionId: s.id,
        status: 'killed',
        exitCode: null,
      });
    await audit(db, { action: 'device.revoke', userId, deviceId, ip, metadata: { reason } });
  }

  // ---------------------------------------------------------------------
  // Endpoints called by the Mac agent with its device credential.
  // ---------------------------------------------------------------------

  const deviceAuth = async (req: FastifyRequest) => {
    const identity = await authenticateDevice(db, bearer(req.headers.authorization));
    if (!identity) throw unauthorized('Invalid or revoked device credential');
    req.device = identity;
  };

  app.get('/v1/device/self', { preHandler: deviceAuth }, async (req) => {
    const { rows } = await db.query<{
      id: string;
      name: string;
      email: string;
      secret_rotated_at: Date;
    }>(
      `SELECT d.id, d.name, u.email, d.secret_rotated_at FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = $1`,
      [req.device!.deviceId],
    );
    const d = rows[0]!;
    return {
      deviceId: d.id,
      name: d.name,
      accountEmail: d.email,
      secretRotatedAt: d.secret_rotated_at.toISOString(),
    };
  });

  /**
   * Rotates the device secret. The previous secret stays valid for 10 minutes so an
   * agent that crashes before persisting the new one can retry.
   */
  app.post(
    '/v1/device/rotate',
    { preHandler: deviceAuth, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req) => {
      const deviceSecret = generateToken('cbd');
      await db.query(
        `UPDATE devices SET prev_secret_hash = secret_hash, prev_secret_valid_until = now() + interval '10 minutes',
              secret_hash = $2, secret_rotated_at = now()
        WHERE id = $1`,
        [req.device!.deviceId, hashToken(deviceSecret)],
      );
      await audit(db, {
        action: 'device.rotate_secret',
        userId: req.device!.userId,
        deviceId: req.device!.deviceId,
        ip: req.ip,
      });
      return { deviceSecret };
    },
  );

  /** The Mac owner unpairs locally (or declines a pairing they didn't expect). */
  app.post('/v1/device/self/revoke', { preHandler: deviceAuth }, async (req) => {
    await revoke(req.device!.deviceId, req.device!.userId, req.ip, 'unpaired on the Mac');
    return { ok: true };
  });
}
