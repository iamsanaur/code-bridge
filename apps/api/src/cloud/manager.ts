import type { FastifyBaseLogger } from 'fastify';
import { backoffDelay } from '@codebridge/shared';
import { isTerminalStatus, type SequencedEvent, type SessionStatus } from '@codebridge/protocol';
import type { Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { deterministicId } from '../lib/crypto.js';
import { conflict, HttpError, notFound } from '../lib/errors.js';
import type { SecretBox } from '../lib/secretBox.js';
import type { ClientConn, Relay } from '../relay/relay.js';
import type { SessionRow } from '../routes/sessions.js';
import {
  ProviderError,
  type CloudResources,
  type ManagedCloudSessionProvider,
  type MappedProviderEvent,
} from './provider.js';

export type CloudProviderFactory = (apiKey: string) => ManagedCloudSessionProvider;

export interface CloudDefaults {
  model: string;
  budgetCents: number;
  maxConcurrent: number;
  maxSessionMinutes: number;
}

export interface CloudConfig {
  model: string;
  networking: 'limited' | 'unrestricted';
  allowedHosts: string[];
  budgetCents: number;
  maxConcurrent: number;
  resources: CloudResources | null;
}

interface Watch {
  sessionId: string;
  userId: string;
  providerSessionId: string;
  abort: AbortController;
  seen: Set<string>;
  events: SequencedEvent[];
  seq: number;
  status: SessionStatus;
  stopped: boolean;
}

const MAX_BUDGET_CENTS = 10_000;

/**
 * Lifecycle of CodeBridge-managed cloud sessions. Cloud state is kept entirely
 * separate from local Mac sessions: different provider, different credential
 * (the server-stored, encrypted key), and sessions with `kind = 'cloud'` and no device.
 */
export class CloudSessionManager {
  private readonly providers = new Map<
    string,
    { provider: ManagedCloudSessionProvider; expires: number }
  >();
  private readonly watches = new Map<string, Watch>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private readonly o: {
      db: Db;
      relay: Relay;
      secretBox: SecretBox | null;
      log: FastifyBaseLogger;
      providerFactory: CloudProviderFactory;
      enabled: boolean;
      defaults: CloudDefaults;
    },
  ) {}

  get enabled(): boolean {
    return this.o.enabled;
  }

  // ---------------------------------------------------------------------------
  // Configuration & credentials
  // ---------------------------------------------------------------------------

  async getConfig(userId: string): Promise<CloudConfig> {
    const { rows } = await this.o.db.query<{
      agent_id: string | null;
      agent_version: number | null;
      environment_id: string | null;
      model: string;
      networking: 'limited' | 'unrestricted';
      allowed_hosts: string[];
      budget_cents: number;
      max_concurrent: number;
    }>('SELECT * FROM cloud_configs WHERE user_id = $1', [userId]);
    const r = rows[0];
    if (!r) {
      return {
        model: this.o.defaults.model,
        networking: 'limited',
        allowedHosts: [],
        budgetCents: this.o.defaults.budgetCents,
        maxConcurrent: this.o.defaults.maxConcurrent,
        resources: null,
      };
    }
    return {
      model: r.model,
      networking: r.networking,
      allowedHosts: r.allowed_hosts,
      budgetCents: r.budget_cents,
      maxConcurrent: r.max_concurrent,
      resources:
        r.agent_id && r.environment_id && r.agent_version
          ? { agentId: r.agent_id, agentVersion: r.agent_version, environmentId: r.environment_id }
          : null,
    };
  }

  async updateConfig(
    userId: string,
    patch: {
      model?: string;
      networking?: 'limited' | 'unrestricted';
      allowedHosts?: string[];
      budgetCents?: number;
    },
  ): Promise<CloudConfig> {
    const current = await this.getConfig(userId);
    const next = {
      ...current,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    } as CloudConfig;
    next.budgetCents = Math.min(MAX_BUDGET_CENTS, next.budgetCents);
    next.maxConcurrent = Math.min(next.maxConcurrent, this.o.defaults.maxConcurrent);
    // Apply to Anthropic now (if a key is configured) so errors surface on the settings screen.
    const provider = await this.providerFor(userId, false);
    if (provider) {
      next.resources = await provider.ensureResources(
        { model: next.model, networking: next.networking, allowedHosts: next.allowedHosts },
        current.resources ?? {},
      );
    }
    await this.saveConfig(userId, next);
    return next;
  }

  private async saveConfig(userId: string, c: CloudConfig): Promise<void> {
    await this.o.db.query(
      `INSERT INTO cloud_configs (user_id, agent_id, agent_version, environment_id, model, networking, allowed_hosts, budget_cents, max_concurrent, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (user_id) DO UPDATE SET agent_id = EXCLUDED.agent_id, agent_version = EXCLUDED.agent_version,
         environment_id = EXCLUDED.environment_id, model = EXCLUDED.model, networking = EXCLUDED.networking,
         allowed_hosts = EXCLUDED.allowed_hosts, budget_cents = EXCLUDED.budget_cents,
         max_concurrent = EXCLUDED.max_concurrent, updated_at = now()`,
      [
        userId,
        c.resources?.agentId ?? null,
        c.resources?.agentVersion ?? null,
        c.resources?.environmentId ?? null,
        c.model,
        c.networking,
        JSON.stringify(c.allowedHosts),
        c.budgetCents,
        c.maxConcurrent,
      ],
    );
  }

  forgetClient(userId: string): void {
    this.providers.delete(userId);
  }

  /** Decrypts the user's key and returns a provider client (cached briefly in memory only). */
  private async providerFor(
    userId: string,
    required = true,
  ): Promise<ManagedCloudSessionProvider | null> {
    const cached = this.providers.get(userId);
    if (cached && cached.expires > Date.now()) return cached.provider;
    const fail = (code: string, message: string) => {
      if (!required) return null;
      throw new HttpError(409, code, message);
    };
    if (!this.o.secretBox)
      return fail('storage_unavailable', 'Cloud credentials are not configured on this server');
    const { rows } = await this.o.db.query<{
      ciphertext: Buffer;
      iv: Buffer;
      auth_tag: Buffer;
      key_version: number;
    }>(
      `SELECT ciphertext, iv, auth_tag, key_version FROM provider_credentials WHERE user_id = $1 AND provider = 'anthropic'`,
      [userId],
    );
    const r = rows[0];
    if (!r) return fail('credential_missing', 'Add an Anthropic API key for cloud sessions first');
    const apiKey = this.o.secretBox.open(
      { ciphertext: r.ciphertext, iv: r.iv, authTag: r.auth_tag, keyVersion: r.key_version },
      `anthropic:${userId}`,
    );
    const provider = this.o.providerFactory(apiKey);
    this.providers.set(userId, { provider, expires: Date.now() + 10 * 60_000 });
    return provider;
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  async create(
    userId: string,
    input: { prompt: string; title?: string; idempotencyKey: string },
  ): Promise<string> {
    if (!this.o.enabled)
      throw new HttpError(404, 'cloud_disabled', 'Cloud sessions are disabled on this server');
    const sessionId = deterministicId(userId, input.idempotencyKey);
    const existing = await this.o.db.query<{ id: string }>(
      `SELECT id FROM sessions WHERE user_id = $1 AND kind = 'cloud' AND id = $2`,
      [userId, sessionId],
    );
    if (existing.rows[0]) return existing.rows[0].id;

    const provider = (await this.providerFor(userId))!;
    const cfg = await this.getConfig(userId);
    const active = await this.o.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM sessions WHERE user_id = $1 AND kind = 'cloud' AND status NOT IN ('completed', 'failed', 'killed', 'lost')`,
      [userId],
    );
    if (Number(active.rows[0]!.n) >= cfg.maxConcurrent) {
      throw conflict(
        'quota_exceeded',
        `You can run at most ${cfg.maxConcurrent} cloud sessions at once. End one first.`,
      );
    }
    let resources = cfg.resources;
    if (!resources) {
      resources = await this.call(() =>
        provider.ensureResources(
          { model: cfg.model, networking: cfg.networking, allowedHosts: cfg.allowedHosts },
          {},
        ),
      );
      await this.saveConfig(userId, { ...cfg, resources });
    }
    const title = (input.title ?? input.prompt).slice(0, 120);
    await this.o.db.query(
      `INSERT INTO sessions (id, user_id, kind, mode, title, status, environment_id) VALUES ($1, $2, 'cloud', 'managed_agent', $3, 'starting', $4)`,
      [sessionId, userId, title, resources.environmentId],
    );
    this.o.relay.registerRoute(sessionId, { userId, deviceId: null, kind: 'cloud' });
    try {
      const ps = await this.call(() =>
        provider.createSession({
          resources: resources!,
          title,
          budgetCents: cfg.budgetCents,
          prompt: input.prompt,
        }),
      );
      await this.o.db.query(
        `UPDATE sessions SET provider_session_id = $2, status = 'running', updated_at = now() WHERE id = $1`,
        [sessionId, ps.id],
      );
      await audit(this.o.db, {
        action: 'cloud.session_create',
        userId,
        metadata: { sessionId, providerSessionId: ps.id, budgetCents: cfg.budgetCents },
      });
      this.watch({ sessionId, userId, providerSessionId: ps.id, status: 'running', lastSeq: 0 });
    } catch (err) {
      await this.o.db.query(
        `UPDATE sessions SET status = 'failed', ended_at = now(), updated_at = now() WHERE id = $1`,
        [sessionId],
      );
      throw err;
    }
    return sessionId;
  }

  async sendMessage(s: SessionRow, text: string): Promise<void> {
    const provider = (await this.providerFor(s.user_id))!;
    await this.call(() => provider.sendMessage(this.providerId(s), text));
    this.ensureWatching(s);
  }

  async interrupt(s: SessionRow): Promise<void> {
    const provider = (await this.providerFor(s.user_id))!;
    await this.call(() => provider.interrupt(this.providerId(s)));
  }

  async confirmTool(s: SessionRow, toolUseId: string, allow: boolean): Promise<void> {
    const provider = (await this.providerFor(s.user_id))!;
    await this.call(() => provider.confirmTool(this.providerId(s), toolUseId, allow));
  }

  /**
   * Ends a session: interrupt, wait for it to leave `running`, then archive it at
   * Anthropic (read-only; history preserved, container released).
   */
  async end(s: SessionRow, reason: 'user' | 'timeout' | 'account_deleted'): Promise<void> {
    if (isTerminalStatus(s.status) && reason === 'user') return;
    const finalStatus: SessionStatus = reason === 'user' ? 'completed' : 'killed';
    if (s.provider_session_id) {
      const provider = await this.providerFor(s.user_id, reason === 'user');
      if (provider) {
        const id = s.provider_session_id;
        await provider.interrupt(id).catch(() => undefined);
        for (let i = 0; i < 20; i++) {
          const cur = await provider.retrieveSession(id).catch(() => null);
          if (!cur || cur.status !== 'running') break;
          await new Promise((r) => setTimeout(r, 500));
        }
        await provider
          .archive(id)
          .catch((err: unknown) => this.o.log.warn({ err, sessionId: s.id }, 'archive failed'));
      }
    }
    const w = this.watches.get(s.id);
    if (w) {
      w.stopped = true;
      w.abort.abort();
      this.emit(w, {
        kind: 'status',
        status: finalStatus,
        message:
          reason === 'timeout' ? 'Ended: maximum session duration reached.' : 'Session ended.',
      });
      this.watches.delete(s.id);
    } else {
      await this.o.relay.markStatus(s.id, s.user_id, finalStatus);
    }
    await this.o.db.query(
      `UPDATE sessions SET status = $2, ended_at = COALESCE(ended_at, now()), updated_at = now() WHERE id = $1`,
      [s.id, finalStatus],
    );
    await audit(this.o.db, {
      action: 'cloud.session_end',
      userId: s.user_id,
      metadata: { sessionId: s.id, reason },
    });
  }

  async endAllForUser(userId: string, reason: 'account_deleted'): Promise<void> {
    const { rows } = await this.o.db.query<SessionRow>(
      `SELECT * FROM sessions WHERE user_id = $1 AND kind = 'cloud' AND status NOT IN ('completed', 'failed', 'killed', 'lost')`,
      [userId],
    );
    for (const s of rows) await this.end(s, reason).catch(() => undefined);
  }

  private providerId(s: SessionRow): string {
    if (s.kind !== 'cloud' || !s.provider_session_id) throw notFound('Cloud session not found');
    return s.provider_session_id;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProviderError) {
        const status =
          err.code === 'invalid_api_key'
            ? 400
            : err.code === 'rate_limited'
              ? 429
              : err.code === 'not_available'
                ? 404
                : 502;
        throw new HttpError(status, err.code, err.message);
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Event streaming
  // ---------------------------------------------------------------------------

  private ensureWatching(s: SessionRow): void {
    if (!this.watches.has(s.id) && s.provider_session_id) {
      this.watch({
        sessionId: s.id,
        userId: s.user_id,
        providerSessionId: s.provider_session_id,
        status: s.status,
        lastSeq: 0,
      });
    }
  }

  private emit(w: Watch, event: SequencedEvent['event']): void {
    const ev: SequencedEvent = {
      sessionId: w.sessionId,
      seq: ++w.seq,
      ts: new Date().toISOString(),
      event,
    };
    w.events.push(ev);
    if (w.events.length > 5000) w.events.shift();
    void this.o.relay
      .publish(ev, { userId: w.userId, deviceId: null, kind: 'cloud' })
      .catch((err: unknown) => this.o.log.error({ err }, 'publish failed'));
  }

  private ingest(w: Watch, m: MappedProviderEvent): void {
    if (w.seen.has(m.providerEventId)) return;
    w.seen.add(m.providerEventId);
    for (const e of m.events) this.emit(w, e);
    if (m.status) w.status = m.status;
  }

  /** Streams provider events into the relay, reconnecting with backoff (stream-first, then history, de-duplicated). */
  watch(init: {
    sessionId: string;
    userId: string;
    providerSessionId: string;
    status: SessionStatus;
    lastSeq: number;
  }): void {
    if (this.watches.has(init.sessionId)) return;
    const w: Watch = {
      ...init,
      abort: new AbortController(),
      seen: new Set(),
      events: [],
      seq: 0,
      stopped: false,
    };
    this.watches.set(init.sessionId, w);
    void (async () => {
      for (let attempt = 0; !w.stopped; attempt++) {
        try {
          const provider = await this.providerFor(w.userId, false);
          if (!provider) break;
          w.abort = new AbortController();
          const it = provider.stream(w.providerSessionId, w.abort.signal)[Symbol.asyncIterator]();
          const first = it.next(); // open the live stream before reading history
          for (const m of await provider.history(w.providerSessionId)) this.ingest(w, m);
          for (let r = await first; !r.done; r = await it.next()) {
            attempt = 0;
            this.ingest(w, r.value);
            if (w.status === 'completed') w.stopped = true;
          }
        } catch (err) {
          if (w.stopped) break;
          this.o.log.warn(
            { err, sessionId: w.sessionId },
            'cloud event stream error; reconnecting',
          );
        }
        if (w.stopped) break;
        await new Promise((r) =>
          setTimeout(r, backoffDelay(attempt, { baseMs: 1000, maxMs: 30_000 })),
        );
      }
      if (this.watches.get(w.sessionId) === w && w.status === 'completed')
        this.watches.delete(w.sessionId);
    })();
  }

  /** Serves replay requests for cloud sessions from the watcher's full history. */
  async replay(sessionId: string, afterSeq: number, conn: ClientConn): Promise<void> {
    const w = this.watches.get(sessionId);
    if (w) {
      const first = w.events[0];
      if (first && first.seq > afterSeq + 1)
        this.o.relay.sendToClient(conn, {
          type: 'replay.gap',
          sessionId,
          resumeFromSeq: first.seq,
        });
      for (const ev of w.events)
        if (ev.seq > afterSeq) this.o.relay.sendToClient(conn, { type: 'event', ...ev });
      return;
    }
    // Not being watched (e.g. after a server restart): rebuild from provider history.
    const { rows } = await this.o.db.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [
      sessionId,
    ]);
    const s = rows[0];
    if (!s?.provider_session_id) return;
    if (!isTerminalStatus(s.status)) {
      this.ensureWatching(s);
      return; // the watcher publishes history to subscribers as it ingests it
    }
    const provider = await this.providerFor(s.user_id, false);
    if (!provider) return;
    const history = await provider.history(s.provider_session_id).catch(() => []);
    let seq = 0;
    for (const m of history) {
      for (const event of m.events) {
        seq++;
        if (seq > afterSeq)
          this.o.relay.sendToClient(conn, {
            type: 'event',
            sessionId,
            seq,
            ts: new Date().toISOString(),
            event,
          });
      }
    }
  }

  /** Re-attaches watchers after a restart and enforces the max session duration. */
  startSweeper(intervalMs = 60_000): void {
    const tick = async () => {
      const { rows } = await this.o.db.query<SessionRow>(
        `SELECT * FROM sessions WHERE kind = 'cloud' AND status NOT IN ('completed', 'failed', 'killed', 'lost') AND provider_session_id IS NOT NULL`,
      );
      for (const s of rows) {
        const ageMin = (Date.now() - s.created_at.getTime()) / 60_000;
        if (ageMin > this.o.defaults.maxSessionMinutes) {
          await this.end(s, 'timeout').catch((err: unknown) =>
            this.o.log.warn({ err }, 'cleanup failed'),
          );
          await audit(this.o.db, {
            action: 'cloud.cleanup',
            userId: s.user_id,
            metadata: { sessionId: s.id, ageMinutes: Math.round(ageMin) },
          });
        } else {
          this.ensureWatching(s);
        }
      }
    };
    void tick().catch(() => undefined);
    this.sweeper = setInterval(
      () => void tick().catch((err: unknown) => this.o.log.error({ err }, 'sweeper failed')),
      intervalMs,
    );
  }

  shutdown(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const w of this.watches.values()) {
      w.stopped = true;
      w.abort.abort();
    }
    this.watches.clear();
  }
}
