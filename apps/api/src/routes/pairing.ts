import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PAIRING_CODE_ALPHABET, pairingCodeSchema, uuidSchema } from '@codebridge/protocol';
import { withTx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { generateToken, hashToken, safeEqual } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';

/**
 * Pairing follows the OAuth 2.0 Device Authorization Grant pattern (RFC 8628):
 *
 * 1. The Mac agent calls /start and receives a short user code plus a secret
 *    `pollSecret` that only it holds.
 * 2. The signed-in phone submits the user code to /claim, sees which Mac it is,
 *    and confirms with /approve.
 * 3. The agent polls /poll with its pollSecret and receives a device credential
 *    exactly once. The pairing is then consumed.
 *
 * Codes are short-lived (PAIRING_TTL_SECONDS), single-use, rate limited, and the
 * credential can only be collected by the agent that started the flow.
 */

function newUserCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  return s;
}

export const formatCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;

const startBody = z.object({
  deviceName: z.string().trim().min(1).max(100),
  hostname: z.string().max(256).optional(),
  platform: z.string().max(32).optional(),
});

export async function pairingRoutes(app: FastifyInstance): Promise<void> {
  const { db, env } = app.ctx;

  app.post(
    '/v1/pairing/start',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = startBody.parse(req.body);
      const pollSecret = generateToken('cbp');
      const expiresAt = new Date(Date.now() + env.PAIRING_TTL_SECONDS * 1000);
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newUserCode();
        try {
          const { rows } = await db.query<{ id: string }>(
            `INSERT INTO pairings (user_code, poll_secret_hash, device_name, hostname, platform, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6) RETURNING id`,
            [
              code,
              hashToken(pollSecret),
              body.deviceName,
              body.hostname ?? null,
              body.platform ?? null,
              expiresAt,
            ],
          );
          await audit(db, {
            action: 'pairing.start',
            ip: req.ip,
            metadata: { pairingId: rows[0]!.id },
          });
          return reply.code(201).send({
            pairingId: rows[0]!.id,
            userCode: formatCode(code),
            pollSecret,
            expiresAt: expiresAt.toISOString(),
            pollIntervalSeconds: 2,
            // Deep link the phone can scan; contains only the public user code.
            qrPayload: `codebridge://pair?code=${formatCode(code)}&server=${encodeURIComponent(env.PUBLIC_URL)}`,
          });
        } catch (err) {
          if ((err as { code?: string }).code !== '23505') throw err; // retry only on code collision
        }
      }
      throw new Error('could not allocate a pairing code');
    },
  );

  app.post(
    '/v1/pairing/claim',
    { preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const parsed = z.object({ code: pairingCodeSchema }).safeParse(req.body);
      if (!parsed.success)
        throw badRequest('invalid_code', 'Enter the 8-character code shown on your Mac');
      const { rows } = await db.query<{
        id: string;
        device_name: string;
        hostname: string | null;
        platform: string | null;
        expires_at: Date;
        created_at: Date;
      }>(
        `UPDATE pairings SET status = 'claimed', user_id = $2, claimed_at = now()
          WHERE user_code = $1 AND status = 'pending' AND expires_at > now()
          RETURNING id, device_name, hostname, platform, expires_at, created_at`,
        [parsed.data.code, req.auth!.userId],
      );
      const p = rows[0];
      if (!p) {
        await audit(db, { action: 'pairing.claim_failed', userId: req.auth!.userId, ip: req.ip });
        throw notFound(
          'That code is invalid or has expired. Run `codebridge-agent pair` again on your Mac.',
        );
      }
      await audit(db, {
        action: 'pairing.claim',
        userId: req.auth!.userId,
        ip: req.ip,
        metadata: { pairingId: p.id },
      });
      return {
        pairingId: p.id,
        deviceName: p.device_name,
        hostname: p.hostname,
        platform: p.platform,
        requestedAt: p.created_at.toISOString(),
        expiresAt: p.expires_at.toISOString(),
      };
    },
  );

  const decision = async (pairingId: string, userId: string, approve: boolean) => {
    const { rowCount } = await db.query(
      `UPDATE pairings SET status = $3 WHERE id = $1 AND user_id = $2 AND status = 'claimed' AND expires_at > now()`,
      [pairingId, userId, approve ? 'approved' : 'denied'],
    );
    if (!rowCount) throw notFound('Pairing request not found or expired');
  };

  app.post('/v1/pairing/:id/approve', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: uuidSchema }).parse(req.params);
    await decision(id, req.auth!.userId, true);
    await audit(db, {
      action: 'pairing.approve',
      userId: req.auth!.userId,
      ip: req.ip,
      metadata: { pairingId: id },
    });
    return { ok: true };
  });

  app.post('/v1/pairing/:id/deny', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: uuidSchema }).parse(req.params);
    await decision(id, req.auth!.userId, false);
    await audit(db, {
      action: 'pairing.deny',
      userId: req.auth!.userId,
      ip: req.ip,
      metadata: { pairingId: id },
    });
    return { ok: true };
  });

  app.post(
    '/v1/pairing/poll',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const body = z
        .object({ pairingId: uuidSchema, pollSecret: z.string().min(16).max(128) })
        .parse(req.body);
      return withTx(db, async (tx) => {
        const { rows } = await tx.query<{
          id: string;
          poll_secret_hash: Buffer;
          status: string;
          user_id: string | null;
          device_name: string;
          hostname: string | null;
          platform: string | null;
          expires_at: Date;
        }>('SELECT * FROM pairings WHERE id = $1 FOR UPDATE', [body.pairingId]);
        const p = rows[0];
        if (!p || !safeEqual(p.poll_secret_hash, hashToken(body.pollSecret)))
          throw notFound('Unknown pairing');
        if (p.status === 'completed') return { status: 'completed' as const }; // single use: never re-issue
        if (p.status === 'denied') return { status: 'denied' as const };
        if (p.expires_at.getTime() <= Date.now() || p.status === 'expired') {
          await tx.query(`UPDATE pairings SET status = 'expired' WHERE id = $1`, [p.id]);
          return { status: 'expired' as const };
        }
        if (p.status !== 'approved' || !p.user_id) return { status: 'pending' as const };

        const deviceSecret = generateToken('cbd');
        const dev = await tx.query<{ id: string }>(
          `INSERT INTO devices (user_id, name, secret_hash, hostname, platform) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [p.user_id, p.device_name, hashToken(deviceSecret), p.hostname, p.platform],
        );
        const deviceId = dev.rows[0]!.id;
        await tx.query(
          `UPDATE pairings SET status = 'completed', device_id = $2, completed_at = now() WHERE id = $1`,
          [p.id, deviceId],
        );
        const user = await tx.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [
          p.user_id,
        ]);
        await tx.query(
          `INSERT INTO audit_events (user_id, device_id, action, ip) VALUES ($1, $2, 'pairing.complete', $3)`,
          [p.user_id, deviceId, req.ip],
        );
        return {
          status: 'approved' as const,
          deviceId,
          deviceSecret,
          // Shown on the Mac so the owner can confirm the Mac joined *their* account.
          accountEmail: user.rows[0]?.email ?? null,
        };
      });
    },
  );
}
