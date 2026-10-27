/**
 * End-to-end: real API server + real Postgres + the real Mac agent runtime
 * (pairing, Keychain-equivalent store, PTY sessions) + a phone WebSocket client.
 * Only the secret store is swapped for an in-memory one (no macOS Keychain on CI).
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../mac-agent/src/agent.js';
import { ConfigStore } from '../../mac-agent/src/config.js';
import { pair } from '../../mac-agent/src/pair.js';
import { MemorySecretStore } from '../../mac-agent/src/secrets.js';
import { prepareWorkspace } from '../../mac-agent/src/workspaces.js';
import { api, registerUser, sleep, startTestServer, WsClient, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let runtime: AgentRuntime;
const secrets = new MemorySecretStore();
let store: ConfigStore;
let user: Awaited<ReturnType<typeof registerUser>>;
let deviceId: string;
let workspaceId: string;
let phone: WsClient;

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

beforeAll(async () => {
  ctx = await startTestServer();
  user = await registerUser(ctx);
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cb-e2e-home-')));
  store = new ConfigStore(home);
  const project = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cb-e2e-proj-')));
  await writeFile(path.join(project, 'README.md'), '# demo\n');

  // Pair: the agent shows a code; the phone claims and approves it.
  let code: string | null = null;
  const paired = pair({
    serverUrl: ctx.baseUrl,
    name: 'E2E Mac',
    store,
    secrets,
    io: {
      print: (s) => {
        const m = /enter this code manually:\s+(\S+)/.exec(s);
        if (m) code = m[1]!;
      },
      confirm: async () => true,
      sleep: (ms) => sleep(Math.min(ms, 50)),
    },
  });
  while (!code) await sleep(20);
  const claim = await api<{ pairingId: string; deviceName: string }>(
    ctx,
    'POST',
    '/v1/pairing/claim',
    { token: user.token, body: { code } },
  );
  expect(claim.body.deviceName).toBe('E2E Mac');
  await api(ctx, 'POST', `/v1/pairing/${claim.body.pairingId}/approve`, { token: user.token });
  expect(await paired).toBe(true);

  const ws = await prepareWorkspace(project);
  workspaceId = ws.id;
  const cfg = await store.update((c) => {
    c.workspaces.push(ws);
    c.policy.presets = [
      { id: 'echo', label: 'echo', argv: ['echo', 'hello from the mac'] },
      { id: 'cat', label: 'cat', argv: ['cat'] },
      {
        id: 'ticks',
        label: 'ticks',
        argv: ['sh', '-c', 'for i in 1 2 3 4 5 6; do echo tick$i; sleep 0.25; done'],
      },
      { id: 'env', label: 'env', argv: ['env'] },
    ];
  });
  deviceId = cfg.deviceId!;
  expect(await secrets.get('device-secret')).toMatch(/^cbd_/);

  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-must-not-reach-children';
  runtime = new AgentRuntime({ store, secrets, log: quiet, healthPort: 0 });
  await runtime.start();
  for (let i = 0; i < 100 && runtime.connection.state !== 'connected'; i++) await sleep(20);

  phone = await WsClient.connect(`${ctx.wsUrl}/v1/client/ws`);
  phone.send({ type: 'auth', token: user.token });
  await phone.waitFor((m) => m.type === 'auth.ok');
});

afterAll(async () => {
  phone?.close();
  runtime?.stop();
  await ctx.close();
});

type Ev = {
  type: string;
  sessionId: string;
  seq: number;
  event: { kind: string; data?: string; status?: string };
};
const eventsFor = (sessionId: string) => {
  const seen = new Map<number, Ev>();
  for (const m of phone.messages as unknown as Ev[])
    if (m.type === 'event' && m.sessionId === sessionId) seen.set(m.seq, m);
  return [...seen.values()].sort((a, b) => a.seq - b.seq);
};
const outputOf = (sessionId: string) =>
  eventsFor(sessionId)
    .filter((e) => e.event.kind === 'output')
    .map((e) => e.event.data)
    .join('');
const waitStatus = (sessionId: string, status: string, timeoutMs = 8000) =>
  phone.waitFor(
    (m) =>
      m.type === 'event' &&
      m.sessionId === sessionId &&
      (m.event as { status?: string }).status === status,
    timeoutMs,
  );

async function startPreset(presetId: string) {
  const r = await api<{ id: string }>(ctx, 'POST', `/v1/devices/${deviceId}/sessions`, {
    token: user.token,
    headers: { 'idempotency-key': randomUUID() },
    body: { workspaceId, mode: 'command', presetId },
  });
  expect(r.status).toBe(201);
  phone.send({ type: 'subscribe', sessionId: r.body.id, afterSeq: 0 });
  return r.body.id;
}

describe('end-to-end: phone -> relay -> Mac agent', () => {
  it('shows the paired Mac online with its authorized workspace', async () => {
    const d = await api<{
      online: boolean;
      workspaces: Array<{ id: string }>;
      capabilities: { pty: boolean };
    }>(ctx, 'GET', `/v1/devices/${deviceId}`, { token: user.token });
    expect(d.body.online).toBe(true);
    expect(d.body.workspaces.map((w) => w.id)).toEqual([workspaceId]);
    expect(d.body.capabilities.pty).toBe(true);
  });

  it('runs an approved command on the Mac and streams its output to the phone', async () => {
    const id = await startPreset('echo');
    await waitStatus(id, 'completed');
    expect(outputOf(id)).toContain('hello from the mac');
    const seqs = eventsFor(id).map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    const row = await api<{ status: string; exitCode: number }>(ctx, 'GET', `/v1/sessions/${id}`, {
      token: user.token,
    });
    expect(row.body).toMatchObject({ status: 'completed', exitCode: 0 });
  });

  it('does not pass the agent environment (API keys) to child processes', async () => {
    const id = await startPreset('env');
    await waitStatus(id, 'completed');
    expect(outputOf(id)).not.toContain('must-not-reach-children');
    expect(outputOf(id)).toContain('CODEBRIDGE=1');
  });

  it('accepts terminal input from the phone and terminates on request', async () => {
    const id = await startPreset('cat');
    await waitStatus(id, 'running');
    phone.send({
      type: 'command',
      commandId: randomUUID(),
      command: { op: 'session.input', sessionId: id, data: 'typed on phone\r' },
    });
    await phone.waitFor(() => outputOf(id).includes('typed on phone'));
    const stop = await api(ctx, 'POST', `/v1/sessions/${id}/signal`, {
      token: user.token,
      body: { signal: 'terminate' },
    });
    expect(stop.status).toBe(200);
    await waitStatus(id, 'killed');
  });

  it('survives a dropped Mac connection mid-command without losing or duplicating output', async () => {
    const id = await startPreset('ticks');
    await phone.waitFor(() => outputOf(id).includes('tick2'));
    // Simulate a network interruption on the Mac side.
    (runtime.connection as unknown as { ws: { terminate(): void } }).ws.terminate();
    await waitStatus(id, 'completed', 15_000);
    const out = outputOf(id);
    for (let i = 1; i <= 6; i++) expect(out.match(new RegExp(`tick${i}`, 'g'))).toHaveLength(1);
    const seqs = eventsFor(id).map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(runtime.connection.state).toBe('connected');
  }, 20_000);

  it('a phone that reconnects resumes from its last seen event', async () => {
    const id = await startPreset('echo');
    await waitStatus(id, 'completed');
    const all = eventsFor(id);
    const late = await WsClient.connect(`${ctx.wsUrl}/v1/client/ws`);
    late.send({ type: 'auth', token: user.token });
    await late.waitFor((m) => m.type === 'auth.ok');
    late.send({ type: 'subscribe', sessionId: id, afterSeq: 1 });
    await late.waitFor((m) => m.type === 'event' && m.seq === all.at(-1)!.seq);
    expect(late.messages.filter((m) => m.type === 'event').map((m) => m.seq)).toEqual(
      all.slice(1).map((e) => e.seq),
    );
    late.close();
  });

  it('rejects commands the Mac policy does not allow', async () => {
    const r = await api<{ code: string }>(ctx, 'POST', `/v1/devices/${deviceId}/sessions`, {
      token: user.token,
      headers: { 'idempotency-key': randomUUID() },
      body: { workspaceId, mode: 'command', argv: ['ls', '-la'] },
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('policy_denied');
    const shell = await api<{ code: string }>(ctx, 'POST', `/v1/devices/${deviceId}/sessions`, {
      token: user.token,
      headers: { 'idempotency-key': randomUUID() },
      body: { workspaceId, mode: 'shell' },
    });
    expect(shell.status).toBe(403);
  });

  it("other users can't use this Mac", async () => {
    const other = await registerUser(ctx);
    const r = await api(ctx, 'POST', `/v1/devices/${deviceId}/sessions`, {
      token: other.token,
      headers: { 'idempotency-key': randomUUID() },
      body: { workspaceId, mode: 'command', presetId: 'echo' },
    });
    expect(r.status).toBe(404);
  });

  it('reports git status for the workspace', async () => {
    const r = await api<{ files: unknown[] } & { code?: string }>(
      ctx,
      'GET',
      `/v1/devices/${deviceId}/workspaces/${workspaceId}/git/status`,
      { token: user.token },
    );
    // The temp project isn't a git repo: the Mac reports a git error rather than crashing.
    expect([200, 422]).toContain(r.status);
  });

  it('revoking the Mac stops the agent and wipes its credential', async () => {
    const id = await startPreset('cat');
    await waitStatus(id, 'running');
    expect(
      (await api(ctx, 'DELETE', `/v1/devices/${deviceId}`, { token: user.token })).status,
    ).toBe(200);
    for (let i = 0; i < 100 && (await store.load()).deviceId; i++) await sleep(20);
    expect(await secrets.get('device-secret')).toBeNull();
    expect(runtime.connection.state).toBe('revoked');
    expect((await store.load()).deviceId).toBeUndefined();
    const row = await api<{ status: string }>(ctx, 'GET', `/v1/sessions/${id}`, {
      token: user.token,
    });
    expect(row.body.status).toBe('killed');
  });
});
