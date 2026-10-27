import Anthropic from '@anthropic-ai/sdk';
import { estimateCostUsd, redactSecrets } from '@codebridge/shared';
import type { Usage } from '@codebridge/protocol';
import type { AgentConfig, Workspace } from '../config.js';
import { BaseSession, SessionError, type EventSink } from '../sessions/base.js';
import { runTool, TOOL_DEFINITIONS } from './tools.js';

/**
 * The minimal Messages API surface the agent loop needs. The real implementation
 * is the official SDK (`client.beta.messages.stream`); tests inject a fake.
 */
export interface MessagesClient {
  stream(
    params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
    options: { signal: AbortSignal },
  ): {
    on(event: 'text', cb: (delta: string) => void): unknown;
    finalMessage(): Promise<Anthropic.Beta.Messages.BetaMessage>;
  };
}

export function sdkMessagesClient(apiKey: string): MessagesClient {
  // maxRetries: the SDK retries 408/409/429/5xx and connection errors with backoff.
  const client = new Anthropic({ apiKey, maxRetries: 3, timeout: 10 * 60_000 });
  return {
    stream: (params, options) => client.beta.messages.stream(params, { signal: options.signal }),
  };
}

const SYSTEM_PROMPT = (
  ws: Workspace,
) => `You are CodeBridge's coding agent, running on the user's own Mac inside the project "${ws.name}".
The user is supervising from a phone, so keep messages short and skimmable.

Rules:
- All file paths are relative to the workspace root. You cannot access anything outside it.
- Use the tools to inspect and change the project. Prefer edit_file for small changes.
- run_command takes an argv array and runs without a shell. Commands that are not pre-approved need the user's approval; if one is rejected, do not retry it, ask instead.
- File writes and edits require the user's approval. Explain briefly what you are about to change before calling write_file/edit_file.
- Never try to read credentials, keys or .env files unless the user asked you to.
- When you finish, summarise what changed and what (if anything) the user should verify.`;

export interface AgentSessionOptions {
  config: AgentConfig;
  model?: string;
  client: MessagesClient;
}

/**
 * A coding-agent session driven by the Anthropic Messages API with client-side
 * tools. The loop is bounded (turns per prompt, wall clock per prompt), cancellable,
 * and every tool runs through workspace confinement + approval checks.
 *
 * The API key never leaves this process: it is read from the Keychain on the Mac
 * and is never sent through the relay.
 */
export class AgentSession extends BaseSession {
  private readonly messages: Anthropic.Beta.Messages.BetaMessageParam[] = [];
  private readonly queue: string[] = [];
  private running = false;
  private abort: AbortController | null = null;
  private disposed = false;
  private readonly model: string;
  private totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  constructor(
    id: string,
    workspace: Workspace,
    sink: EventSink,
    private readonly opts: AgentSessionOptions,
    private readonly initialPrompt?: string,
  ) {
    super(id, workspace, 'agent', sink);
    this.model = opts.model ?? opts.config.codingAgent.model;
  }

  async start(): Promise<void> {
    this.setStatus('idle', { message: `Coding agent ready (${this.model})` });
    if (this.initialPrompt) this.prompt(this.initialPrompt);
  }

  override prompt(text: string): void {
    if (this.disposed || this.isFinished)
      throw new SessionError('session_ended', 'This session has ended');
    if (this.queue.length >= 5)
      throw new SessionError('queue_full', 'Too many queued prompts; wait for the agent to finish');
    this.queue.push(text);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.disposed) {
        const text = this.queue.shift()!;
        this.emit({ kind: 'user.prompt', text });
        await this.runPrompt(text);
      }
    } finally {
      this.running = false;
    }
  }

  private async runPrompt(text: string): Promise<void> {
    const cfg = this.opts.config.codingAgent;
    const promptIndex = this.messages.push({ role: 'user', content: text }) - 1;
    const abort = new AbortController();
    this.abort = abort;
    const deadline = setTimeout(
      () => abort.abort(new Error('prompt_timeout')),
      cfg.maxPromptMinutes * 60_000,
    );
    this.setStatus('running');
    let stopReason = 'end_turn';
    try {
      for (let turn = 0; ; turn++) {
        if (abort.signal.aborted) throw abort.signal.reason ?? new Error('cancelled');
        if (turn >= cfg.maxTurnsPerPrompt) {
          stopReason = 'max_turns';
          this.emit({
            kind: 'error',
            code: 'max_turns',
            message: `Stopped after ${cfg.maxTurnsPerPrompt} model turns. Send another prompt to continue.`,
            retryable: true,
          });
          // Keep the history valid: the last message is tool results; add a user nudge next time.
          break;
        }
        const msg = await this.callModel(abort.signal);
        this.messages.push({ role: 'assistant', content: msg.content });
        stopReason = msg.stop_reason ?? 'end_turn';

        if (msg.stop_reason === 'refusal') {
          this.emit({
            kind: 'error',
            code: 'refusal',
            message: 'The model declined this request.',
            retryable: false,
          });
          break;
        }
        if (msg.stop_reason === 'pause_turn') continue;

        const toolUses = msg.content.filter(
          (b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use',
        );
        if (toolUses.length === 0) break;
        if (msg.stop_reason === 'max_tokens') {
          // A tool input cut off at max_tokens can parse as a valid partial object: never run it.
          this.messages.push({
            role: 'user',
            content: toolUses.map((t) => ({
              type: 'tool_result' as const,
              tool_use_id: t.id,
              is_error: true,
              content: 'Tool input was truncated (max_tokens); not executed.',
            })),
          });
          continue;
        }

        const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
        for (const t of toolUses) {
          if (abort.signal.aborted) {
            results.push({
              type: 'tool_result',
              tool_use_id: t.id,
              is_error: true,
              content: 'Cancelled by the user.',
            });
            continue;
          }
          this.emit({
            kind: 'agent.tool_call',
            toolUseId: t.id,
            name: t.name,
            summary: redactSecrets(JSON.stringify(t.input)).slice(0, 3900),
          });
          const r = await runTool(t.name, t.input, {
            workspace: this.workspace,
            config: this.opts.config,
            signal: abort.signal,
            requestApproval: async (req) => {
              const d = await this.approvals.request(req);
              return d === 'approved';
            },
          });
          this.emit({
            kind: 'agent.tool_result',
            toolUseId: t.id,
            ok: r.ok,
            summary: r.summary.slice(0, 7900),
          });
          results.push({
            type: 'tool_result',
            tool_use_id: t.id,
            content: r.content,
            ...(r.ok ? {} : { is_error: true }),
          });
        }
        // All results for one assistant turn go back in a single user message.
        this.messages.push({ role: 'user', content: results });
      }
    } catch (err) {
      stopReason = this.reportError(err, abort.signal, promptIndex);
    } finally {
      clearTimeout(deadline);
      this.abort = null;
      this.approvals.cancelAll();
    }
    this.emit({ kind: 'agent.turn_end', stopReason });
    if (!this.disposed) this.setStatus('idle');
  }

  private async callModel(signal: AbortSignal): Promise<Anthropic.Beta.Messages.BetaMessage> {
    const cfg = this.opts.config.codingAgent;
    const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: 64_000,
      system: SYSTEM_PROMPT(this.workspace),
      tools: TOOL_DEFINITIONS.map((t) => ({
        ...t,
        input_schema: t.input_schema as Anthropic.Beta.Messages.BetaTool.InputSchema,
        eager_input_streaming: true,
      })),
      messages: this.messages,
      output_config: { effort: cfg.effort },
      cache_control: { type: 'ephemeral' },
      ...(cfg.serverFallbacks
        ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
        : {}),
    };
    const stream = this.opts.client.stream(params, { signal });
    stream.on('text', (delta) => this.emit({ kind: 'agent.text', delta }));
    const msg = await stream.finalMessage();
    this.recordUsage(msg);
    return msg;
  }

  private recordUsage(msg: Anthropic.Beta.Messages.BetaMessage): void {
    const u = msg.usage;
    this.totals.inputTokens += u.input_tokens ?? 0;
    this.totals.outputTokens += u.output_tokens ?? 0;
    this.totals.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    this.totals.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
    const usage: Usage = {
      model: msg.model ?? this.model,
      ...this.totals,
      estimatedCostUsd: estimateCostUsd(this.model, this.totals),
      source: 'anthropic_usage',
    };
    this.emit({ kind: 'usage', usage });
  }

  /** Maps errors to user-facing session events; returns the stop reason to report. */
  private reportError(err: unknown, signal: AbortSignal, promptIndex: number): string {
    // Keep the history valid (append-only) for the next prompt.
    const last = this.messages[this.messages.length - 1];
    if (this.messages.length - 1 === promptIndex) {
      this.messages.pop(); // the prompt never got a response; drop it
    } else if (last?.role === 'assistant' && Array.isArray(last.content)) {
      const pending = last.content.filter(
        (b) => b.type === 'tool_use',
      ) as Anthropic.Beta.Messages.BetaToolUseBlock[];
      if (pending.length) {
        this.messages.push({
          role: 'user',
          content: pending.map((t) => ({
            type: 'tool_result' as const,
            tool_use_id: t.id,
            is_error: true,
            content: 'Interrupted before this tool ran.',
          })),
        });
      }
    }
    if (signal.aborted) {
      const timedOut = signal.reason instanceof Error && signal.reason.message === 'prompt_timeout';
      this.emit({
        kind: 'error',
        code: timedOut ? 'timeout' : 'cancelled',
        message: timedOut ? 'The prompt exceeded its time limit and was stopped.' : 'Cancelled.',
        retryable: true,
      });
      return timedOut ? 'timeout' : 'cancelled';
    }
    if (err instanceof Anthropic.AuthenticationError) {
      this.emit({
        kind: 'error',
        code: 'invalid_api_key',
        message:
          'Anthropic rejected the API key stored on this Mac. Run `codebridge-agent credentials set`.',
        retryable: false,
      });
      return 'error';
    }
    if (err instanceof Anthropic.RateLimitError) {
      this.emit({
        kind: 'error',
        code: 'rate_limited',
        message: 'Anthropic rate limit reached after retries. Wait a moment and try again.',
        retryable: true,
      });
      return 'error';
    }
    if (err instanceof Anthropic.APIError) {
      const retryable = (err.status ?? 500) >= 500 || err.status === 408 || err.status === 409;
      this.emit({
        kind: 'error',
        code: `api_${err.status ?? 'error'}`,
        message: redactSecrets(err.message).slice(0, 500),
        retryable,
      });
      return 'error';
    }
    this.emit({
      kind: 'error',
      code: 'agent_error',
      message: redactSecrets((err as Error)?.message ?? String(err)).slice(0, 500),
      retryable: true,
    });
    return 'error';
  }

  signal(kind: 'interrupt' | 'terminate'): void {
    this.queue.length = 0;
    this.abort?.abort(new Error('cancelled'));
    this.approvals.cancelAll();
    if (kind === 'terminate') {
      this.disposed = true;
      this.setStatus('completed', { message: 'Session ended' });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.abort?.abort(new Error('cancelled'));
    this.approvals.cancelAll();
    this.setStatus('killed');
  }
}
