import { RealtimeClient } from './socket';

jest.mock('../lib/uuid', () => ({ uuid: () => '00000000-0000-4000-8000-000000000000' }));

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const flush = () => new Promise((r) => setTimeout(r, 5));

describe('RealtimeClient', () => {
  beforeEach(() => {
    FakeWS.instances = [];
  });

  it('authenticates with the first frame and re-subscribes from the last seen seq after reconnecting', async () => {
    const rt = new RealtimeClient({
      url: 'ws://x',
      getToken: async () => 'cba_token',
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
      random: () => 0,
    });
    const statuses: string[] = [];
    rt.onStatus((s) => statuses.push(s));
    rt.start();
    await flush();
    const ws1 = FakeWS.instances[0]!;
    ws1.open();
    expect(ws1.sent[0]).toEqual({ type: 'auth', token: 'cba_token' });
    ws1.receive({ type: 'auth.ok', userId: '6f1c1f9e-4a36-4c55-9d32-5b0b1d2c3a4f' });
    let last = 0;
    rt.subscribe('6f1c1f9e-4a36-4c55-9d32-5b0b1d2c3a4f', () => last);
    expect(ws1.sent[1]).toMatchObject({ type: 'subscribe', afterSeq: 0 });
    last = 42;
    ws1.drop();
    expect(rt.status).toBe('offline');
    await flush();
    const ws2 = FakeWS.instances[1]!;
    ws2.open();
    ws2.receive({ type: 'auth.ok', userId: '6f1c1f9e-4a36-4c55-9d32-5b0b1d2c3a4f' });
    expect(ws2.sent).toEqual([
      { type: 'auth', token: 'cba_token' },
      { type: 'subscribe', sessionId: '6f1c1f9e-4a36-4c55-9d32-5b0b1d2c3a4f', afterSeq: 42 },
    ]);
    expect(statuses).toEqual(
      expect.arrayContaining(['connecting', 'connected', 'offline', 'reconnecting']),
    );
    rt.stop();
  });

  it('reports unauthorized when there is no token', async () => {
    const rt = new RealtimeClient({
      url: 'ws://x',
      getToken: async () => null,
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });
    rt.start();
    await flush();
    await flush();
    expect(rt.status).toBe('unauthorized');
    expect(FakeWS.instances).toHaveLength(0);
  });

  it('fails commands fast while offline', async () => {
    const rt = new RealtimeClient({
      url: 'ws://x',
      getToken: async () => 'cba_token',
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });
    const r = await rt.command({
      op: 'session.input',
      sessionId: '6f1c1f9e-4a36-4c55-9d32-5b0b1d2c3a4f',
      data: 'x',
    });
    expect(r).toEqual({ ok: false, error: { code: 'offline', message: 'Not connected' } });
  });
});
