import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  createLocalSessionBodySchema,
  gitStatusResultSchema,
  idSchema,
  isTerminalStatus,
  LIMITS,
  uuidSchema,
  type SessionDto,
  type SessionStatus,
  type Usage,
  type WorkspaceInfo,
} from '@codebridge/protocol';
import { assertAck } from '../relay/relay.js';
import { audit } from '../lib/audit.js';
import { deterministicId } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

export interface SessionRow {
  id: string;
  user_id: string;
  kind: 'local' | 'cloud';
  device_id: string | null;
  device_name?: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  mode: SessionDto['mode'];
  title: string;
  status: SessionStatus;
  exit_code: number | null;
  usage: Usage | null;
  provider_session_id: string | null;
  environment_id: string | null;
  created_at: Date;
  ended_at: Date | null;
}

export function sessionDto(r: SessionRow): SessionDto {
  return {
    id: r.id,
    kind: r.kind,
    deviceId: r.device_id,
    deviceName: r.device_name ?? null,
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    mode: r.mode,
    title: r.title,
    status: r.status,
    exitCode: r.exit_code,
    usage: r.usage,
    createdAt: r.created_at.toISOString(),
    endedAt: r.ended_at?.toISOString() ?? null,
    cloud:
      r.kind === 'cloud'
        ? { providerSessionId: r.provider_session_id, environmentId: r.environment_id }
        : null,
  };
}

/** Idempotency key from the `Idempotency-Key` header, or a fresh one. */
export function idempotencyKey(req: FastifyRequest, required = false): string {
  const raw = req.headers['idempotency-key'];
  if (typeof raw === 'string') {
    const parsed = uuidSchema.safeParse(raw);
    if (!parsed.success)
      throw badRequest('invalid_idempotency_key', 'Idempotency-Key must be a UUID');
    return parsed.data;
  }
  if (required) throw badRequest('idempotency_key_required', 'Idempotency-Key header is required');
  return randomUUID();
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  const { db, relay, cloud } = app.ctx;
  const auth = { preHandler: app.authenticate };

  const SESSION_SELECT = `SELECT s.*, d.name AS device_name FROM sessions s LEFT JOIN devices d ON d.id = s.device_id`;

  async function loadSession(id: string, userId: string): Promise<SessionRow> {
    const { rows } = await db.query<SessionRow>(
      `${SESSION_SELECT} WHERE s.id = $1 AND s.user_id = $2`,
      [id, userId],
    );
    if (!rows[0]) throw notFound('Session not found');
    return rows[0];
  }

  async function loadDevice(id: string, userId: string) {
    const { rows } = await db.query<{ id: string; name: string; workspaces: WorkspaceInfo[] }>(
      'SELECT id, name, workspaces FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [id, userId],
    );
    if (!rows[0]) throw notFound('Device not found');
    return rows[0];
  }

  app.get('/v1/sessions', auth, async (req) => {
    const q = z
      .object({
        kind: z.enum(['local', 'cloud']).optional(),
        deviceId: uuidSchema.optional(),
        active: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const where = ['s.user_id = $1'];
    const params: unknown[] = [req.auth!.userId];
    if (q.kind) where.push(`s.kind = $${params.push(q.kind)}`);
    if (q.deviceId) where.push(`s.device_id = $${params.push(q.deviceId)}`);
    if (q.active === 'true')
      where.push(`s.status NOT IN ('completed', 'failed', 'killed', 'lost')`);
    if (q.active === 'false') where.push(`s.status IN ('completed', 'failed', 'killed', 'lost')`);
    const { rows } = await db.query<SessionRow>(
      `${SESSION_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC LIMIT $${params.push(q.limit)}`,
      params,
    );
    return { sessions: rows.map(sessionDto) };
  });

  app.get('/v1/sessions/:id', auth, async (req) => {
    const { id } = z.object({ id: uuidSchema }).parse(req.params);
    return sessionDto(await loadSession(id, req.auth!.userId));
  });

  /** Usage summary across sessions, for the usage & cost screen. */
  app.get('/v1/usage', auth, async (req) => {
    const { rows } = await db.query<{ kind: string; mode: string; usage: Usage }>(
      `SELECT kind, mode, usage FROM sessions WHERE user_id = $1 AND usage IS NOT NULL AND created_at > now() - interval '30 days'`,
      [req.auth!.userId],
    );
    const totals = {
      local: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, sessions: 0 },
      cloud: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, sessions: 0 },
    };
    let unknownCost = 0;
    for (const r of rows) {
      const t = r.kind === 'cloud' ? totals.cloud : totals.local;
      t.sessions++;
      t.inputTokens += r.usage.inputTokens;
      t.outputTokens += r.usage.outputTokens;
      if (r.usage.estimatedCostUsd === null) unknownCost++;
      else t.estimatedCostUsd += r.usage.estimatedCostUsd;
    }
    return { periodDays: 30, totals, sessionsWithUnknownCost: unknownCost };
  });

  /** Starts a session on the user's Mac. The Mac re-validates everything against its local policy. */
  app.post(
    '/v1/devices/:deviceId/sessions',
    { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { deviceId } = z.object({ deviceId: uuidSchema }).parse(req.params);
      const body = createLocalSessionBodySchema.parse(req.body);
      const key = idempotencyKey(req, true);
      const userId = req.auth!.userId;
      const device = await loadDevice(deviceId, userId);
      const workspace = device.workspaces.find((w) => w.id === body.workspaceId);
      if (!workspace)
        throw notFound(
          'Workspace not found on this Mac. Add it on the Mac with `codebridge-agent workspace add`.',
        );
      if (!relay.isOnline(deviceId)) throw conflict('device_offline', 'This Mac is offline');
      if (body.mode === 'command' && !body.presetId && !body.argv)
        throw badRequest('missing_command', 'Choose a preset or enter a command');

      const sessionId = deterministicId(userId, key);
      const title =
        body.mode === 'command'
          ? (body.argv?.join(' ') ?? body.presetId ?? 'command').slice(0, 200)
          : body.mode === 'shell'
            ? 'Interactive shell'
            : body.mode === 'agent'
              ? (body.prompt?.slice(0, 120) ?? 'Coding agent')
              : (body.prompt?.slice(0, 120) ?? 'Claude Code');
      await db.query(
        `INSERT INTO sessions (id, user_id, kind, device_id, workspace_id, workspace_name, mode, title, status)
       VALUES ($1, $2, 'local', $3, $4, $5, $6, $7, 'starting') ON CONFLICT (id) DO NOTHING`,
        [sessionId, userId, deviceId, workspace.id, workspace.name, body.mode, title],
      );
      relay.registerRoute(sessionId, { userId, deviceId, kind: 'local' });

      const ack = await relay.dispatchIdempotent(userId, deviceId, key, {
        op: 'session.start',
        sessionId,
        workspaceId: body.workspaceId,
        mode: body.mode,
        presetId: body.presetId,
        argv: body.argv,
        confirmedRisk: body.confirmedRisk,
        prompt: body.prompt,
        model: body.model,
        cols: body.cols ?? 80,
        rows: body.rows ?? 24,
      });
      if (!ack.ok && ack.error?.code !== 'timeout' && ack.error?.code !== 'device_offline') {
        // Rejected by the Mac's policy: record it, but don't keep a ghost session around.
        await db.query(`DELETE FROM sessions WHERE id = $1 AND status = 'starting'`, [sessionId]);
        await audit(db, {
          action: 'command.rejected',
          userId,
          deviceId,
          ip: req.ip,
          metadata: { op: 'session.start', code: ack.error?.code },
        });
      } else if (ack.ok) {
        await audit(db, {
          action: 'session.create',
          userId,
          deviceId,
          ip: req.ip,
          metadata: { sessionId, mode: body.mode, presetId: body.presetId },
        });
      }
      assertAck(ack);
      return reply.code(201).send(sessionDto(await loadSession(sessionId, userId)));
    },
  );

  app.post('/v1/sessions/:id/signal', auth, async (req) => {
    const { id } = z.object({ id: uuidSchema }).parse(req.params);
    const { signal } = z.object({ signal: z.enum(['interrupt', 'terminate']) }).parse(req.body);
    const s = await loadSession(id, req.auth!.userId);
    await audit(db, {
      action: 'session.signal',
      userId: s.user_id,
      deviceId: s.device_id,
      ip: req.ip,
      metadata: { sessionId: id, signal },
    });
    if (s.kind === 'cloud') {
      if (signal === 'interrupt') await cloud.interrupt(s);
      else await cloud.end(s, 'user');
      return { ok: true };
    }
    if (isTerminalStatus(s.status)) return { ok: true };
    if (!relay.isOnline(s.device_id!)) {
      throw conflict(
        'device_offline',
        'This Mac is offline; the session will stop if the Mac cannot reconnect.',
      );
    }
    assertAck(
      await relay.dispatchIdempotent(s.user_id, s.device_id!, idempotencyKey(req), {
        op: 'session.signal',
        sessionId: id,
        signal,
      }),
    );
    return { ok: true };
  });

  app.post('/v1/sessions/:id/prompt', auth, async (req) => {
    const { id } = z.object({ id: uuidSchema }).parse(req.params);
    const { text } = z
      .object({ text: z.string().trim().min(1).max(LIMITS.maxPromptChars) })
      .parse(req.body);
    const s = await loadSession(id, req.auth!.userId);
    if (isTerminalStatus(s.status)) throw conflict('session_ended', 'This session has ended');
    if (s.kind === 'cloud') {
      await cloud.sendMessage(s, text);
      return { ok: true };
    }
    if (s.mode !== 'agent' && s.mode !== 'claude_code')
      throw badRequest('not_an_agent_session', 'Use terminal input for command sessions');
    assertAck(
      await relay.dispatchIdempotent(s.user_id, s.device_id!, idempotencyKey(req), {
        op: 'agent.prompt',
        sessionId: id,
        text,
      }),
    );
    return { ok: true };
  });

  app.post('/v1/sessions/:id/approvals/:approvalId', auth, async (req) => {
    const { id, approvalId } = z
      .object({ id: uuidSchema, approvalId: z.string().min(1).max(128) })
      .parse(req.params);
    const { decision } = z.object({ decision: z.enum(['approve', 'reject']) }).parse(req.body);
    const s = await loadSession(id, req.auth!.userId);
    await audit(db, {
      action: 'session.approval',
      userId: s.user_id,
      deviceId: s.device_id,
      ip: req.ip,
      metadata: { sessionId: id, approvalId, decision },
    });
    if (s.kind === 'cloud') {
      await cloud.confirmTool(s, approvalId, decision === 'approve');
      return { ok: true };
    }
    assertAck(
      await relay.dispatchIdempotent(s.user_id, s.device_id!, idempotencyKey(req), {
        op: 'approval.respond',
        sessionId: id,
        approvalId,
        decision,
      }),
    );
    return { ok: true };
  });

  app.get('/v1/devices/:deviceId/workspaces/:workspaceId/git/status', auth, async (req) => {
    const { deviceId, workspaceId } = z
      .object({ deviceId: uuidSchema, workspaceId: idSchema })
      .parse(req.params);
    await loadDevice(deviceId, req.auth!.userId);
    const result = assertAck(
      await relay.sendCommand(deviceId, randomUUID(), { op: 'git.status', workspaceId }),
    );
    return gitStatusResultSchema.parse(result);
  });

  app.get('/v1/devices/:deviceId/workspaces/:workspaceId/git/diff', auth, async (req) => {
    const { deviceId, workspaceId } = z
      .object({ deviceId: uuidSchema, workspaceId: idSchema })
      .parse(req.params);
    const { path } = z.object({ path: z.string().max(1024).optional() }).parse(req.query);
    await loadDevice(deviceId, req.auth!.userId);
    const result = assertAck(
      await relay.sendCommand(deviceId, randomUUID(), { op: 'git.diff', workspaceId, path }),
    );
    return z.object({ diff: z.string(), truncated: z.boolean() }).parse(result);
  });
}
