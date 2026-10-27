import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  pairDevice,
  registerUser,
  sleep,
  startTestServer,
  WsClient,
  type TestCtx,
} from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await startTestServer();
});
afterAll(async () => ctx.close());

const hello = (sessions: unknown[] = []) => ({
  type: 'agent.hello',
  protocol: 1,
  agentVersion: 'test',
  hostname: 'test-mac.local',
  platform: 'darwin',
  arch: 'arm64',
  capabilities: {
    pty: true,
    anthropicKeyConfigured: false,
    claudeCodeAvailable: false,
    allowCustomCommands: false,
    allowInteractiveShell: false,
  },
  workspaces: [{ id: 'ws_aaaaaaaa', name: 'proj', displayPath: '~/proj', isGitRepo: true }],
  presets: [{ id: 'npm-test', label: 'npm test', argv: ['npm', 'test'] }],
  sessions,
});

/** A scripted fake Mac agent: acks every command and records what it received. */
async function fakeAgent(secret: string, opts: { autoAck?: boolean; sessions?: unknown[] } = {}) {
  const agent = await WsClient.connect(`${ctx.wsUrl}/v1/agent/ws`, {
    authorization: `Bearer ${secret}`,
  });
  await agent.waitFor((m) => m.type === 'server.hello');
  agent.send(hello(opts.sessions));
  if (opts.autoAck !== false) {
    agent.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as {
        type: string;
        commandId: string;
        command: { op: string; sessionId?: string };
      };
      if (m.type === 'server.command') {
        agent.send({
          type: 'agent.ack',
          commandId: m.commandId,
          ok: true,
          result: m.command.op === 'session.start' ? { sessionId: m.command.sessionId } : undefined,
        });
      }
    });
  }
  await sleep(100);
  return agent;
}

async function phone(token: string) {
  const c = await WsClient.connect(`${ctx.wsUrl}/v1/client/ws`);
  c.send({ type: 'auth', token });
  await c.waitFor((m) => m.type === 'auth.ok');
  return c;
}

async function setup() {
  const u = await registerUser(ctx);
  const d = await pairDevice(ctx, u.token);
  return { ...u, ...d };
}

const startSession = (token: string, deviceId: string, key = randomUUID()) =>
  api<{ id: string; status: string }>(ctx, 'POST', `/v1/devices/${deviceId}/sessions`, {
    token,
    headers: { 'idempotency-key': key },
    body: { workspaceId: 'ws_aaaaaaaa', mode: 'command', presetId: 'npm-test' },
  });

const ev = (sessionId: string, seq: number, event: unknown) => ({
  type: 'agent.event',
  sessionId,
  seq,
  ts: new Date().toISOString(),
  event,
});

describe('relay', () => {
  it('rejects agents with invalid credentials before the upgrade', async () => {
    await expect(
      WsClient.connect(`${ctx.wsUrl}/v1/agent/ws`, {
        authorization: 'Bearer cbd_bogusbogusbogusbogusbogus',
      }),
    ).rejects.toThrow('HTTP 401');
    await expect(WsClient.connect(`${ctx.wsUrl}/v1/agent/ws`)).rejects.toThrow('HTTP 401');
  });

  it('closes client sockets that do not authenticate', async () => {
    const c = await WsClient.connect(`${ctx.wsUrl}/v1/client/ws`);
    c.send({ type: 'subscribe', sessionId: randomUUID(), afterSeq: 0 });
    expect(await c.waitClose()).toBe(4401);
    const c2 = await WsClient.connect(`${ctx.wsUrl}/v1/client/ws`);
    c2.send({ type: 'auth', token: 'cba_invalidinvalidinvalidinvalid' });
    expect(await c2.waitClose()).toBe(4401);
  });

  it('reports device presence and metadata from the agent hello', async () => {
    const s = await setup();
    const p = await phone(s.token);
    const agent = await fakeAgent(s.deviceSecret);
    await p.waitFor((m) => m.type === 'device.status' && m.online === true);
    const dev = await api<{ online: boolean; workspaces: unknown[]; hostname: string }>(
      ctx,
      'GET',
      `/v1/devices/${s.deviceId}`,
      { token: s.token },
    );
    expect(dev.body.online).toBe(true);
    expect(dev.body.hostname).toBe('test-mac.local');
    expect(dev.body.workspaces).toHaveLength(1);
    agent.close();
    await p.waitFor((m) => m.type === 'device.status' && m.online === false);
    p.close();
  });

  it('starts a session, streams ordered output to the phone and forwards input', async () => {
    const s = await setup();
    const agent = await fakeAgent(s.deviceSecret);
    const created = await startSession(s.token, s.deviceId);
    expect(created.status).toBe(201);
    const sessionId = created.body.id;
    const startCmd = await agent.waitFor(
      (m) => m.type === 'server.command' && (m.command as { op: string }).op === 'session.start',
    );
    expect((startCmd.command as { sessionId: string }).sessionId).toBe(sessionId);

    const p = await phone(s.token);
    p.send({ type: 'subscribe', sessionId, afterSeq: 0 });
    await sleep(100);
    agent.send(ev(sessionId, 1, { kind: 'status', status: 'running' }));
    agent.send(ev(sessionId, 2, { kind: 'output', stream: 'pty', data: 'hello ' }));
    agent.send(ev(sessionId, 3, { kind: 'output', stream: 'pty', data: 'world\r\n' }));
    agent.send(ev(sessionId, 4, { kind: 'status', status: 'completed', exitCode: 0 }));
    await p.waitFor((m) => m.type === 'event' && m.seq === 4);
    const seqs = p.messages.filter((m) => m.type === 'event').map((m) => m.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);

    const row = await api<{ status: string; exitCode: number }>(
      ctx,
      'GET',
      `/v1/sessions/${sessionId}`,
      { token: s.token },
    );
    expect(row.body).toMatchObject({ status: 'completed', exitCode: 0 });

    const commandId = randomUUID();
    p.send({
      type: 'command',
      commandId,
      command: { op: 'session.input', sessionId, data: 'y\r' },
    });
    const fwd = await agent.waitFor(
      (m) => m.type === 'server.command' && m.commandId === commandId,
    );
    expect(fwd.command).toEqual({ op: 'session.input', sessionId, data: 'y\r' });
    await p.waitFor((m) => m.type === 'command.ack' && m.commandId === commandId && m.ok === true);

    // Duplicate command ids are suppressed at the relay.
    p.send({
      type: 'command',
      commandId,
      command: { op: 'session.input', sessionId, data: 'y\r' },
    });
    const dup = await p.waitFor(
      (m) => m.type === 'command.ack' && m.commandId === commandId && m.ok === false,
    );
    expect((dup.error as { code: string }).code).toBe('duplicate');
    expect(agent.messages.filter((m) => m.commandId === commandId)).toHaveLength(1);
    agent.close();
    p.close();
  });

  it('is idempotent on session creation', async () => {
    const s = await setup();
    const agent = await fakeAgent(s.deviceSecret);
    const key = randomUUID();
    const a = await startSession(s.token, s.deviceId, key);
    const b = await startSession(s.token, s.deviceId, key);
    expect(a.body.id).toBe(b.body.id);
    expect(agent.messages.filter((m) => m.type === 'server.command')).toHaveLength(1);
    const list = await api<{ sessions: unknown[] }>(ctx, 'GET', '/v1/sessions', { token: s.token });
    expect(list.body.sessions).toHaveLength(1);
    agent.close();
  });

  it('enforces ownership: other users cannot see, subscribe or control sessions', async () => {
    const s = await setup();
    const attacker = await registerUser(ctx);
    const agent = await fakeAgent(s.deviceSecret);
    const { body } = await startSession(s.token, s.deviceId);
    expect(
      (await api(ctx, 'GET', `/v1/sessions/${body.id}`, { token: attacker.token })).status,
    ).toBe(404);
    expect(
      (
        await api(ctx, 'POST', `/v1/sessions/${body.id}/signal`, {
          token: attacker.token,
          body: { signal: 'terminate' },
        })
      ).status,
    ).toBe(404);
    expect((await startSession(attacker.token, s.deviceId)).status).toBe(404);

    const p = await phone(attacker.token);
    p.send({ type: 'subscribe', sessionId: body.id, afterSeq: 0 });
    await p.waitFor((m) => m.type === 'error' && m.code === 'not_found');
    const commandId = randomUUID();
    p.send({
      type: 'command',
      commandId,
      command: { op: 'session.input', sessionId: body.id, data: 'rm -rf ~\r' },
    });
    await p.waitFor((m) => m.type === 'command.ack' && m.commandId === commandId && m.ok === false);
    await sleep(100);
    expect(agent.messages.some((m) => m.commandId === commandId)).toBe(false);
    agent.close();
    p.close();
  });

  it("drops events a device sends for sessions it doesn't own", async () => {
    const victim = await setup();
    const other = await setup();
    const vAgent = await fakeAgent(victim.deviceSecret);
    const { body } = await startSession(victim.token, victim.deviceId);
    const p = await phone(victim.token);
    p.send({ type: 'subscribe', sessionId: body.id, afterSeq: 0 });
    const evil = await fakeAgent(other.deviceSecret);
    evil.send(ev(body.id, 1, { kind: 'output', stream: 'pty', data: 'spoofed' }));
    await sleep(200);
    expect(p.messages.some((m) => m.type === 'event')).toBe(false);
    vAgent.close();
    evil.close();
    p.close();
  });

  it('rejects malformed commands at the API boundary', async () => {
    const s = await setup();
    const agent = await fakeAgent(s.deviceSecret);
    const r = await api(ctx, 'POST', `/v1/devices/${s.deviceId}/sessions`, {
      token: s.token,
      headers: { 'idempotency-key': randomUUID() },
      body: { workspaceId: '../../etc', mode: 'command', presetId: 'npm-test' },
    });
    expect(r.status).toBe(400);
    const unknownWs = await api(ctx, 'POST', `/v1/devices/${s.deviceId}/sessions`, {
      token: s.token,
      headers: { 'idempotency-key': randomUUID() },
      body: { workspaceId: 'ws_bbbbbbbb', mode: 'command', presetId: 'npm-test' },
    });
    expect(unknownWs.status).toBe(404);
    const noKey = await api(ctx, 'POST', `/v1/devices/${s.deviceId}/sessions`, {
      token: s.token,
      body: { workspaceId: 'ws_aaaaaaaa', mode: 'shell' },
    });
    expect(noKey.status).toBe(400);
    expect(agent.messages.filter((m) => m.type === 'server.command')).toHaveLength(0);
    agent.close();
  });

  it('surfaces agent policy rejections and does not keep ghost sessions', async () => {
    const s = await setup();
    const agent = await fakeAgent(s.deviceSecret, { autoAck: false });
    agent.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as { type: string; commandId: string };
      if (m.type === 'server.command')
        agent.send({
          type: 'agent.ack',
          commandId: m.commandId,
          ok: false,
          error: { code: 'policy_denied', message: 'Interactive shells are disabled' },
        });
    });
    const r = await api<{ code: string }>(ctx, 'POST', `/v1/devices/${s.deviceId}/sessions`, {
      token: s.token,
      headers: { 'idempotency-key': randomUUID() },
      body: { workspaceId: 'ws_aaaaaaaa', mode: 'shell' },
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('policy_denied');
    const list = await api<{ sessions: unknown[] }>(ctx, 'GET', '/v1/sessions', { token: s.token });
    expect(list.body.sessions).toHaveLength(0);
    agent.close();
  });

  it('returns 409 when the Mac is offline and 503 when it does not respond', async () => {
    const s = await setup();
    const first = await fakeAgent(s.deviceSecret); // registers workspaces, then goes away
    first.close();
    await sleep(100);
    expect((await startSession(s.token, s.deviceId)).status).toBe(409);
    const agent = await fakeAgent(s.deviceSecret, { autoAck: false });
    const r = await startSession(s.token, s.deviceId);
    expect(r.status).toBe(503);
    agent.close();
  }, 10_000);

  it('replays buffered events to a reconnecting phone, and asks the Mac when the buffer is incomplete', async () => {
    const s = await setup();
    const agent = await fakeAgent(s.deviceSecret);
    const { body } = await startSession(s.token, s.deviceId);
    for (let i = 1; i <= 5; i++)
      agent.send(ev(body.id, i, { kind: 'output', stream: 'pty', data: `line ${i}\n` }));
    await sleep(150);
    const p = await phone(s.token);
    p.send({ type: 'subscribe', sessionId: body.id, afterSeq: 2 });
    await p.waitFor((m) => m.type === 'event' && m.seq === 5);
    expect(p.messages.filter((m) => m.type === 'event').map((m) => m.seq)).toEqual([3, 4, 5]);

    // A session the relay has never buffered: the relay asks the Mac to replay.
    const r2 = await startSession(s.token, s.deviceId);
    const p2 = await phone(s.token);
    p2.send({ type: 'subscribe', sessionId: r2.body.id, afterSeq: 0 });
    const replay = await agent.waitFor(
      (m) => m.type === 'server.command' && (m.command as { op: string }).op === 'session.replay',
    );
    expect(replay.command).toEqual({ op: 'session.replay', sessionId: r2.body.id, afterSeq: 0 });
    agent.close();
    p.close();
    p2.close();
  });

  it('marks sessions lost when the agent reconnects without them', async () => {
    const s = await setup();
    const agent = await fakeAgent(s.deviceSecret);
    const keep = await startSession(s.token, s.deviceId);
    const lose = await startSession(s.token, s.deviceId);
    agent.send(ev(keep.body.id, 1, { kind: 'status', status: 'running' }));
    agent.send(ev(lose.body.id, 1, { kind: 'status', status: 'running' }));
    await sleep(100);
    agent.close();
    await sleep(100);
    const again = await fakeAgent(s.deviceSecret, {
      sessions: [{ sessionId: keep.body.id, status: 'running', lastSeq: 1 }],
    });
    await sleep(150);
    const k = await api<{ status: string }>(ctx, 'GET', `/v1/sessions/${keep.body.id}`, {
      token: s.token,
    });
    const l = await api<{ status: string }>(ctx, 'GET', `/v1/sessions/${lose.body.id}`, {
      token: s.token,
    });
    expect(k.body.status).toBe('running');
    expect(l.body.status).toBe('lost');
    again.close();
  });

  it('revocation closes the agent connection, kills sessions and invalidates the credential', async () => {
    const s = await setup();
    const agent = await fakeAgent(s.deviceSecret);
    const { body } = await startSession(s.token, s.deviceId);
    expect((await api(ctx, 'DELETE', `/v1/devices/${s.deviceId}`, { token: s.token })).status).toBe(
      200,
    );
    await agent.waitFor((m) => m.type === 'server.revoked');
    expect(await agent.waitClose()).toBe(4401);
    const sess = await api<{ status: string }>(ctx, 'GET', `/v1/sessions/${body.id}`, {
      token: s.token,
    });
    expect(sess.body.status).toBe('killed');
    await expect(
      WsClient.connect(`${ctx.wsUrl}/v1/agent/ws`, { authorization: `Bearer ${s.deviceSecret}` }),
    ).rejects.toThrow('HTTP 401');
  });

  it('closes phone sockets on logout', async () => {
    const s = await setup();
    const p = await phone(s.token);
    await api(ctx, 'POST', '/v1/auth/logout', { token: s.token });
    expect(await p.waitClose()).toBe(4401);
  });

  it('rate limits floods on the client socket and enforces frame size limits', async () => {
    const s = await setup();
    const p = await phone(s.token);
    for (let i = 0; i < 400; i++) p.send({ type: 'ping', ts: i });
    expect(await p.waitClose()).toBe(4429);
    const p2 = await phone(s.token);
    p2.ws.send('x'.repeat(300 * 1024));
    expect(await p2.waitClose()).toBe(1009);
  });
});
