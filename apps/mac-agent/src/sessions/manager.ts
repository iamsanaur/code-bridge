import { existsSync } from 'node:fs';
import { LIMITS, type AgentCommand, type SequencedEvent } from '@codebridge/protocol';
import type { AgentConfig, Workspace } from '../config.js';
import { AgentSession, sdkMessagesClient, type MessagesClient } from '../coding/agentSession.js';
import { ClaudeCodeSession, findClaudeCli } from '../coding/claudeCodeSession.js';
import { gitDiff, gitStatus } from '../git.js';
import { createProject, ProjectError } from '../projects.js';
import { browseFolders, prepareExistingWorkspace } from '../folders.js';
import { PathError, prepareWorkspace, workspaceInfo } from '../workspaces.js';
import type { Logger } from '../log.js';
import { buildChildEnv, classifyCommand, resolveExecutable } from '../policy.js';
import { defaultShell } from '../platform.js';
import { loadPty } from '../process/backend.js';
import type { SecretStore } from '../secrets.js';
import { BaseSession, SessionError } from './base.js';
import { ProcessSession } from './processSession.js';

export interface Ack {
  ok: boolean;
  error?: { code: string; message: string };
  result?: unknown;
}

export interface ManagerDeps {
  getConfig: () => AgentConfig;
  /** Persists a workspace created from the phone. */
  addWorkspace?: (ws: Workspace) => Promise<void>;
  secrets: SecretStore;
  /** Delivers a sequenced event towards the relay. */
  sink: (ev: SequencedEvent) => void;
  log: Logger;
  messagesClientFactory?: (apiKey: string) => MessagesClient;
  now?: () => number;
}

/**
 * Executes relay commands against local policy. The relay is trusted to have
 * authenticated the device owner, but *not* trusted for policy: every command is
 * re-validated here against the Mac's own configuration (workspace allowlist,
 * presets, custom-command and shell switches, deny lists).
 */
/** A phone cannot grow the workspace list without bound. */
const MAX_WORKSPACES = 100;

export class SessionManager {
  private readonly sessions = new Map<string, BaseSession>();
  private readonly acks = new Map<string, Ack>();
  /** serverTime - localTime, learned from server.hello; used for the replay window. */
  serverOffsetMs = 0;

  constructor(private readonly deps: ManagerDeps) {}

  private get now() {
    return (this.deps.now ?? Date.now)();
  }

  snapshot() {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.id,
      status: s.status,
      lastSeq: s.lastSeq,
    }));
  }

  activeCount(): number {
    return [...this.sessions.values()].filter((s) => !s.isFinished).length;
  }

  /** Events with seq > `after` for every live session (used to re-send after a reconnect). */
  eventsSince(delivered: Map<string, number>, overlap: number): SequencedEvent[] {
    const out: SequencedEvent[] = [];
    for (const s of this.sessions.values()) {
      const from = Math.max(0, (delivered.get(s.id) ?? 0) - overlap);
      if (from < s.lastSeq) out.push(...s.eventsSince(from));
    }
    return out;
  }

  async handle(commandId: string, issuedAt: number, command: AgentCommand): Promise<Ack> {
    const cached = this.acks.get(commandId);
    if (cached) return cached; // duplicate delivery: never execute twice
    const age = Math.abs(this.now + this.serverOffsetMs - issuedAt);
    if (age > LIMITS.commandMaxAgeMs) {
      return {
        ok: false,
        error: { code: 'stale_command', message: 'Command is outside the replay window' },
      };
    }
    let ack: Ack;
    try {
      ack = { ok: true, result: await this.execute(command) };
    } catch (err) {
      const e =
        err instanceof SessionError
          ? err
          : new SessionError('internal', (err as Error).message ?? 'Unexpected error');
      if (!(err instanceof SessionError))
        this.deps.log.error('command failed', { op: command.op, error: e.message });
      ack = { ok: false, error: { code: e.code, message: e.message.slice(0, 1000) } };
    }
    // Replay commands are idempotent reads; don't cache them.
    if (command.op !== 'session.replay') {
      this.acks.set(commandId, ack);
      if (this.acks.size > 10_000) this.acks.delete(this.acks.keys().next().value!);
    }
    return ack;
  }

  private workspace(id: string): Workspace {
    const ws = this.deps.getConfig().workspaces.find((w) => w.id === id);
    if (!ws) throw new SessionError('not_found', 'Workspace is not authorized on this Mac');
    if (!existsSync(ws.path))
      throw new SessionError('not_found', 'Workspace directory no longer exists');
    return ws;
  }

  private session(id: string): BaseSession {
    const s = this.sessions.get(id);
    if (!s)
      throw new SessionError(
        'not_found',
        'Session not found on this Mac (it may have been lost when the agent restarted)',
      );
    return s;
  }

  private async execute(c: AgentCommand): Promise<unknown> {
    switch (c.op) {
      case 'session.start':
        return this.start(c);
      case 'session.input':
        this.session(c.sessionId).input(c.data);
        return undefined;
      case 'session.resize':
        this.session(c.sessionId).resize(c.cols, c.rows);
        return undefined;
      case 'session.signal':
        this.session(c.sessionId).signal(c.signal);
        return undefined;
      case 'agent.prompt':
        this.session(c.sessionId).prompt(c.text);
        return undefined;
      case 'approval.respond':
        this.session(c.sessionId).respondApproval(c.approvalId, c.decision);
        return undefined;
      case 'session.replay': {
        const { events, oldestAvailableSeq } = this.session(c.sessionId).replay(c.afterSeq);
        for (const ev of events) this.deps.sink(ev);
        return { oldestAvailableSeq, replayed: events.length };
      }
      case 'workspace.create':
        return this.createWorkspace(c);
      case 'workspace.browse':
        return this.browse(c);
      case 'workspace.add':
        return this.addExisting(c);
      case 'git.status':
        return gitStatus(this.workspace(c.workspaceId), this.deps.getConfig().policy).catch(
          (e: Error) => {
            throw new SessionError('git_error', e.message.split('\n')[0] ?? 'git failed');
          },
        );
      case 'git.diff':
        return gitDiff(this.workspace(c.workspaceId), this.deps.getConfig().policy, c.path).catch(
          (e: Error) => {
            throw new SessionError(
              e.name === 'PathError' || (e as { code?: string }).code === 'path_denied'
                ? 'path_denied'
                : 'git_error',
              e.message.split('\n')[0] ?? 'git failed',
            );
          },
        );
    }
  }

  private requireFolderBrowse() {
    const config = this.deps.getConfig();
    if (!config.policy.allowFolderBrowse || !this.deps.addWorkspace)
      throw new SessionError(
        'policy_denied',
        'Picking existing folders from the phone is turned off on this computer. Turn it on with `codebridge-agent policy set allowFolderBrowse true`.',
      );
    return config;
  }

  private async browse(c: Extract<AgentCommand, { op: 'workspace.browse' }>) {
    this.requireFolderBrowse();
    try {
      return await browseFolders(c.path);
    } catch (err) {
      if (err instanceof PathError) throw new SessionError('path_denied', err.message);
      throw err;
    }
  }

  private async addExisting(c: Extract<AgentCommand, { op: 'workspace.add' }>) {
    const config = this.requireFolderBrowse();
    try {
      const { ws, added } = await prepareExistingWorkspace(c.path, config.workspaces);
      if (added) {
        if (config.workspaces.length >= MAX_WORKSPACES)
          throw new SessionError('limit', `This computer already has ${MAX_WORKSPACES} workspaces`);
        await this.deps.addWorkspace!(ws);
        this.deps.log.info('existing folder added from the phone', { name: ws.name });
      }
      return { workspace: workspaceInfo(ws) };
    } catch (err) {
      if (err instanceof PathError) throw new SessionError('path_denied', err.message);
      throw err;
    }
  }

  private async createWorkspace(c: Extract<AgentCommand, { op: 'workspace.create' }>) {
    const config = this.deps.getConfig();
    if (!config.policy.allowWorkspaceCreation || !this.deps.addWorkspace) {
      throw new SessionError(
        'policy_denied',
        'Creating projects from the phone is turned off on this computer. Turn it on with `codebridge-agent policy set allowWorkspaceCreation true`.',
      );
    }
    if (config.workspaces.length >= MAX_WORKSPACES)
      throw new SessionError('limit', `This computer already has ${MAX_WORKSPACES} workspaces`);
    try {
      const { dir, gitInit } = await createProject({
        policy: config.policy,
        name: c.name,
        gitInit: c.gitInit,
      });
      const ws = await prepareWorkspace(dir);
      await this.deps.addWorkspace(ws);
      this.deps.log.info('project created from the phone', { name: ws.name });
      return { workspace: workspaceInfo(ws), gitInit };
    } catch (err) {
      if (err instanceof ProjectError) throw new SessionError(err.code, err.message);
      throw err;
    }
  }

  private async start(
    c: Extract<AgentCommand, { op: 'session.start' }>,
  ): Promise<{ sessionId: string }> {
    if (this.sessions.has(c.sessionId)) return { sessionId: c.sessionId }; // idempotent
    const cfg = this.deps.getConfig();
    const policy = cfg.policy;
    if (this.activeCount() >= policy.maxConcurrentSessions) {
      throw new SessionError(
        'limit',
        `At most ${policy.maxConcurrentSessions} sessions can run at once on this Mac`,
      );
    }
    const ws = this.workspace(c.workspaceId);
    const sink = this.deps.sink;
    let session: BaseSession;

    switch (c.mode) {
      case 'command': {
        let argv: string[];
        let label: string;
        if (c.presetId) {
          const preset = policy.presets.find((p) => p.id === c.presetId);
          if (!preset) throw new SessionError('not_found', 'Unknown preset');
          argv = preset.argv;
          label = preset.argv.join(' ');
        } else if (c.argv) {
          if (!policy.allowCustomCommands) {
            throw new SessionError(
              'policy_denied',
              'Custom commands are disabled on this Mac. Enable with `codebridge-agent policy set allowCustomCommands true`.',
            );
          }
          const verdict = classifyCommand(c.argv);
          if (verdict.decision === 'deny') throw new SessionError('policy_denied', verdict.reason);
          if (verdict.decision === 'confirm' && !c.confirmedRisk)
            throw new SessionError('requires_confirmation', verdict.reason);
          argv = c.argv;
          label = c.argv.join(' ');
        } else {
          throw new SessionError('invalid', 'Choose a preset or a command');
        }
        const env = buildChildEnv(policy);
        const file = resolveExecutable(argv[0]!, env.PATH!);
        if (!file)
          throw new SessionError('not_found', `${argv[0]} was not found on this Mac's PATH`);
        session = new ProcessSession(c.sessionId, ws, 'command', sink, {
          file,
          args: argv.slice(1),
          env,
          cols: c.cols,
          rows: c.rows,
          pty: true,
          label,
          maxMinutes: policy.maxSessionMinutes,
        });
        break;
      }
      case 'shell': {
        if (!policy.allowInteractiveShell) {
          throw new SessionError(
            'policy_denied',
            'Interactive shells are disabled on this computer. Enable with `codebridge-agent policy set allowInteractiveShell true`.',
          );
        }
        const shell = defaultShell();
        session = new ProcessSession(c.sessionId, ws, 'shell', sink, {
          file: shell.file,
          args: shell.args,
          env: buildChildEnv(policy),
          cols: c.cols,
          rows: c.rows,
          pty: true,
          label: [shell.file, ...shell.args].join(' '),
          maxMinutes: policy.maxSessionMinutes,
        });
        break;
      }
      case 'agent': {
        const key = await this.deps.secrets.get('anthropic-api-key');
        if (!key)
          throw new SessionError(
            'anthropic_key_missing',
            'No Anthropic API key on this Mac. Run `codebridge-agent credentials set` on the Mac.',
          );
        const client = (this.deps.messagesClientFactory ?? sdkMessagesClient)(key);
        session = new AgentSession(
          c.sessionId,
          ws,
          sink,
          { config: cfg, model: c.model, client },
          c.prompt,
        );
        break;
      }
      case 'claude_code': {
        if (!policy.allowClaudeCode)
          throw new SessionError('policy_denied', 'Claude Code sessions are disabled on this Mac');
        const cli = findClaudeCli(policy);
        if (!cli)
          throw new SessionError(
            'unavailable',
            'The Claude Code CLI (`claude`) is not installed on this Mac',
          );
        session = new ClaudeCodeSession(c.sessionId, ws, sink, cfg, cli, c.prompt);
        break;
      }
    }
    this.sessions.set(c.sessionId, session);
    try {
      await session.start();
    } catch (err) {
      session.setStatus('failed', { message: (err as Error).message });
      throw new SessionError('start_failed', (err as Error).message);
    }
    this.deps.log.info('session started', {
      sessionId: c.sessionId,
      mode: c.mode,
      workspace: ws.id,
    });
    this.prune();
    return { sessionId: c.sessionId };
  }

  /** Keeps finished sessions for replay for a while, then forgets them. */
  private prune(): void {
    const finished = [...this.sessions.values()].filter((s) => s.isFinished);
    if (finished.length <= 50) return;
    for (const s of finished.slice(0, finished.length - 50)) this.sessions.delete(s.id);
  }

  capabilities() {
    const policy = this.deps.getConfig().policy;
    return {
      pty: loadPty() !== null,
      allowCustomCommands: policy.allowCustomCommands,
      allowInteractiveShell: policy.allowInteractiveShell,
      canCreateWorkspaces: policy.allowWorkspaceCreation,
      canBrowseFolders: policy.allowFolderBrowse,
      claudeCodeAvailable: policy.allowClaudeCode && findClaudeCli(policy) !== null,
    };
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) if (!s.isFinished) s.dispose();
  }
}
