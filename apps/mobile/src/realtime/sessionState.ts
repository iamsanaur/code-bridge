import { TerminalBuffer } from '@codebridge/shared';
import type { SequencedEvent, SessionEvent, SessionStatus, Usage } from '@codebridge/protocol';

export type ChatItem =
  | { id: string; type: 'user'; text: string }
  | { id: string; type: 'assistant'; text: string; streaming: boolean }
  | {
      id: string;
      type: 'tool';
      toolUseId: string;
      name: string;
      summary: string;
      result?: { ok: boolean; summary: string };
    }
  | { id: string; type: 'error'; code: string; message: string; retryable: boolean }
  | { id: string; type: 'notice'; text: string };

export interface PendingApproval {
  approvalId: string;
  toolName: string;
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
  expiresAt: string;
}

/**
 * Client-side model of one session's event stream. Events are applied strictly
 * in `seq` order: duplicates are ignored and gaps are reported so the caller can
 * re-subscribe from the last contiguous event.
 */
export class SessionState {
  lastSeq = 0;
  status: SessionStatus | null = null;
  statusMessage: string | null = null;
  exitCode: number | null = null;
  usage: Usage | null = null;
  readonly terminal = new TerminalBuffer(5000);
  chat: ChatItem[] = [];
  approvals = new Map<string, PendingApproval>();
  /** Set when earlier events are permanently unavailable. */
  gapBefore: number | null = null;
  private pending = new Map<number, SequencedEvent>();
  version = 0;

  /** Returns 'gap' if an event arrived ahead of a missing one. */
  apply(ev: SequencedEvent): 'applied' | 'duplicate' | 'gap' {
    if (ev.seq <= this.lastSeq) return 'duplicate';
    if (ev.seq > this.lastSeq + 1) {
      this.pending.set(ev.seq, ev);
      if (this.pending.size > 2000) this.pending.clear();
      return 'gap';
    }
    this.applyOne(ev);
    // Drain any buffered events that are now contiguous.
    for (
      let next = this.pending.get(this.lastSeq + 1);
      next;
      next = this.pending.get(this.lastSeq + 1)
    ) {
      this.pending.delete(next.seq);
      this.applyOne(next);
    }
    return 'applied';
  }

  /** The server says events before `seq` are gone: skip ahead. */
  resumeFrom(seq: number): void {
    if (seq - 1 > this.lastSeq) {
      this.gapBefore = seq;
      this.lastSeq = seq - 1;
      this.terminal.write('\r\n\x1b[33m[earlier output is no longer available]\x1b[0m\r\n');
      this.version++;
      for (
        let next = this.pending.get(this.lastSeq + 1);
        next;
        next = this.pending.get(this.lastSeq + 1)
      ) {
        this.pending.delete(next.seq);
        this.applyOne(next);
      }
    }
  }

  private applyOne(ev: SequencedEvent): void {
    this.lastSeq = ev.seq;
    this.version++;
    this.reduce(ev.seq, ev.event);
  }

  private reduce(seq: number, e: SessionEvent): void {
    const id = String(seq);
    switch (e.kind) {
      case 'status':
        this.status = e.status;
        this.statusMessage = e.message ?? null;
        if (e.exitCode !== undefined && e.exitCode !== null) this.exitCode = e.exitCode;
        if (e.status !== 'running' && e.status !== 'starting') this.closeStreaming();
        return;
      case 'output':
        this.terminal.write(e.data);
        return;
      case 'user.prompt':
        this.closeStreaming();
        this.chat.push({ id, type: 'user', text: e.text });
        return;
      case 'agent.text': {
        const last = this.chat[this.chat.length - 1];
        if (last?.type === 'assistant' && last.streaming) last.text += e.delta;
        else this.chat.push({ id, type: 'assistant', text: e.delta, streaming: true });
        return;
      }
      case 'agent.turn_end':
        this.closeStreaming();
        return;
      case 'agent.tool_call':
        this.closeStreaming();
        this.chat.push({
          id,
          type: 'tool',
          toolUseId: e.toolUseId,
          name: e.name,
          summary: e.summary,
        });
        return;
      case 'agent.tool_result': {
        const item = [...this.chat]
          .reverse()
          .find((c) => c.type === 'tool' && c.toolUseId === e.toolUseId);
        if (item && item.type === 'tool') item.result = { ok: e.ok, summary: e.summary };
        return;
      }
      case 'approval.request':
        this.approvals.set(e.approvalId, { ...e });
        return;
      case 'approval.resolved':
        this.approvals.delete(e.approvalId);
        if (e.decision !== 'approved')
          this.chat.push({ id, type: 'notice', text: `Approval ${e.decision}` });
        return;
      case 'usage':
        this.usage = e.usage;
        return;
      case 'error':
        this.closeStreaming();
        this.chat.push({
          id,
          type: 'error',
          code: e.code,
          message: e.message,
          retryable: e.retryable,
        });
        this.terminal.write(`\r\n\x1b[31m[${e.code}] ${e.message}\x1b[0m\r\n`);
        return;
    }
  }

  private closeStreaming(): void {
    const last = this.chat[this.chat.length - 1];
    if (last?.type === 'assistant') last.streaming = false;
  }
}
