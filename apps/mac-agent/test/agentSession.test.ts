import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AgentSession, type MessagesClient } from '../src/coding/agentSession.js';
import { ClaudeCodeSession } from '../src/coding/claudeCodeSession.js';
import { EventLog, tempWorkspace, testConfig } from './helpers.js';

/**
 * MOCKED: a scripted stand-in for the Anthropic Messages API. These tests verify
 * the agent loop, tool confinement and approvals, not the real API.
 */
type Step =
  | Anthropic.Beta.Messages.BetaMessage
  | Error
  | ((
      params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
      signal: AbortSignal,
    ) => Promise<Anthropic.Beta.Messages.BetaMessage>);

function msg(
  content: unknown[],
  stop_reason: string,
  text?: string,
): Anthropic.Beta.Messages.BetaMessage {
  return {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: (text
      ? [{ type: 'text', text }, ...content]
      : content) as Anthropic.Beta.Messages.BetaMessage['content'],
    stop_reason: stop_reason as Anthropic.Beta.Messages.BetaMessage['stop_reason'],
    stop_sequence: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    } as Anthropic.Beta.Messages.BetaUsage,
  } as Anthropic.Beta.Messages.BetaMessage;
}
const toolUse = (name: string, input: unknown, id = `toolu_${randomUUID()}`) => ({
  type: 'tool_use',
  id,
  name,
  input,
});

function fakeClient(steps: Step[]) {
  const requests: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    stream(params, { signal }) {
      requests.push(structuredClone(params));
      const step = steps.shift();
      const textCbs: Array<(d: string) => void> = [];
      const final = (async () => {
        await Promise.resolve(); // like the SDK, deliver deltas only after listeners attach
        if (signal.aborted) throw new Error('aborted');
        if (!step) throw new Error('no more scripted steps');
        if (step instanceof Error) throw step;
        const m = typeof step === 'function' ? await step(params, signal) : step;
        for (const b of m.content) if (b.type === 'text') textCbs.forEach((cb) => cb(b.text));
        return m;
      })();
      return {
        on: (_e: 'text', cb: (d: string) => void) => {
          textCbs.push(cb);
        },
        finalMessage: () => final,
      };
    },
  };
  return { client, requests };
}

async function setup(
  steps: Step[],
  files: Record<string, string> = { 'hello.txt': 'hello world\n' },
) {
  const ws = await tempWorkspace(files);
  const cfg = testConfig(ws);
  const log = new EventLog();
  const { client, requests } = fakeClient(steps);
  const session = new AgentSession(randomUUID(), ws, log.sink, { config: cfg, client });
  await session.start();
  const idle = () => log.waitFor((e) => e.event.kind === 'agent.turn_end');
  return { ws, cfg, log, session, requests, idle };
}

describe('AgentSession (mocked Messages API)', () => {
  it('runs a read-only tool loop, streams text and reports usage', async () => {
    const t = await setup([
      msg([toolUse('read_file', { path: 'hello.txt' })], 'tool_use', 'Let me look.'),
      msg([], 'end_turn', 'It says hello world.'),
    ]);
    t.session.prompt('What is in hello.txt?');
    await t.idle();
    const kinds = t.log.events.map((e) => e.event.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'user.prompt',
        'agent.text',
        'agent.tool_call',
        'agent.tool_result',
        'usage',
        'agent.turn_end',
      ]),
    );
    // The second request carries the tool result back, in a single user message.
    const second = t.requests[1]!;
    const last = second.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(JSON.stringify(last.content)).toContain('hello world');
    // Requests use streaming-friendly settings and tool definitions with eager streaming.
    expect(
      second.tools!.every(
        (tool) => (tool as { eager_input_streaming?: boolean }).eager_input_streaming,
      ),
    ).toBe(true);
    const usage = t.log.events.filter((e) => e.event.kind === 'usage').at(-1)!.event as {
      usage: { inputTokens: number; estimatedCostUsd: number };
    };
    expect(usage.usage.inputTokens).toBe(2000);
    expect(usage.usage.estimatedCostUsd).toBeCloseTo((2000 * 4 + 200 * 20) / 1e6);
  });

  it('refuses paths outside the workspace even if the model asks', async () => {
    const t = await setup([
      msg([toolUse('read_file', { path: '../../../../etc/passwd' })], 'tool_use'),
      msg([], 'end_turn', 'ok'),
    ]);
    t.session.prompt('read /etc/passwd');
    await t.idle();
    const result = t.log.events.find((e) => e.event.kind === 'agent.tool_result')!.event as {
      ok: boolean;
      summary: string;
    };
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/escapes/);
    expect(JSON.stringify(t.requests[1]!.messages)).not.toContain('root:');
  });

  it('requires approval before writing; rejected writes do not touch disk', async () => {
    const t = await setup([
      msg([toolUse('write_file', { path: 'out.txt', content: 'data' })], 'tool_use'),
      msg([], 'end_turn', 'done'),
    ]);
    t.session.prompt('write a file');
    const req = await t.log.waitFor((e) => e.event.kind === 'approval.request');
    expect(t.session.status).toBe('waiting');
    t.session.respondApproval((req.event as { approvalId: string }).approvalId, 'reject');
    await t.idle();
    await expect(readFile(path.join(t.ws.path, 'out.txt'), 'utf8')).rejects.toThrow();
    expect(
      t.log.events.some(
        (e) => e.event.kind === 'approval.resolved' && e.event.decision === 'rejected',
      ),
    ).toBe(true);
  });

  it('writes after approval', async () => {
    const t = await setup([
      msg(
        [toolUse('edit_file', { path: 'hello.txt', old_string: 'world', new_string: 'phone' })],
        'tool_use',
      ),
      msg([], 'end_turn', 'done'),
    ]);
    t.session.prompt('edit');
    const req = await t.log.waitFor((e) => e.event.kind === 'approval.request');
    expect((req.event as { detail: string }).detail).toContain('+ hello phone');
    t.session.respondApproval((req.event as { approvalId: string }).approvalId, 'approve');
    await t.idle();
    expect(await readFile(path.join(t.ws.path, 'hello.txt'), 'utf8')).toBe('hello phone\n');
  });

  it('refuses denied commands without asking and runs presets without approval', async () => {
    const t = await setup([
      msg(
        [
          toolUse('run_command', { argv: ['sudo', 'whoami'] }),
          toolUse('run_command', { argv: ['echo', 'hello from preset'] }),
        ],
        'tool_use',
      ),
      msg([], 'end_turn', 'ok'),
    ]);
    t.session.prompt('go');
    await t.idle();
    const results = t.log.events
      .filter((e) => e.event.kind === 'agent.tool_result')
      .map((e) => e.event as { ok: boolean; summary: string });
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]!.summary).toMatch(/Refused/);
    expect(results[1]).toMatchObject({ ok: true });
    expect(t.log.events.some((e) => e.event.kind === 'approval.request')).toBe(false);
  });

  it('bounds the loop with maxTurnsPerPrompt', async () => {
    const loop = Array.from({ length: 10 }, () => msg([toolUse('list_files', {})], 'tool_use'));
    const t = await setup(loop);
    t.cfg.codingAgent.maxTurnsPerPrompt = 3;
    t.session.prompt('loop forever');
    await t.idle();
    expect(t.requests).toHaveLength(3);
    expect(t.log.events.some((e) => e.event.kind === 'error' && e.event.code === 'max_turns')).toBe(
      true,
    );
  });

  it('maps rate limits and auth failures to clear errors and recovers for the next prompt', async () => {
    const rate = new Anthropic.RateLimitError(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
      'slow down',
      new Headers(),
    );
    const auth = new Anthropic.AuthenticationError(
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'bad key' } },
      'bad key',
      new Headers(),
    );
    const t = await setup([rate, auth, msg([], 'end_turn', 'fine now')]);
    t.session.prompt('one');
    await t.log.waitFor((e) => e.event.kind === 'error' && e.event.code === 'rate_limited');
    await t.log.waitFor((e) => e.event.kind === 'status' && e.event.status === 'idle' && e.seq > 3);
    t.session.prompt('two');
    await t.log.waitFor((e) => e.event.kind === 'error' && e.event.code === 'invalid_api_key');
    t.session.prompt('three');
    await t.log.waitFor((e) => e.event.kind === 'agent.text' && e.event.delta === 'fine now');
    // History stays valid: the failed prompts were dropped, the last request has exactly one user turn.
    expect(t.requests[2]!.messages).toEqual([{ role: 'user', content: 'three' }]);
  });

  it('handles refusals and never runs tools from a max_tokens-truncated turn', async () => {
    const t = await setup([
      msg([toolUse('write_file', { path: 'x.txt', content: 'partial' })], 'max_tokens'),
      msg([], 'refusal'),
    ]);
    t.session.prompt('go');
    await t.idle();
    expect(t.log.events.some((e) => e.event.kind === 'approval.request')).toBe(false);
    expect(t.log.events.some((e) => e.event.kind === 'error' && e.event.code === 'refusal')).toBe(
      true,
    );
  });

  it('cancels an in-flight request and pending approvals on interrupt', async () => {
    const t = await setup([
      msg([toolUse('write_file', { path: 'a.txt', content: 'x' })], 'tool_use'),
      (_p, signal) =>
        new Promise((_r, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    ]);
    t.session.prompt('go');
    await t.log.waitFor((e) => e.event.kind === 'approval.request');
    t.session.signal('interrupt');
    await t.idle();
    expect(
      t.log.events.some(
        (e) => e.event.kind === 'approval.resolved' && e.event.decision === 'cancelled',
      ),
    ).toBe(true);
    expect(t.log.events.some((e) => e.event.kind === 'error' && e.event.code === 'cancelled')).toBe(
      true,
    );
  });

  it('sends server-side fallbacks with the documented beta header', async () => {
    const t = await setup([msg([], 'end_turn', 'hi')]);
    t.session.prompt('hi');
    await t.idle();
    const r = t.requests[0] as unknown as { betas: string[]; fallbacks: string; model: string };
    expect(r.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(r.fallbacks).toBe('default');
    expect(r.model).toBe('claude-opus-5-5');
  });
});

describe('ClaudeCodeSession stream-json parsing (mocked CLI output)', () => {
  it('maps assistant text, tool use/results and the result usage', async () => {
    const ws = await tempWorkspace();
    const log = new EventLog();
    const s = new ClaudeCodeSession(randomUUID(), ws, log.sink, testConfig(ws), '/usr/bin/false');
    s.handleLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'cc1',
        model: 'claude-opus-5-5',
      }),
    );
    s.handleLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hi' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } },
          ],
        },
      }),
    );
    s.handleLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'contents', is_error: false },
          ],
        },
      }),
    );
    s.handleLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.0123,
        usage: { input_tokens: 5, output_tokens: 7 },
      }),
    );
    s.handleLine('not json');
    const kinds = log.events.map((e) => e.event.kind);
    expect(kinds).toEqual(['agent.text', 'agent.tool_call', 'agent.tool_result', 'usage']);
    expect(log.events[3]!.event).toMatchObject({
      usage: { estimatedCostUsd: 0.0123, source: 'claude_code_result', model: 'claude-opus-5-5' },
    });
  });
});
