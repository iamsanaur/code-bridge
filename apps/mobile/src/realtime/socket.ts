import { backoffDelay } from '@codebridge/shared';
import { serverToClientSchema, type ServerToClient } from '@codebridge/protocol';
import { uuid } from '../lib/uuid';

export type ConnectionStatus =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'unauthorized';

type Listener = (msg: ServerToClient) => void;

export interface RealtimeOptions {
  url: string;
  getToken: () => Promise<string | null>;
  WebSocketImpl?: typeof WebSocket;
  random?: () => number;
}

/**
 * Single multiplexed WebSocket to the relay. Authenticates with the first frame,
 * reconnects with jittered backoff, and re-subscribes every session from the last
 * event the app has applied, so reconnection never loses or duplicates output.
 */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>();
  /** sessionId -> function returning the last applied seq. */
  private readonly subscriptions = new Map<string, () => number>();
  private readonly ackWaiters = new Map<
    string,
    (ok: boolean, error?: { code: string; message: string }) => void
  >();
  status: ConnectionStatus = 'idle';

  constructor(private readonly o: RealtimeOptions) {}

  private setStatus(s: ConnectionStatus) {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  onStatus(cb: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  onMessage(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.ping) clearInterval(this.ping);
    this.ws?.close();
    this.ws = null;
    this.setStatus('idle');
  }

  /** Reconnect immediately (e.g. when the app returns to the foreground). */
  nudge(): void {
    if (this.stopped || this.status === 'connected' || this.status === 'connecting') return;
    if (this.timer) clearTimeout(this.timer);
    this.attempt = 0;
    this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const token = await this.o.getToken();
    if (!token) {
      this.setStatus('unauthorized');
      return;
    }
    const WS = this.o.WebSocketImpl ?? WebSocket;
    const ws = new WS(this.o.url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
    ws.onmessage = (e: MessageEvent) => {
      let parsed: ServerToClient;
      try {
        const r = serverToClientSchema.safeParse(JSON.parse(String(e.data)));
        if (!r.success) return;
        parsed = r.data;
      } catch {
        return;
      }
      if (parsed.type === 'auth.ok') {
        this.attempt = 0;
        this.setStatus('connected');
        for (const [sessionId, last] of this.subscriptions)
          this.send({ type: 'subscribe', sessionId, afterSeq: last() });
        if (this.ping) clearInterval(this.ping);
        this.ping = setInterval(() => this.send({ type: 'ping', ts: Date.now() }), 25_000);
      }
      if (parsed.type === 'command.ack') {
        this.ackWaiters.get(parsed.commandId)?.(parsed.ok, parsed.error);
        this.ackWaiters.delete(parsed.commandId);
      }
      for (const l of this.listeners) l(parsed);
    };
    ws.onclose = (e: CloseEvent) => {
      if (this.ping) clearInterval(this.ping);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      if (e.code === 4401) {
        // Token rejected: try once more with a refreshed token, then give up.
        if (this.attempt > 1) {
          this.setStatus('unauthorized');
          return;
        }
      }
      this.setStatus('offline');
      const delay = backoffDelay(this.attempt++, {
        baseMs: 500,
        maxMs: 15_000,
        random: this.o.random,
      });
      this.timer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => undefined; // onclose handles reconnection
  }

  private send(msg: unknown): boolean {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  subscribe(sessionId: string, lastSeq: () => number): () => void {
    this.subscriptions.set(sessionId, lastSeq);
    if (this.status === 'connected')
      this.send({ type: 'subscribe', sessionId, afterSeq: lastSeq() });
    return () => {
      this.subscriptions.delete(sessionId);
      this.send({ type: 'unsubscribe', sessionId });
    };
  }

  /** Re-requests events after `afterSeq` (used when a gap is detected). */
  resync(sessionId: string, afterSeq: number): void {
    this.send({ type: 'subscribe', sessionId, afterSeq });
  }

  /** Sends terminal input/resize/signal. Resolves with the Mac's ack. */
  command(
    command:
      | { op: 'session.input'; sessionId: string; data: string }
      | { op: 'session.resize'; sessionId: string; cols: number; rows: number }
      | { op: 'session.signal'; sessionId: string; signal: 'interrupt' | 'terminate' },
  ): Promise<{ ok: boolean; error?: { code: string; message: string } }> {
    const commandId = uuid();
    return new Promise((resolve) => {
      if (!this.send({ type: 'command', commandId, command })) {
        resolve({ ok: false, error: { code: 'offline', message: 'Not connected' } });
        return;
      }
      const t = setTimeout(() => {
        this.ackWaiters.delete(commandId);
        resolve({ ok: false, error: { code: 'timeout', message: 'No response from the Mac' } });
      }, 10_000);
      this.ackWaiters.set(commandId, (ok, error) => {
        clearTimeout(t);
        resolve({ ok, error });
      });
    });
  }
}
