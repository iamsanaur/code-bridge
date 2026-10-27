import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  isTerminalStatus,
  type AgentCommand,
  type AgentToServer,
  type ClientToServer,
  type SequencedEvent,
  type ServerToAgent,
  type ServerToClient,
  type SessionStatus,
} from '@codebridge/protocol';
import type { Db } from '../db/pool.js';
import { conflict, HttpError } from '../lib/errors.js';
import { EventBuffer } from './eventBuffer.js';

/** Minimal socket surface we need (satisfied by `ws.WebSocket`). */
export interface RelaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

export interface AckResult {
  ok: boolean;
  error?: { code: string; message: string };
  result?: unknown;
}

interface AgentConn {
  deviceId: string;
  userId: string;
  socket: RelaySocket;
  connectedAt: number;
}

export interface ClientConn {
  id: string;
  userId: string;
  authSessionId: string;
  socket: RelaySocket;
  subscriptions: Set<string>;
}

interface PendingAck {
  deviceId: string;
  timer: NodeJS.Timeout;
  resolve: (r: AckResult) => void;
}

interface SessionRoute {
  userId: string;
  deviceId: string | null;
  kind: 'local' | 'cloud';
}

/** Replays cloud events for a session; provided by the cloud session manager. */
export type CloudReplayFn = (
  sessionId: string,
  afterSeq: number,
  conn: ClientConn,
) => Promise<void>;

/** Small LRU set for duplicate suppression. */
class LruSet {
  private readonly map = new Map<string, true>();
  constructor(private readonly max: number) {}
  /** Returns false if the key was already present. */
  add(key: string): boolean {
    if (this.map.has(key)) return false;
    this.map.set(key, true);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return true;
  }
}

/**
 * The relay connects authenticated Mac agents with their owner's mobile clients.
 *
 * Authorization invariants enforced here:
 * - A device's identity comes only from its verified credential (set at attach time).
 * - Events from a device are accepted only for sessions that belong to that device.
 * - Clients only receive events for sessions owned by their user.
 * - Commands are only forwarded to devices owned by the requesting user.
 */
export class Relay {
  private readonly agents = new Map<string, AgentConn>();
  private readonly clients = new Map<string, Set<ClientConn>>();
  private readonly pending = new Map<string, PendingAck>();
  private readonly routes = new Map<string, SessionRoute>();
  private readonly seenClientCommands = new LruSet(20_000);
  readonly buffer = new EventBuffer();
  cloudReplay: CloudReplayFn | null = null;

  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
    private readonly ackTimeoutMs: number,
  ) {}

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  isOnline(deviceId: string): boolean {
    return this.agents.has(deviceId);
  }

  onlineDeviceIds(): Set<string> {
    return new Set(this.agents.keys());
  }

  attachAgent(deviceId: string, userId: string, socket: RelaySocket): void {
    const existing = this.agents.get(deviceId);
    if (existing) {
      // Only one live connection per device; the newest wins.
      existing.socket.close(4409, 'replaced by a newer connection');
    }
    this.agents.set(deviceId, { deviceId, userId, socket, connectedAt: Date.now() });
    this.sendToAgent(socket, { type: 'server.hello', deviceId, serverTime: Date.now() });
  }

  async detachAgent(deviceId: string, socket: RelaySocket): Promise<void> {
    const conn = this.agents.get(deviceId);
    if (!conn || conn.socket !== socket) return; // a newer connection replaced this one
    this.agents.delete(deviceId);
    for (const [id, p] of this.pending) {
      if (p.deviceId === deviceId) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.resolve({
          ok: false,
          error: { code: 'device_offline', message: 'The Mac disconnected' },
        });
      }
    }
    const { rows } = await this.db.query<{ last_seen_at: Date | null }>(
      'UPDATE devices SET last_seen_at = now() WHERE id = $1 RETURNING last_seen_at',
      [deviceId],
    );
    this.broadcastToUser(conn.userId, {
      type: 'device.status',
      deviceId,
      online: false,
      lastSeenAt: rows[0]?.last_seen_at?.toISOString() ?? null,
    });
  }

  async handleAgentMessage(deviceId: string, msg: AgentToServer): Promise<void> {
    const conn = this.agents.get(deviceId);
    if (!conn) return;
    switch (msg.type) {
      case 'agent.ping':
        this.sendToAgent(conn.socket, { type: 'server.pong', ts: msg.ts });
        await this.db.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [deviceId]);
        return;
      case 'agent.hello':
        await this.onHello(conn, msg);
        return;
      case 'agent.ack': {
        const p = this.pending.get(msg.commandId);
        if (!p || p.deviceId !== deviceId) return; // unknown or not this device's command
        clearTimeout(p.timer);
        this.pending.delete(msg.commandId);
        p.resolve({ ok: msg.ok, error: msg.error, result: msg.result });
        return;
      }
      case 'agent.event': {
        const { type: _t, ...ev } = msg;
        const route = await this.route(ev.sessionId);
        if (!route || route.kind !== 'local' || route.deviceId !== deviceId) {
          this.log.warn(
            { deviceId, sessionId: ev.sessionId },
            'dropping event for a session this device does not own',
          );
          return;
        }
        await this.publish(ev, route);
        return;
      }
    }
  }

  private async onHello(
    conn: AgentConn,
    msg: Extract<AgentToServer, { type: 'agent.hello' }>,
  ): Promise<void> {
    await this.db.query(
      `UPDATE devices SET hostname = $2, platform = $3, arch = $4, agent_version = $5, capabilities = $6,
              workspaces = $7, presets = $8, last_seen_at = now()
        WHERE id = $1`,
      [
        conn.deviceId,
        msg.hostname,
        msg.platform,
        msg.arch,
        msg.agentVersion,
        JSON.stringify(msg.capabilities),
        JSON.stringify(msg.workspaces),
        JSON.stringify(msg.presets),
      ],
    );
    // Reconcile: sessions the DB thinks are live but the agent no longer knows about
    // were lost (e.g. the Mac or agent restarted). We never pretend they survived.
    const known = msg.sessions.map((s) => s.sessionId);
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE sessions SET status = 'lost', ended_at = now(), updated_at = now()
        WHERE device_id = $1 AND kind = 'local'
          AND status NOT IN ('completed', 'failed', 'killed', 'lost')
          AND NOT (id = ANY($2::uuid[]))
        RETURNING id`,
      [conn.deviceId, known],
    );
    for (const r of rows) {
      this.broadcastToUser(conn.userId, {
        type: 'session.status',
        sessionId: r.id,
        status: 'lost',
        exitCode: null,
      });
    }
    for (const s of msg.sessions) {
      await this.db.query(
        `UPDATE sessions SET status = $3, updated_at = now() WHERE id = $1 AND device_id = $2 AND status <> $3`,
        [s.sessionId, conn.deviceId, s.status],
      );
    }
    this.broadcastToUser(conn.userId, {
      type: 'device.status',
      deviceId: conn.deviceId,
      online: true,
      lastSeenAt: new Date().toISOString(),
    });
  }

  /** Sends a command to a device and waits for its ack. */
  sendCommand(deviceId: string, commandId: string, command: AgentCommand): Promise<AckResult> {
    const conn = this.agents.get(deviceId);
    if (!conn)
      return Promise.resolve({
        ok: false,
        error: { code: 'device_offline', message: 'The Mac is offline' },
      });
    return new Promise<AckResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        resolve({
          ok: false,
          error: { code: 'timeout', message: 'The Mac did not respond in time' },
        });
      }, this.ackTimeoutMs);
      this.pending.set(commandId, { deviceId, timer, resolve });
      this.sendToAgent(conn.socket, {
        type: 'server.command',
        commandId,
        issuedAt: Date.now(),
        command,
      });
    });
  }

  /**
   * Durable, idempotent command dispatch for REST control operations. The same
   * (user, commandId) is executed at most once; repeats return the stored result.
   */
  async dispatchIdempotent(
    userId: string,
    deviceId: string,
    commandId: string,
    command: AgentCommand,
  ): Promise<AckResult> {
    const inserted = await this.db.query(
      `INSERT INTO commands (id, user_id, device_id, op, status) VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [commandId, userId, deviceId, command.op],
    );
    if (inserted.rowCount === 0) {
      const { rows } = await this.db.query<{
        user_id: string;
        status: string;
        result: AckResult | null;
        op: string;
      }>('SELECT user_id, status, result, op FROM commands WHERE id = $1', [commandId]);
      const row = rows[0];
      if (!row || row.user_id !== userId || row.op !== command.op) {
        throw conflict(
          'idempotency_key_reused',
          'This idempotency key was already used for a different request',
        );
      }
      if (row.status === 'pending')
        throw conflict('command_in_progress', 'This command is still being processed');
      return row.result ?? { ok: false, error: { code: 'unknown', message: 'No result recorded' } };
    }
    const ack = await this.sendCommand(deviceId, commandId, command);
    if (!ack.ok && (ack.error?.code === 'timeout' || ack.error?.code === 'device_offline')) {
      // Delivery is uncertain: allow a retry with the same key. The agent also
      // de-duplicates command ids, so a late duplicate is never executed twice.
      await this.db.query('DELETE FROM commands WHERE id = $1', [commandId]);
    } else {
      await this.db.query('UPDATE commands SET status = $2, result = $3 WHERE id = $1', [
        commandId,
        ack.ok ? 'ok' : 'error',
        JSON.stringify(ack),
      ]);
    }
    return ack;
  }

  revokeDevice(deviceId: string, reason: string): void {
    const conn = this.agents.get(deviceId);
    if (!conn) return;
    this.sendToAgent(conn.socket, { type: 'server.revoked', reason });
    conn.socket.close(4401, 'device revoked');
    this.agents.delete(deviceId);
    this.broadcastToUser(conn.userId, {
      type: 'device.status',
      deviceId,
      online: false,
      lastSeenAt: new Date().toISOString(),
    });
  }

  // -------------------------------------------------------------------------
  // Sessions & events
  // -------------------------------------------------------------------------

  registerRoute(sessionId: string, route: SessionRoute): void {
    this.routes.set(sessionId, route);
  }

  forgetRoutesForUser(userId: string): void {
    for (const [id, r] of this.routes) if (r.userId === userId) this.routes.delete(id);
  }

  private async route(sessionId: string): Promise<SessionRoute | null> {
    const cached = this.routes.get(sessionId);
    if (cached) return cached;
    const { rows } = await this.db.query<{
      user_id: string;
      device_id: string | null;
      kind: 'local' | 'cloud';
    }>('SELECT user_id, device_id, kind FROM sessions WHERE id = $1', [sessionId]);
    const row = rows[0];
    if (!row) return null;
    const route = { userId: row.user_id, deviceId: row.device_id, kind: row.kind };
    this.routes.set(sessionId, route);
    return route;
  }

  /** Buffers an event, persists status/usage metadata, and fans out to subscribers. */
  async publish(ev: SequencedEvent, route?: SessionRoute): Promise<void> {
    const r = route ?? (await this.route(ev.sessionId));
    if (!r) return;
    this.buffer.push(ev);
    const e = ev.event;
    if (e.kind === 'status') {
      const terminal = isTerminalStatus(e.status);
      await this.db.query(
        `UPDATE sessions SET status = $2, exit_code = COALESCE($3, exit_code), last_seq = GREATEST(last_seq, $4),
                updated_at = now(), ended_at = CASE WHEN $5 THEN COALESCE(ended_at, now()) ELSE ended_at END
          WHERE id = $1`,
        [ev.sessionId, e.status, e.exitCode ?? null, ev.seq, terminal],
      );
      this.broadcastToUser(r.userId, {
        type: 'session.status',
        sessionId: ev.sessionId,
        status: e.status,
        exitCode: e.exitCode ?? null,
      });
    } else if (e.kind === 'usage') {
      await this.db.query('UPDATE sessions SET usage = $2, updated_at = now() WHERE id = $1', [
        ev.sessionId,
        JSON.stringify(e.usage),
      ]);
    }
    const conns = this.clients.get(r.userId);
    if (!conns) return;
    const frame = JSON.stringify({ type: 'event', ...ev } satisfies ServerToClient);
    for (const c of conns) if (c.subscriptions.has(ev.sessionId)) safeSend(c.socket, frame);
  }

  /** Updates status for sessions whose events are not sequenced by an agent (e.g. lost). */
  async markStatus(sessionId: string, userId: string, status: SessionStatus): Promise<void> {
    await this.db.query(
      `UPDATE sessions SET status = $2, updated_at = now(), ended_at = CASE WHEN $3 THEN COALESCE(ended_at, now()) ELSE ended_at END WHERE id = $1`,
      [sessionId, status, isTerminalStatus(status)],
    );
    this.broadcastToUser(userId, { type: 'session.status', sessionId, status, exitCode: null });
  }

  // -------------------------------------------------------------------------
  // Clients
  // -------------------------------------------------------------------------

  attachClient(conn: ClientConn): void {
    let set = this.clients.get(conn.userId);
    if (!set) this.clients.set(conn.userId, (set = new Set()));
    set.add(conn);
  }

  detachClient(conn: ClientConn): void {
    const set = this.clients.get(conn.userId);
    set?.delete(conn);
    if (set && set.size === 0) this.clients.delete(conn.userId);
  }

  /** Closes all client sockets for a user (logout everywhere, account deletion). */
  disconnectUser(userId: string, authSessionId?: string): void {
    for (const c of this.clients.get(userId) ?? []) {
      if (!authSessionId || c.authSessionId === authSessionId) c.socket.close(4401, 'signed out');
    }
  }

  async handleClientMessage(conn: ClientConn, msg: ClientToServer): Promise<void> {
    switch (msg.type) {
      case 'auth':
        return; // already authenticated; ignore
      case 'ping':
        this.sendToClient(conn, { type: 'pong', ts: msg.ts });
        return;
      case 'unsubscribe':
        conn.subscriptions.delete(msg.sessionId);
        return;
      case 'subscribe':
        await this.subscribe(conn, msg.sessionId, msg.afterSeq);
        return;
      case 'command':
        await this.clientCommand(conn, msg.commandId, msg.command);
        return;
    }
  }

  private async subscribe(conn: ClientConn, sessionId: string, afterSeq: number): Promise<void> {
    const route = await this.route(sessionId);
    if (!route || route.userId !== conn.userId) {
      this.sendToClient(conn, { type: 'error', code: 'not_found', message: 'Session not found' });
      return;
    }
    if (conn.subscriptions.size >= 50 && !conn.subscriptions.has(sessionId)) {
      this.sendToClient(conn, {
        type: 'error',
        code: 'too_many_subscriptions',
        message: 'Unsubscribe from other sessions first',
      });
      return;
    }
    conn.subscriptions.add(sessionId);

    const buffered = this.buffer.since(sessionId, afterSeq);
    if (buffered.complete) {
      for (const ev of buffered.events)
        safeSend(conn.socket, JSON.stringify({ type: 'event', ...ev }));
      return;
    }
    if (route.kind === 'cloud') {
      if (this.cloudReplay) await this.cloudReplay(sessionId, afterSeq, conn);
      return;
    }
    if (route.deviceId && this.isOnline(route.deviceId)) {
      // Ask the Mac to replay from its own buffer; events flow back through publish().
      const ack = await this.sendCommand(route.deviceId, randomUUID(), {
        op: 'session.replay',
        sessionId,
        afterSeq,
      });
      const oldest = (ack.result as { oldestAvailableSeq?: number } | undefined)
        ?.oldestAvailableSeq;
      if (ack.ok && typeof oldest === 'number' && oldest > afterSeq + 1) {
        this.sendToClient(conn, { type: 'replay.gap', sessionId, resumeFromSeq: oldest });
      }
      if (ack.ok) return;
    }
    // The Mac is unavailable: serve what we have and tell the client about the gap.
    const first = buffered.events[0];
    if (first && first.seq > afterSeq + 1)
      this.sendToClient(conn, { type: 'replay.gap', sessionId, resumeFromSeq: first.seq });
    for (const ev of buffered.events)
      safeSend(conn.socket, JSON.stringify({ type: 'event', ...ev }));
  }

  private async clientCommand(
    conn: ClientConn,
    commandId: string,
    command: Extract<ClientToServer, { type: 'command' }>['command'],
  ): Promise<void> {
    const reply = (ack: AckResult) =>
      this.sendToClient(conn, {
        type: 'command.ack',
        commandId,
        ok: ack.ok,
        ...(ack.error ? { error: ack.error } : {}),
      });

    if (!this.seenClientCommands.add(`${conn.userId}:${commandId}`)) {
      reply({ ok: false, error: { code: 'duplicate', message: 'Duplicate command ignored' } });
      return;
    }
    const route = await this.route(command.sessionId);
    if (!route || route.userId !== conn.userId) {
      reply({ ok: false, error: { code: 'not_found', message: 'Session not found' } });
      return;
    }
    if (route.kind !== 'local' || !route.deviceId) {
      reply({
        ok: false,
        error: {
          code: 'unsupported',
          message: 'Terminal input is only available for local Mac sessions',
        },
      });
      return;
    }
    const ack = await this.sendCommand(route.deviceId, commandId, command);
    reply(ack);
  }

  broadcastToUser(userId: string, msg: ServerToClient): void {
    const conns = this.clients.get(userId);
    if (!conns) return;
    const frame = JSON.stringify(msg);
    for (const c of conns) safeSend(c.socket, frame);
  }

  sendToClient(conn: ClientConn, msg: ServerToClient): void {
    safeSend(conn.socket, JSON.stringify(msg));
  }

  private sendToAgent(socket: RelaySocket, msg: ServerToAgent): void {
    safeSend(socket, JSON.stringify(msg));
  }

  shutdown(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    for (const a of this.agents.values()) a.socket.close(1001, 'server shutting down');
    for (const set of this.clients.values())
      for (const c of set) c.socket.close(1001, 'server shutting down');
  }
}

function safeSend(socket: RelaySocket, data: string): void {
  if (socket.readyState === 1) {
    try {
      socket.send(data);
    } catch {
      // socket closing; the close handler cleans up
    }
  }
}

export function assertAck(ack: AckResult): unknown {
  if (ack.ok) return ack.result;
  const code = ack.error?.code ?? 'agent_error';
  const status =
    code === 'device_offline' || code === 'timeout'
      ? 503
      : code === 'requires_confirmation'
        ? 409
        : code === 'forbidden' || code === 'policy_denied'
          ? 403
          : 422;
  throw new HttpError(status, code, ack.error?.message ?? 'The Mac rejected the command');
}
