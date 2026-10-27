import type { SequencedEvent, SessionEvent } from '@codebridge/protocol';
import { SessionState } from './sessionState';

const ev = (seq: number, event: SessionEvent): SequencedEvent => ({
  sessionId: '6f1c1f9e-4a36-4c55-9d32-5b0b1d2c3a4f',
  seq,
  ts: '',
  event,
});
const out = (seq: number, data: string) => ev(seq, { kind: 'output', stream: 'pty', data });

describe('SessionState', () => {
  it('applies events in order and ignores duplicates', () => {
    const s = new SessionState();
    expect(s.apply(out(1, 'a'))).toBe('applied');
    expect(s.apply(out(2, 'b'))).toBe('applied');
    expect(s.apply(out(2, 'b'))).toBe('duplicate');
    expect(s.apply(out(1, 'a'))).toBe('duplicate');
    expect(s.terminal.toPlainText()).toBe('ab');
  });

  it('buffers out-of-order events and drains them once the gap fills', () => {
    const s = new SessionState();
    s.apply(out(1, '1'));
    expect(s.apply(out(3, '3'))).toBe('gap');
    expect(s.terminal.toPlainText()).toBe('1');
    s.apply(out(2, '2'));
    expect(s.terminal.toPlainText()).toBe('123');
    expect(s.lastSeq).toBe(3);
  });

  it('skips ahead when the server reports a permanent gap', () => {
    const s = new SessionState();
    s.apply(out(10, 'late'));
    s.resumeFrom(10);
    expect(s.lastSeq).toBe(10);
    expect(s.terminal.toPlainText()).toContain('earlier output is no longer available');
    expect(s.terminal.toPlainText()).toContain('late');
  });

  it('builds a chat transcript with streaming text, tools and errors', () => {
    const s = new SessionState();
    s.apply(ev(1, { kind: 'user.prompt', text: 'fix it' }));
    s.apply(ev(2, { kind: 'agent.text', delta: 'Look' }));
    s.apply(ev(3, { kind: 'agent.text', delta: 'ing…' }));
    s.apply(
      ev(4, {
        kind: 'agent.tool_call',
        toolUseId: 't1',
        name: 'read_file',
        summary: '{"path":"a"}',
      }),
    );
    s.apply(ev(5, { kind: 'agent.tool_result', toolUseId: 't1', ok: true, summary: 'Read a' }));
    s.apply(ev(6, { kind: 'error', code: 'rate_limited', message: 'slow down', retryable: true }));
    expect(s.chat.map((c) => c.type)).toEqual(['user', 'assistant', 'tool', 'error']);
    expect(s.chat[1]).toMatchObject({ text: 'Looking…', streaming: false });
    expect(s.chat[2]).toMatchObject({ result: { ok: true } });
  });

  it('tracks pending approvals and status', () => {
    const s = new SessionState();
    s.apply(
      ev(1, {
        kind: 'approval.request',
        approvalId: 'a1',
        toolName: 'write_file',
        title: 'Create x',
        detail: '…',
        risk: 'medium',
        expiresAt: '',
      }),
    );
    s.apply(ev(2, { kind: 'status', status: 'waiting' }));
    expect(s.approvals.size).toBe(1);
    expect(s.status).toBe('waiting');
    s.apply(ev(3, { kind: 'approval.resolved', approvalId: 'a1', decision: 'approved' }));
    s.apply(ev(4, { kind: 'status', status: 'completed', exitCode: 0 }));
    expect(s.approvals.size).toBe(0);
    expect(s.exitCode).toBe(0);
  });
});
