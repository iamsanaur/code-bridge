import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { badRequest, conflict } from '../lib/errors.js';

/**
 * Anthropic API key for CodeBridge-managed cloud sessions only.
 *
 * Local Mac sessions never use this: their key lives in the Mac's Keychain and is
 * set on the Mac with `codebridge-agent credentials set`. This key is sent once
 * over TLS, encrypted with AES-256-GCM before storage, never returned by the API,
 * and never logged.
 */
export async function credentialRoutes(app: FastifyInstance): Promise<void> {
  const { db, secretBox } = app.ctx;
  const auth = { preHandler: app.authenticate };

  app.get('/v1/credentials/anthropic', auth, async (req) => {
    const { rows } = await db.query<{ hint: string; created_at: Date }>(
      `SELECT hint, created_at FROM provider_credentials WHERE user_id = $1 AND provider = 'anthropic'`,
      [req.auth!.userId],
    );
    return {
      configured: !!rows[0],
      hint: rows[0] ? `••••${rows[0].hint}` : null,
      createdAt: rows[0]?.created_at.toISOString() ?? null,
      storageAvailable: !!secretBox,
    };
  });

  app.put(
    '/v1/credentials/anthropic',
    { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      if (!secretBox)
        throw conflict(
          'storage_unavailable',
          'The server has no credential encryption key configured',
        );
      const { apiKey } = z.object({ apiKey: z.string().trim().min(20).max(256) }).parse(req.body);
      if (!/^sk-ant-[A-Za-z0-9_-]+$/.test(apiKey))
        throw badRequest('invalid_key_format', 'That does not look like an Anthropic API key');
      const userId = req.auth!.userId;
      const sealed = secretBox.seal(apiKey, `anthropic:${userId}`);
      await db.query(
        `INSERT INTO provider_credentials (user_id, provider, ciphertext, iv, auth_tag, key_version, hint)
       VALUES ($1, 'anthropic', $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, provider) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag, key_version = EXCLUDED.key_version, hint = EXCLUDED.hint, created_at = now()`,
        [userId, sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyVersion, apiKey.slice(-4)],
      );
      app.ctx.cloud.forgetClient(userId);
      await audit(db, {
        action: 'credential.set',
        userId,
        ip: req.ip,
        metadata: { provider: 'anthropic' },
      });
      return { ok: true, hint: `••••${apiKey.slice(-4)}` };
    },
  );

  app.delete('/v1/credentials/anthropic', auth, async (req) => {
    await db.query(
      `DELETE FROM provider_credentials WHERE user_id = $1 AND provider = 'anthropic'`,
      [req.auth!.userId],
    );
    app.ctx.cloud.forgetClient(req.auth!.userId);
    await audit(db, {
      action: 'credential.delete',
      userId: req.auth!.userId,
      ip: req.ip,
      metadata: { provider: 'anthropic' },
    });
    return { ok: true };
  });
}
