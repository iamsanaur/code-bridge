import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LIMITS, uuidSchema } from '@codebridge/protocol';
import { MODEL_PRICES } from '@codebridge/shared';
import { badRequest, notFound } from '../lib/errors.js';
import { idempotencyKey, sessionDto, type SessionRow } from './sessions.js';

const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/,
    'must be a hostname such as api.github.com',
  );

export async function cloudRoutes(app: FastifyInstance): Promise<void> {
  const { db, cloud } = app.ctx;
  const auth = { preHandler: app.authenticate };

  app.get('/v1/cloud/config', auth, async (req) => {
    const cfg = await cloud.getConfig(req.auth!.userId);
    const key = await db.query(
      `SELECT 1 FROM provider_credentials WHERE user_id = $1 AND provider = 'anthropic'`,
      [req.auth!.userId],
    );
    return {
      enabled: cloud.enabled,
      keyConfigured: (key.rowCount ?? 0) > 0,
      ...cfg,
      availableModels: Object.keys(MODEL_PRICES),
      billing:
        'Cloud sessions run on Anthropic Managed Agents and are billed to your Anthropic API key: model tokens at list price plus session runtime ($0.08 per active hour at time of writing). The budget is a hard cap enforced by Anthropic.',
      sandbox:
        'Each session runs in an isolated Anthropic-hosted container. It cannot see your Mac or its files. Network access is limited to package registries and the hosts you allow unless you choose unrestricted.',
    };
  });

  app.put('/v1/cloud/config', auth, async (req) => {
    const body = z
      .object({
        model: z.enum(Object.keys(MODEL_PRICES) as [string, ...string[]]).optional(),
        networking: z.enum(['limited', 'unrestricted']).optional(),
        allowedHosts: z.array(hostSchema).max(32).optional(),
        budgetCents: z.number().int().min(10).max(10_000).optional(),
      })
      .parse(req.body);
    return cloud.updateConfig(req.auth!.userId, body);
  });

  app.post(
    '/v1/cloud/sessions',
    { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = z
        .object({
          prompt: z.string().trim().min(1).max(LIMITS.maxPromptChars),
          title: z.string().trim().max(120).optional(),
        })
        .parse(req.body);
      const id = await cloud.create(req.auth!.userId, {
        ...body,
        idempotencyKey: idempotencyKey(req, true),
      });
      const { rows } = await db.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
      return reply.code(201).send(sessionDto(rows[0]!));
    },
  );

  app.post('/v1/cloud/sessions/:id/end', auth, async (req) => {
    const { id } = z.object({ id: uuidSchema }).parse(req.params);
    const { rows } = await db.query<SessionRow>(
      'SELECT * FROM sessions WHERE id = $1 AND user_id = $2',
      [id, req.auth!.userId],
    );
    const s = rows[0];
    if (!s) throw notFound('Session not found');
    if (s.kind !== 'cloud') throw badRequest('not_cloud', 'Not a cloud session');
    await cloud.end(s, 'user');
    return { ok: true };
  });
}
