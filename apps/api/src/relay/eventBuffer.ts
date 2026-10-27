import type { SequencedEvent } from '@codebridge/protocol';

/**
 * Bounded in-memory replay buffer for session events, so a phone that briefly
 * loses connectivity can catch up without a round trip to the Mac.
 *
 * Terminal output is never written to the database; this buffer is the only
 * server-side copy and is lost on restart (the Mac keeps its own buffer).
 */
export class EventBuffer {
  private readonly sessions = new Map<string, { events: SequencedEvent[]; bytes: number }>();

  constructor(
    private readonly maxEventsPerSession = 2000,
    private readonly maxBytesPerSession = 1_000_000,
    private readonly maxSessions = 500,
  ) {}

  push(ev: SequencedEvent): void {
    let entry = this.sessions.get(ev.sessionId);
    if (!entry) {
      if (this.sessions.size >= this.maxSessions) {
        // Evict the least recently created session buffer (Map preserves insertion order).
        const oldest = this.sessions.keys().next().value;
        if (oldest) this.sessions.delete(oldest);
      }
      entry = { events: [], bytes: 0 };
      this.sessions.set(ev.sessionId, entry);
    }
    const last = entry.events[entry.events.length - 1];
    if (last && ev.seq <= last.seq) return; // duplicate or out-of-order replay; already have it
    const size = estimateSize(ev);
    entry.events.push(ev);
    entry.bytes += size;
    while (
      entry.events.length > this.maxEventsPerSession ||
      entry.bytes > this.maxBytesPerSession
    ) {
      const dropped = entry.events.shift();
      if (!dropped) break;
      entry.bytes -= estimateSize(dropped);
    }
  }

  /**
   * Events with seq > afterSeq. `complete` is false when the buffer no longer
   * holds the event right after `afterSeq` and the caller must ask the source.
   */
  since(
    sessionId: string,
    afterSeq: number,
  ): { events: SequencedEvent[]; complete: boolean; lastSeq: number } {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.events.length === 0) return { events: [], complete: false, lastSeq: 0 };
    const first = entry.events[0]!;
    const lastSeq = entry.events[entry.events.length - 1]!.seq;
    const events = entry.events.filter((e) => e.seq > afterSeq);
    return { events, complete: first.seq <= afterSeq + 1, lastSeq };
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

function estimateSize(ev: SequencedEvent): number {
  const e = ev.event;
  if (e.kind === 'output') return e.data.length + 64;
  if (e.kind === 'agent.text') return e.delta.length + 64;
  return 256;
}
