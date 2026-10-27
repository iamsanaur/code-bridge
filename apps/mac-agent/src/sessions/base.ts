import { randomUUID } from 'node:crypto';
import {
  LIMITS,
  type LocalMode,
  type SequencedEvent,
  type SessionEvent,
  type SessionStatus,
} from '@codebridge/protocol';
import { isTerminalStatus } from '@codebridge/protocol';
import type { Workspace } from '../config.js';

export type EventSink = (ev: SequencedEvent) => void;

export class SessionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const RING_MAX_EVENTS = 5000;
const RING_MAX_BYTES = 4_000_000;

/**
 * Common session machinery: per-session monotonic sequence numbers and a bounded
 * replay ring so the relay/phone can recover after a disconnect.
 */
export abstract class BaseSession {
  status: SessionStatus = 'starting';
  readonly createdAt = Date.now();
  private seq = 0;
  private ring: SequencedEvent[] = [];
  private ringBytes = 0;
  protected readonly approvals: ApprovalBroker;

  constructor(
    readonly id: string,
    readonly workspace: Workspace,
    readonly mode: LocalMode,
    private readonly sink: EventSink,
  ) {
    this.approvals = new ApprovalBroker(this);
  }

  get lastSeq(): number {
    return this.seq;
  }

  get isFinished(): boolean {
    return isTerminalStatus(this.status);
  }

  emit(event: SessionEvent): void {
    const ev: SequencedEvent = {
      sessionId: this.id,
      seq: ++this.seq,
      ts: new Date().toISOString(),
      event,
    };
    const size =
      event.kind === 'output'
        ? event.data.length
        : event.kind === 'agent.text'
          ? event.delta.length
          : 200;
    this.ring.push(ev);
    this.ringBytes += size;
    while (this.ring.length > RING_MAX_EVENTS || this.ringBytes > RING_MAX_BYTES) {
      const dropped = this.ring.shift()!;
      this.ringBytes -= dropped.event.kind === 'output' ? dropped.event.data.length : 200;
    }
    this.sink(ev);
  }

  /** Emits text in chunks that respect the protocol's frame limits. */
  emitOutput(stream: 'pty' | 'stdout' | 'stderr' | 'system', data: string): void {
    for (let i = 0; i < data.length; i += LIMITS.maxOutputChunkChars) {
      this.emit({ kind: 'output', stream, data: data.slice(i, i + LIMITS.maxOutputChunkChars) });
    }
  }

  setStatus(
    status: SessionStatus,
    extra: { exitCode?: number | null; signal?: string | null; message?: string } = {},
  ): void {
    if (this.isFinished) return; // terminal states are final
    this.status = status;
    this.emit({ kind: 'status', status, ...extra });
  }

  replay(afterSeq: number): { events: SequencedEvent[]; oldestAvailableSeq: number } {
    const oldest = this.ring[0]?.seq ?? this.seq + 1;
    return { events: this.ring.filter((e) => e.seq > afterSeq), oldestAvailableSeq: oldest };
  }

  eventsSince(seq: number): SequencedEvent[] {
    return this.ring.filter((e) => e.seq > seq);
  }

  respondApproval(approvalId: string, decision: 'approve' | 'reject'): void {
    if (!this.approvals.respond(approvalId, decision)) {
      throw new SessionError('approval_not_found', 'That approval request is no longer pending');
    }
  }

  input(_data: string): void {
    throw new SessionError('unsupported', 'This session does not accept terminal input');
  }
  resize(_cols: number, _rows: number): void {
    // optional
  }
  prompt(_text: string): void {
    throw new SessionError('unsupported', 'This session does not accept prompts');
  }
  abstract signal(kind: 'interrupt' | 'terminate'): void;
  abstract start(): Promise<void>;
  /** Called on revocation/shutdown: stop everything immediately. */
  abstract dispose(): void;
}

export type ApprovalDecision = 'approved' | 'rejected' | 'expired' | 'cancelled';

/**
 * Pauses tool execution until the phone user approves or rejects, or the request
 * times out (treated as rejection). Only the session owner can respond, because
 * only the owner's commands are relayed to this Mac.
 */
export class ApprovalBroker {
  private readonly pending = new Map<
    string,
    { resolve: (d: ApprovalDecision) => void; timer: NodeJS.Timeout; prevStatus: SessionStatus }
  >();

  constructor(private readonly session: BaseSession) {}

  get size(): number {
    return this.pending.size;
  }

  request(
    req: { toolName: string; title: string; detail: string; risk: 'low' | 'medium' | 'high' },
    timeoutMs = 10 * 60_000,
  ): Promise<ApprovalDecision> {
    const approvalId = `apr_${randomUUID()}`;
    const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
    return new Promise<ApprovalDecision>((resolve) => {
      const prevStatus = this.session.status;
      const timer = setTimeout(() => this.finish(approvalId, 'expired'), timeoutMs);
      this.pending.set(approvalId, { resolve, timer, prevStatus });
      this.session.emit({
        kind: 'approval.request',
        approvalId,
        toolName: req.toolName,
        title: req.title.slice(0, 500),
        detail: req.detail.slice(0, 16_000),
        risk: req.risk,
        expiresAt,
      });
      this.session.setStatus('waiting', { message: 'Waiting for your approval' });
    });
  }

  respond(approvalId: string, decision: 'approve' | 'reject'): boolean {
    if (!this.pending.has(approvalId)) return false;
    this.finish(approvalId, decision === 'approve' ? 'approved' : 'rejected');
    return true;
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, 'cancelled');
  }

  private finish(approvalId: string, decision: ApprovalDecision): void {
    const p = this.pending.get(approvalId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(approvalId);
    this.session.emit({ kind: 'approval.resolved', approvalId, decision });
    if (this.pending.size === 0 && !this.session.isFinished) this.session.setStatus('running');
    p.resolve(decision);
  }
}
