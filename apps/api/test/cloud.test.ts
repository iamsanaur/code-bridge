import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BetaManagedAgentsStreamSessionEvents } from '@anthropic-ai/sdk/resources/beta/sessions/events';
import { mapManagedEvent } from '../src/cloud/anthropicProvider.js';
import {
  ProviderError,
  type ManagedCloudSessionProvider,
  type MappedProviderEvent,
} from '../src/cloud/provider.js';
import { api, registerUser, sleep, startTestServer, WsClient, type TestCtx } from './helpers.js';

/**
 * MOCKED: these tests use an in-memory fake of the Managed Agents API. They verify
 * CodeBridge's lifecycle logic, not Anthropic's service. See cloud.live.test.ts for
 * the opt-in real integration test.
 */
class FakeProvider implements ManagedCloudSessionProvider {
  calls: Array<{ op: string; args: unknown[] }> = [];
  private queues = new Map<string, MappedProviderEvent[]>();
  private listeners = new Map<string, (m: MappedProviderEvent) => void>();
  failCreateWith: ProviderError | null = null;
  status: 'idle' | 'running' | 'terminated' = 'running';

  constructor(readonly apiKey: string) {}

  push(id: string, m: MappedProviderEvent) {
    const l = this.listeners.get(id);
    if (l) l(m);
    else (this.queues.get(id) ?? this.queues.set(id, []).get(id)!).push(m);
  }
  async ensureResources(...args: unknown[]) {
    this.calls.push({ op: 'ensureResources', args });
    return { agentId: 'agent_1', agentVersion: 1, environmentId: 'env_1' };
  }
  async createSession(input: { budgetCents: number; prompt: string }) {
    this.calls.push({ op: 'createSession', args: [input] });
    if (this.failCreateWith) throw this.failCreateWith;
    return { id: `sesn_${this.calls.length}`, status: 'running' as const };
  }
  async retrieveSession(id: string) {
    return { id, status: this.status };
  }
  async sendMessage(id: string, text: string) {
    this.calls.push({ op: 'sendMessage', args: [id, text] });
  }
  async interrupt(id: string) {
    this.calls.push({ op: 'interrupt', args: [id] });
    this.status = 'idle';
  }
  async confirmTool(id: string, toolUseId: string, allow: boolean) {
    this.calls.push({ op: 'confirmTool', args: [id, toolUseId, allow] });
  }
  async *stream(id: string, signal: AbortSignal): AsyncIterable<MappedProviderEvent> {
    const buffered: MappedProviderEvent[] = this.queues.get(id) ?? [];
    this.queues.delete(id);
    let wake: (() => void) | null = null;
    this.listeners.set(id, (m) => {
      buffered.push(m);
      wake?.();
    });
    while (!signal.aborted) {
      if (buffered.length) {
        yield buffered.shift()!;
        continue;
      }
      await new Promise<void>((r) => {
        wake = r;
        signal.addEventListener('abort', () => r(), { once: true });
      });
      wake = null;
    }
  }
  async history() {
    return [];
  }
  async archive(id: string) {
    this.calls.push({ op: 'archive', args: [id] });
  }
}

let ctx: TestCtx;
const providers: FakeProvider[] = [];
beforeAll(async () => {
  ctx = await startTestServer({
    cloudProviderFactory: (key) => {
      const p = new FakeProvider(key);
      providers.push(p);
      return p;
    },
    env: { CLOUD_MAX_CONCURRENT: '1' },
  });
});
afterAll(async () => ctx.close());

const KEY = 'sk-ant-api03-' + 'A'.repeat(40);

describe('cloud credentials', () => {
  it('stores the key encrypted and never returns it', async () => {
    const u = await registerUser(ctx);
    const put = await api<{ hint: string }>(ctx, 'PUT', '/v1/credentials/anthropic', {
      token: u.token,
      body: { apiKey: KEY },
    });
    expect(put.status).toBe(200);
    expect(put.body.hint).toBe('••••AAAA');
    const { rows } = await ctx.db.query<{ ciphertext: Buffer }>(
      'SELECT ciphertext FROM provider_credentials WHERE user_id = $1',
      [u.userId],
    );
    expect(rows[0]!.ciphertext.toString('utf8')).not.toContain('sk-ant');
    const get = await api(ctx, 'GET', '/v1/credentials/anthropic', { token: u.token });
    expect(JSON.stringify(get.body)).not.toContain(KEY);
    const audit = await ctx.db.query('SELECT metadata FROM audit_events WHERE user_id = $1', [
      u.userId,
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain('sk-ant');
    expect(
      (
        await api(ctx, 'PUT', '/v1/credentials/anthropic', {
          token: u.token,
          body: { apiKey: 'not-a-key-but-long-enough' },
        })
      ).status,
    ).toBe(400);
  });
});

describe('cloud sessions (mocked provider)', () => {
  it('requires a credential', async () => {
    const u = await registerUser(ctx);
    const r = await api<{ code: string }>(ctx, 'POST', '/v1/cloud/sessions', {
      token: u.token,
      headers: { 'idempotency-key': randomUUID() },
      body: { prompt: 'hi' },
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('credential_missing');
  });

  it('creates, streams, approves, enforces quota and ends a session', async () => {
    const u = await registerUser(ctx);
    await api(ctx, 'PUT', '/v1/credentials/anthropic', { token: u.token, body: { apiKey: KEY } });
    const key = randomUUID();
    const created = await api<{
      id: string;
      kind: string;
      status: string;
      cloud: { environmentId: string };
    }>(ctx, 'POST', '/v1/cloud/sessions', {
      token: u.token,
      headers: { 'idempotency-key': key },
      body: { prompt: 'Write fizzbuzz in Python' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'cloud',
      status: 'running',
      cloud: { environmentId: 'env_1' },
    });
    const provider = providers.find(
      (p) => p.apiKey === KEY && p.calls.some((c) => c.op === 'createSession'),
    )!;
    expect(provider).toBeDefined();
    const createCall = provider.calls.find((c) => c.op === 'createSession')!.args[0] as {
      budgetCents: number;
      prompt: string;
    };
    expect(createCall.budgetCents).toBe(500);
    expect(createCall.prompt).toBe('Write fizzbuzz in Python');

    // Idempotent retry returns the same session without creating another.
    const again = await api<{ id: string }>(ctx, 'POST', '/v1/cloud/sessions', {
      token: u.token,
      headers: { 'idempotency-key': key },
      body: { prompt: 'Write fizzbuzz in Python' },
    });
    expect(again.body.id).toBe(created.body.id);
    expect(provider.calls.filter((c) => c.op === 'createSession')).toHaveLength(1);

    // Quota: CLOUD_MAX_CONCURRENT=1
    const second = await api<{ code: string }>(ctx, 'POST', '/v1/cloud/sessions', {
      token: u.token,
      headers: { 'idempotency-key': randomUUID() },
      body: { prompt: 'x' },
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('quota_exceeded');

    const phone = await WsClient.connect(`${ctx.wsUrl}/v1/client/ws`);
    phone.send({ type: 'auth', token: u.token });
    await phone.waitFor((m) => m.type === 'auth.ok');
    phone.send({ type: 'subscribe', sessionId: created.body.id, afterSeq: 0 });
    await sleep(100);
    const providerId = (provider.calls.find((c) => c.op === 'createSession') && 'sesn_2') as string;
    const raw = (e: unknown) =>
      mapManagedEvent(e as BetaManagedAgentsStreamSessionEvents, 'claude-opus-5-5')!;
    provider.push(
      providerId,
      raw({
        type: 'agent.message',
        id: 'e1',
        processed_at: '',
        content: [{ type: 'text', text: 'Sure!' }],
      }),
    );
    provider.push(
      providerId,
      raw({
        type: 'agent.tool_use',
        id: 'tu1',
        name: 'bash',
        input: { command: 'python fizz.py' },
        processed_at: '',
        evaluated_permission: 'ask',
      }),
    );
    const approval = await phone.waitFor(
      (m) => m.type === 'event' && (m.event as { kind: string }).kind === 'approval.request',
    );
    expect((approval.event as { approvalId: string }).approvalId).toBe('tu1');
    const text = phone.messages.find(
      (m) => m.type === 'event' && (m.event as { kind: string }).kind === 'agent.text',
    );
    expect((text!.event as { delta: string }).delta).toBe('Sure!');

    const ok = await api(ctx, 'POST', `/v1/sessions/${created.body.id}/approvals/tu1`, {
      token: u.token,
      body: { decision: 'approve' },
    });
    expect(ok.status).toBe(200);
    expect(provider.calls.find((c) => c.op === 'confirmTool')!.args).toEqual([
      providerId,
      'tu1',
      true,
    ]);

    expect(
      (
        await api(ctx, 'POST', `/v1/sessions/${created.body.id}/prompt`, {
          token: u.token,
          body: { text: 'now add tests' },
        })
      ).status,
    ).toBe(200);
    expect(provider.calls.find((c) => c.op === 'sendMessage')!.args).toEqual([
      providerId,
      'now add tests',
    ]);

    // Terminal input is not a thing for cloud sessions.
    const cmdId = randomUUID();
    phone.send({
      type: 'command',
      commandId: cmdId,
      command: { op: 'session.input', sessionId: created.body.id, data: 'ls\r' },
    });
    const ack = await phone.waitFor((m) => m.type === 'command.ack' && m.commandId === cmdId);
    expect((ack.error as { code: string }).code).toBe('unsupported');

    expect(
      (await api(ctx, 'POST', `/v1/cloud/sessions/${created.body.id}/end`, { token: u.token }))
        .status,
    ).toBe(200);
    expect(provider.calls.map((c) => c.op)).toContain('archive');
    const ended = await api<{ status: string }>(ctx, 'GET', `/v1/sessions/${created.body.id}`, {
      token: u.token,
    });
    expect(ended.body.status).toBe('completed');
    phone.close();
  });

  it('maps provider auth failures to a clear error and marks the session failed', async () => {
    const u = await registerUser(ctx);
    await api(ctx, 'PUT', '/v1/credentials/anthropic', {
      token: u.token,
      body: { apiKey: 'sk-ant-api03-' + 'B'.repeat(40) },
    });
    // Prime the provider so we can make it fail.
    await api(ctx, 'GET', '/v1/cloud/config', { token: u.token });
    await api(ctx, 'PUT', '/v1/cloud/config', { token: u.token, body: { budgetCents: 200 } });
    const p = providers[providers.length - 1]!;
    p.failCreateWith = new ProviderError(
      'invalid_api_key',
      'Anthropic rejected the API key',
      false,
    );
    const r = await api<{ code: string }>(ctx, 'POST', '/v1/cloud/sessions', {
      token: u.token,
      headers: { 'idempotency-key': randomUUID() },
      body: { prompt: 'x' },
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('invalid_api_key');
    const list = await api<{ sessions: Array<{ status: string }> }>(
      ctx,
      'GET',
      '/v1/sessions?kind=cloud',
      { token: u.token },
    );
    expect(list.body.sessions[0]!.status).toBe('failed');
  });

  it('validates cloud configuration', async () => {
    const u = await registerUser(ctx);
    expect(
      (
        await api(ctx, 'PUT', '/v1/cloud/config', {
          token: u.token,
          body: { budgetCents: 1_000_000 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(ctx, 'PUT', '/v1/cloud/config', {
          token: u.token,
          body: { allowedHosts: ['http://evil'] },
        })
      ).status,
    ).toBe(400);
    const ok = await api<{ allowedHosts: string[]; networking: string }>(
      ctx,
      'PUT',
      '/v1/cloud/config',
      {
        token: u.token,
        body: { allowedHosts: ['api.github.com'], networking: 'limited' },
      },
    );
    expect(ok.body.allowedHosts).toEqual(['api.github.com']);
  });
});

describe('mapManagedEvent', () => {
  const map = (e: unknown) =>
    mapManagedEvent(e as BetaManagedAgentsStreamSessionEvents, 'claude-opus-5-5');

  it('maps idle stop reasons', () => {
    expect(
      map({
        type: 'session.status_idle',
        id: 'a',
        processed_at: '',
        stop_details: null,
        stop_reason: { type: 'requires_action', event_ids: [] },
      })!.status,
    ).toBe('waiting');
    const done = map({
      type: 'session.status_idle',
      id: 'b',
      processed_at: '',
      stop_details: null,
      stop_reason: { type: 'budget_reached' },
    })!;
    expect(done.status).toBe('idle');
    expect(done.events[1]).toMatchObject({
      kind: 'status',
      message: expect.stringContaining('budget'),
    });
  });
  it('uses list_cost (cents) for usage', () => {
    const m = map({
      type: 'session.usage',
      id: 'u',
      processed_at: '',
      usage: { input_tokens: 10, output_tokens: 20, list_cost: { amount: '123', currency: 'USD' } },
    })!;
    expect(m.events[0]).toMatchObject({
      kind: 'usage',
      usage: { estimatedCostUsd: 1.23, inputTokens: 10, source: 'managed_session_usage' },
    });
  });
  it('redacts secrets from tool inputs', () => {
    const m = map({
      type: 'agent.tool_use',
      id: 't',
      name: 'bash',
      processed_at: '',
      input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnop"' },
      evaluated_permission: 'allow',
    })!;
    expect(JSON.stringify(m.events)).not.toContain('abcdefghijklmnop');
  });
  it('ignores spans and unknown events', () => {
    expect(map({ type: 'span.model_request_start', id: 's', processed_at: '' })).toBeNull();
  });
});
