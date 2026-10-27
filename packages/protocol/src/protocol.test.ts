import { describe, expect, it } from 'vitest';
import {
  agentCommandSchema,
  agentToServerSchema,
  clientToServerSchema,
  pairingCodeSchema,
  parseFrame,
  LIMITS,
} from './index.js';

const sid = '6f1c1f9e-4a36-4c55-9d32-5b0b1d2c3a4f';

describe('protocol schemas', () => {
  it('accepts a valid session.start', () => {
    const r = agentCommandSchema.safeParse({
      op: 'session.start',
      sessionId: sid,
      workspaceId: 'ws_1',
      mode: 'command',
      presetId: 'git-status',
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.op === 'session.start') expect(r.data.cols).toBe(80);
  });
  it('rejects unknown ops and extra-large input', () => {
    expect(agentCommandSchema.safeParse({ op: 'exec', sessionId: sid }).success).toBe(false);
    expect(
      agentCommandSchema.safeParse({
        op: 'session.input',
        sessionId: sid,
        data: 'x'.repeat(LIMITS.maxInputChars + 1),
      }).success,
    ).toBe(false);
  });
  it('rejects workspace ids that look like paths', () => {
    expect(agentCommandSchema.safeParse({ op: 'git.status', workspaceId: '../etc' }).success).toBe(
      false,
    );
  });
  it('only allows low-risk ops over the client websocket', () => {
    const start = {
      type: 'command',
      commandId: sid,
      command: { op: 'session.start', sessionId: sid, workspaceId: 'w', mode: 'shell' },
    };
    expect(clientToServerSchema.safeParse(start).success).toBe(false);
    const input = {
      type: 'command',
      commandId: sid,
      command: { op: 'session.input', sessionId: sid, data: 'ls\r' },
    };
    expect(clientToServerSchema.safeParse(input).success).toBe(true);
  });
  it('validates sequenced agent events', () => {
    const ev = {
      type: 'agent.event',
      sessionId: sid,
      seq: 1,
      ts: new Date().toISOString(),
      event: { kind: 'output', stream: 'pty', data: 'hi' },
    };
    expect(agentToServerSchema.safeParse(ev).success).toBe(true);
    expect(agentToServerSchema.safeParse({ ...ev, seq: 0 }).success).toBe(false);
  });
  it('normalises pairing codes', () => {
    expect(pairingCodeSchema.parse('abcd-efgh')).toBe('ABCDEFGH');
    expect(pairingCodeSchema.safeParse('ABCD-EFG0').success).toBe(false); // 0 is not in the alphabet
  });
  it('parseFrame reports invalid json', () => {
    expect(parseFrame(clientToServerSchema, '{nope')).toEqual({ ok: false, error: 'invalid_json' });
  });
});
