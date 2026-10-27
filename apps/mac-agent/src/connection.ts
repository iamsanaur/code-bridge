import WebSocket from 'ws';
import { backoffDelay } from '@codebridge/shared';
import {
  LIMITS,
  parseFrame,
  serverToAgentSchema,
  type AgentToServer,
  type SequencedEvent,
  type ServerToAgent,
} from '@codebridge/protocol';
import { assertSecureUrl } from './http.js';
import type { Logger } from './log.js';

export type ConnectionState =
  'connecting' | 'connected' | 'disconnected' | 'revoked' | 'unauthorized' | 'stopped';

export interface ConnectionOptions {
  serverUrl: string;
  getSecret: () => Promise<string | null>;
  buildHello: () => Extract<AgentToServer, { type: 'agent.hello' }>;
  onCommand: (
    msg: Extract<ServerToAgent, { type: 'server.command' }>,
  ) => Promise<Extract<AgentToServer, { type: 'agent.ack' }>>;
  onServerHello: (serverTime: number) => void;
  /** Events to re-send after a reconnect (seq > last delivered, with some overlap). */
  pendingEvents: (delivered: Map<string, number>) => SequencedEvent[];
  onRevoked: (reason: string) => void;
  onStateChange?: (s: ConnectionState) => void;
  log: Logger;
}

/**
 * Outbound, authenticated WebSocket to the relay with exponential backoff,
 * heartbeats, and at-least-once event delivery (receivers de-duplicate by seq).
 */
export class RelayConnection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private lastPong = 0;
  private readonly delivered = new Map<string, number>();
  state: ConnectionState = 'disconnected';

  constructor(private readonly o: ConnectionOptions) {}

  private setState(s: ConnectionState) {
    this.state = s;
    this.o.onStateChange?.(s);
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
    this.ws?.close(1000, 'agent stopping');
    if (this.state !== 'revoked' && this.state !== 'unauthorized') this.setState('stopped');
  }

  private wsUrl(): string {
    const u = assertSecureUrl(this.o.serverUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/v1/agent/ws';
    return u.toString();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const secret = await this.o.getSecret();
    if (!secret) {
      this.o.log.error('no device credential found; run `codebridge-agent pair`');
      this.setState('unauthorized');
      return;
    }
    this.setState('connecting');
    const ws = new WebSocket(this.wsUrl(), {
      headers: { authorization: `Bearer ${secret}` },
      maxPayload: LIMITS.maxFrameBytes,
      handshakeTimeout: 15_000,
    });
    this.ws = ws;

    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401) {
        this.o.log.error(
          'the server rejected this device credential (revoked or unknown). Run `codebridge-agent pair` again.',
        );
        this.stopped = true;
        this.setState('unauthorized');
      }
      ws.terminate();
    });
    ws.on('open', () => {
      this.attempt = 0;
      this.lastPong = Date.now();
      this.setState('connected');
      this.o.log.info('connected to relay');
      this.send(this.o.buildHello());
      for (const ev of this.o.pendingEvents(this.delivered)) this.sendEvent(ev);
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastPong > LIMITS.heartbeatMs * 3) {
          this.o.log.warn('heartbeat timeout; reconnecting');
          ws.terminate();
          return;
        }
        this.send({ type: 'agent.ping', ts: Date.now() });
      }, LIMITS.heartbeatMs);
    });
    ws.on('message', (raw) => {
      const parsed = parseFrame(serverToAgentSchema, raw);
      if (!parsed.ok) {
        this.o.log.warn('invalid frame from relay', { error: parsed.error });
        return;
      }
      const msg = parsed.value;
      switch (msg.type) {
        case 'server.hello':
          this.o.onServerHello(msg.serverTime);
          return;
        case 'server.pong':
          this.lastPong = Date.now();
          return;
        case 'server.revoked':
          this.stopped = true;
          this.setState('revoked');
          this.o.onRevoked(msg.reason);
          return;
        case 'server.command':
          void this.o
            .onCommand(msg)
            .then((ack) => this.send(ack))
            .catch((err: unknown) =>
              this.o.log.error('command handler crashed', { error: String(err) }),
            );
          return;
      }
    });
    ws.on('close', (code) => {
      this.clearHeartbeat();
      if (this.ws === ws) this.ws = null;
      if (code === 4401 && this.state !== 'revoked') {
        this.stopped = true;
        this.setState('unauthorized');
      }
      if (this.stopped) return;
      this.setState('disconnected');
      const delay = backoffDelay(this.attempt++, { baseMs: 1000, maxMs: 30_000 });
      this.o.log.info('disconnected; reconnecting', { code, delayMs: delay });
      setTimeout(() => void this.connect(), delay).unref?.();
    });
    ws.on('error', (err) => this.o.log.warn('relay connection error', { error: err.message }));
  }

  private clearHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  send(msg: AgentToServer, cb?: (err?: Error) => void): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg), cb);
    return true;
  }

  /** Sends an event if connected; otherwise it stays in the session ring for re-send. */
  sendEvent(ev: SequencedEvent): void {
    this.send({ type: 'agent.event', ...ev }, (err) => {
      if (!err)
        this.delivered.set(ev.sessionId, Math.max(this.delivered.get(ev.sessionId) ?? 0, ev.seq));
    });
  }
}
