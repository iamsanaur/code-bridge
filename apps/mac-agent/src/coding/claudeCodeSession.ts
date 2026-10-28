import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { redactSecrets } from '@codebridge/shared';
import type { AgentConfig, Workspace } from '../config.js';
import { buildChildEnv, resolveExecutable } from '../policy.js';
import {
  claudeFallbackDirs,
  killTree,
  platformSpawnOptions,
  prepareClaudeSpawn,
} from '../platform.js';
import { BaseSession, SessionError, type EventSink } from '../sessions/base.js';
import { assessToolRequest, PermissionBridge, type PermissionVerdict } from './permissions.js';

/**
 * LocalClaudeCodeProvider: drives the user's installed Claude Code CLI in its
 * documented headless mode (`claude -p … --output-format stream-json`).
 *
 * - Authentication is whatever the CLI itself is logged in with on this Mac.
 *   CodeBridge never reads, copies or forwards Claude Code credentials, and does
 *   not pass its own Anthropic API key to the CLI.
 * - Tool permissions are governed by Claude Code's own settings for the project.
 *   CodeBridge never passes --dangerously-skip-permissions. With `allowClaudeCodeEdits`
 *   (the default) it passes `--permission-mode acceptEdits`, so file edits inside the
 *   project go through; anything else that would need an interactive approval is
 *   declined by the CLI in headless mode.
 * - This is a new CLI session in the workspace, not a connection to any existing
 *   Claude.ai or Claude Code session.
 */
export function findClaudeCli(policy: AgentConfig['policy']): string | null {
  const pathVar = buildChildEnv(policy).PATH!;
  return (
    resolveExecutable('claude', pathVar) ??
    // Native installer location, which is not always on the service's PATH.
    resolveExecutable('claude', claudeFallbackDirs().join(path.delimiter))
  );
}

interface StreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: Array<Record<string, unknown>> };
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  model?: string;
  is_error?: boolean;
  result?: string;
}

export class ClaudeCodeSession extends BaseSession {
  private child: ChildProcess | null = null;
  private cliSessionId: string | null = null;
  private model = 'claude-code';
  private ended = false;
  private bridge: PermissionBridge | null = null;
  private launching = false;

  constructor(
    id: string,
    workspace: Workspace,
    sink: EventSink,
    private readonly config: AgentConfig,
    private readonly cliPath: string,
    private readonly initialPrompt?: string,
  ) {
    super(id, workspace, 'claude_code', sink);
  }

  async start(): Promise<void> {
    this.setStatus('idle', {
      message: 'Claude Code (headless) ready. Uses the CLI’s own login on this Mac.',
    });
    if (this.initialPrompt) this.prompt(this.initialPrompt);
  }

  /** Puts one of Claude Code's permission requests to the phone and returns its answer. */
  private async askPhone(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionVerdict> {
    const assessed = assessToolRequest(toolName, input);
    if ('deny' in assessed) return { behavior: 'deny', message: assessed.deny };
    const decision = await this.approvals.request(assessed.ask);
    return decision === 'approved'
      ? { behavior: 'allow', updatedInput: input }
      : {
          behavior: 'deny',
          message:
            decision === 'rejected'
              ? 'The user rejected this on their phone. Do not retry it; ask what they want instead.'
              : 'The user did not answer in time. Do not retry it.',
        };
  }

  override prompt(text: string): void {
    if (this.ended) throw new SessionError('session_ended', 'This session has ended');
    if (this.child || this.launching)
      throw new SessionError('busy', 'Claude Code is still working on the previous prompt');
    this.emit({ kind: 'user.prompt', text });
    this.launching = true;
    this.setStatus('running');
    void this.launch(text).finally(() => {
      this.launching = false;
    });
  }

  private async launch(text: string): Promise<void> {
    const args = ['-p', text, '--output-format', 'stream-json', '--verbose'];
    if (this.config.policy.allowClaudeCodeEdits) args.push('--permission-mode', 'acceptEdits');
    if (this.config.policy.allowClaudeCodeApprovals) {
      try {
        this.bridge ??= new PermissionBridge((tool, input) => this.askPhone(tool, input));
        await this.bridge.start();
        args.push(
          '--mcp-config',
          this.bridge.mcpConfig(process.argv[1] ?? ''),
          '--permission-prompt-tool',
          'mcp__codebridge__approve',
        );
      } catch {
        // Without the bridge Claude Code still runs; it just declines what it would have asked about.
      }
    }
    if (this.ended) return;
    if (this.cliSessionId) args.push('--resume', this.cliSessionId);
    let target;
    try {
      target = prepareClaudeSpawn(this.cliPath, args);
    } catch (err) {
      this.emit({
        kind: 'error',
        code: 'claude_cli_error',
        message: (err as Error).message,
        retryable: false,
      });
      this.setStatus('idle');
      return;
    }
    const child = spawn(target.file, target.args, {
      cwd: this.workspace.path,
      env: buildChildEnv(this.config.policy),
      stdio: ['ignore', 'pipe', 'pipe'],
      ...platformSpawnOptions(),
    });
    this.child = child;
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => this.handleLine(line));
    let stderr = '';
    child.stderr!.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-4000);
    });
    child.on('error', (err) => {
      this.emit({
        kind: 'error',
        code: 'claude_cli_error',
        message: err.message,
        retryable: false,
      });
    });
    child.on('close', (code) => {
      this.child = null;
      if (code !== 0 && !this.ended) {
        this.emit({
          kind: 'error',
          code: 'claude_cli_exit',
          message: redactSecrets(`claude exited with code ${code}. ${stderr.trim()}`).slice(
            0,
            1900,
          ),
          retryable: true,
        });
      }
      this.emit({ kind: 'agent.turn_end', stopReason: code === 0 ? 'end_turn' : 'error' });
      if (!this.ended) this.setStatus('idle');
    });
  }

  /** Exposed for tests. */
  handleLine(line: string): void {
    let msg: StreamLine;
    try {
      msg = JSON.parse(line) as StreamLine;
    } catch {
      return; // non-JSON noise
    }
    if (msg.session_id) this.cliSessionId = msg.session_id;
    if (msg.type === 'system' && msg.subtype === 'init' && msg.model) this.model = msg.model;
    if (msg.type === 'assistant') {
      for (const b of msg.message?.content ?? []) {
        if (b.type === 'text' && typeof b.text === 'string')
          this.emit({ kind: 'agent.text', delta: (b.text as string).slice(0, 32_000) });
        if (b.type === 'tool_use') {
          this.emit({
            kind: 'agent.tool_call',
            toolUseId: String(b.id ?? ''),
            name: String(b.name ?? 'tool'),
            summary: redactSecrets(JSON.stringify(b.input ?? {})).slice(0, 3900),
          });
        }
      }
    }
    if (msg.type === 'user') {
      for (const b of msg.message?.content ?? []) {
        if (b.type === 'tool_result') {
          const content =
            typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
          this.emit({
            kind: 'agent.tool_result',
            toolUseId: String(b.tool_use_id ?? ''),
            ok: !b.is_error,
            summary: redactSecrets(content).slice(0, 7900),
          });
        }
      }
    }
    if (msg.type === 'result') {
      const u = msg.usage ?? {};
      this.emit({
        kind: 'usage',
        usage: {
          model: this.model,
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          // As reported by Claude Code; subscription plans are not billed per token.
          estimatedCostUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
          source: 'claude_code_result',
        },
      });
      if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
        this.emit({
          kind: 'error',
          code: msg.subtype ?? 'error',
          message: redactSecrets(msg.result ?? 'Claude Code reported an error').slice(0, 1900),
          retryable: true,
        });
      }
    }
  }

  private kill(sig: NodeJS.Signals): void {
    const c = this.child;
    if (!c?.pid) return;
    killTree(c.pid, sig, (s) => c.kill(s));
  }

  signal(kind: 'interrupt' | 'terminate'): void {
    if (kind === 'interrupt') return this.kill('SIGINT');
    this.ended = true;
    this.approvals.cancelAll();
    this.bridge?.close();
    this.kill('SIGTERM');
    this.setStatus('completed', { message: 'Session ended' });
  }

  dispose(): void {
    this.ended = true;
    this.approvals.cancelAll();
    this.bridge?.close();
    this.kill('SIGKILL');
    this.setStatus('killed');
  }
}
