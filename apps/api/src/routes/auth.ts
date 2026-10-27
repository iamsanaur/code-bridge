import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loginBodySchema, refreshBodySchema, registerBodySchema } from '@codebridge/protocol';
import { audit } from '../lib/audit.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { conflict, HttpError, unauthorized } from '../lib/errors.js';
import { getDummyHash, hashPassword, verifyPassword } from '../lib/passwords.js';

const strict = { rateLimit: { max: 10, timeWindow: '1 minute' } };

/** The single owner of a personal relay. It has no usable password: login is by OWNER_SECRET only. */
const OWNER_EMAIL = 'owner@personal.relay';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { db, tokens, relay, env } = app.ctx;
  const personal = env.RELAY_MODE === 'personal';

  /** Lets the app check that a scanned address is a CodeBridge relay, before it sends anything. */
  app.get('/v1/relay/info', async () => ({ service: 'codebridge-relay', mode: env.RELAY_MODE }));

  const notPersonal = () =>
    new HttpError(
      403,
      'personal_relay',
      'This is a personal relay. Connect by scanning the QR code from `codebridge-agent`.',
    );

  /**
   * Personal relays only. Exchanges the owner secret (from the QR code) for normal tokens.
   * The secret is high-entropy, compared in constant time, and the route is rate limited.
   */
  app.post('/v1/auth/connect', { config: strict }, async (req) => {
    if (!personal) throw new HttpError(403, 'not_personal_relay', 'This relay uses accounts');
    const { secret } = z.object({ secret: z.string().min(1).max(256) }).parse(req.body);
    if (!timingSafeEqual(sha256(secret), sha256(env.OWNER_SECRET!))) {
      await audit(db, { action: 'owner.connect_failed', ip: req.ip });
      throw unauthorized('That connection code is not valid for this relay');
    }
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, '!')
       ON CONFLICT (email) DO UPDATE SET updated_at = now() RETURNING id`,
      [OWNER_EMAIL],
    );
    const userId = rows[0]!.id;
    await audit(db, { action: 'owner.connect', userId, ip: req.ip });
    return {
      user: { id: userId, email: OWNER_EMAIL },
      tokens: await tokens.issue(userId, req.headers['user-agent']),
    };
  });

  app.post('/v1/auth/register', { config: strict }, async (req, reply) => {
    if (personal) throw notPersonal();
    const body = registerBodySchema.parse(req.body);
    const passwordHash = await hashPassword(body.password);
    const { rows } = await db.query<{ id: string }>(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id',
      [body.email, passwordHash],
    );
    const user = rows[0];
    if (!user) throw conflict('email_taken', 'An account with this email already exists');
    await audit(db, { action: 'user.register', userId: user.id, ip: req.ip });
    const pair = await tokens.issue(user.id, req.headers['user-agent']);
    return reply.code(201).send({ user: { id: user.id, email: body.email }, tokens: pair });
  });

  app.post('/v1/auth/login', { config: strict }, async (req) => {
    if (personal) throw notPersonal();
    const body = loginBodySchema.parse(req.body);
    const { rows } = await db.query<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [body.email],
    );
    const user = rows[0];
    // Always run the KDF so response time doesn't reveal whether the email exists.
    const ok = await verifyPassword(body.password, user?.password_hash ?? (await getDummyHash()));
    if (!user || !ok) {
      await audit(db, { action: 'user.login_failed', userId: user?.id ?? null, ip: req.ip });
      throw unauthorized('Incorrect email or password');
    }
    await audit(db, { action: 'user.login', userId: user.id, ip: req.ip });
    return {
      user: { id: user.id, email: body.email },
      tokens: await tokens.issue(user.id, req.headers['user-agent']),
    };
  });

  app.post(
    '/v1/auth/refresh',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const body = refreshBodySchema.parse(req.body);
      const pair = await tokens.refresh(body.refreshToken, req.ip);
      if (!pair) throw unauthorized('Session expired. Please sign in again.');
      return { tokens: pair };
    },
  );

  app.post('/v1/auth/logout', { preHandler: app.authenticate }, async (req) => {
    await tokens.revoke(req.auth!.authSessionId, 'logout');
    relay.disconnectUser(req.auth!.userId, req.auth!.authSessionId);
    await audit(db, { action: 'user.logout', userId: req.auth!.userId, ip: req.ip });
    return { ok: true };
  });

  app.get('/v1/me', { preHandler: app.authenticate }, async (req) => {
    const { rows } = await db.query<{ id: string; email: string; created_at: Date }>(
      'SELECT id, email, created_at FROM users WHERE id = $1',
      [req.auth!.userId],
    );
    const u = rows[0];
    if (!u) throw unauthorized();
    return { id: u.id, email: u.email, createdAt: u.created_at.toISOString() };
  });

  /**
   * Permanently deletes the account. Requires the password again. Cascades to
   * devices (revoking them), sessions, credentials and command history; audit rows
   * are retained with the user reference nulled.
   */
  app.delete('/v1/me', { preHandler: app.authenticate, config: strict }, async (req) => {
    if (personal) throw notPersonal();
    const body = z.object({ password: z.string().min(1).max(256) }).parse(req.body);
    const userId = req.auth!.userId;
    const { rows } = await db.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId],
    );
    if (!rows[0] || !(await verifyPassword(body.password, rows[0].password_hash)))
      throw unauthorized('Incorrect password');

    const devices = await db.query<{ id: string }>('SELECT id FROM devices WHERE user_id = $1', [
      userId,
    ]);
    await app.ctx.cloud.endAllForUser(userId, 'account_deleted');
    await audit(db, {
      action: 'user.delete',
      userId,
      ip: req.ip,
      metadata: { devices: devices.rowCount },
    });
    await db.query('DELETE FROM users WHERE id = $1', [userId]);
    for (const d of devices.rows) relay.revokeDevice(d.id, 'account deleted');
    relay.disconnectUser(userId);
    relay.forgetRoutesForUser(userId);
    return { ok: true };
  });
}
