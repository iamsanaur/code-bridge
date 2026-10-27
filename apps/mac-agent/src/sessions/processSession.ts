import type { LocalMode } from '@codebridge/protocol';
import type { Workspace } from '../config.js';
import { spawnProcess, type ProcHandle } from '../process/backend.js';
import { BaseSession, SessionError, type EventSink } from './base.js';

const TERMINATE_GRACE_MS = 5_000;
const COALESCE_MS = 16;

/** A PTY (or pipe) process: preset commands, approved custom commands, or an interactive shell. */
export class ProcessSession extends BaseSession {
  private proc: ProcHandle | null = null;
  private killedByUser = false;
  private pendingOut = new Map<'pty' | 'stdout' | 'stderr', string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private maxTimer: NodeJS.Timeout | null = null;

  constructor(
    id: string,
    workspace: Workspace,
    mode: LocalMode,
    sink: EventSink,
    private readonly spawnOpts: {
      file: string;
      args: string[];
      env: NodeJS.ProcessEnv;
      cols: number;
      rows: number;
      pty: boolean;
      label: string;
      maxMinutes: number;
    },
  ) {
    super(id, workspace, mode, sink);
  }

  async start(): Promise<void> {
    const o = this.spawnOpts;
    this.emitOutput('system', `$ ${o.label}\r\n`);
    const proc = spawnProcess({
      file: o.file,
      args: o.args,
      cwd: this.workspace.path,
      env: o.env,
      cols: o.cols,
      rows: o.rows,
      pty: o.pty,
    });
    this.proc = proc;
    proc.onData((data, stream) => this.buffer(stream, data));
    proc.onExit(({ exitCode, signal }) => {
      this.flush();
      if (this.maxTimer) clearTimeout(this.maxTimer);
      const status = this.killedByUser ? 'killed' : exitCode === 0 ? 'completed' : 'failed';
      this.setStatus(status, {
        exitCode,
        signal,
        message: `Process exited${exitCode !== null ? ` with code ${exitCode}` : ''}${signal ? ` (${signal})` : ''}`,
      });
      this.proc = null;
    });
    this.maxTimer = setTimeout(() => {
      this.emitOutput(
        'system',
        `\r\n[CodeBridge] Maximum session duration (${o.maxMinutes} min) reached; stopping.\r\n`,
      );
      this.signal('terminate');
    }, o.maxMinutes * 60_000);
    this.maxTimer.unref();
    this.setStatus('running', {
      message: proc.isPty ? undefined : 'Running without a TTY (node-pty unavailable)',
    });
  }

  private buffer(stream: 'pty' | 'stdout' | 'stderr', data: string): void {
    this.pendingOut.set(stream, (this.pendingOut.get(stream) ?? '') + data);
    if ((this.pendingOut.get(stream)?.length ?? 0) > 16_384) return this.flush();
    this.flushTimer ??= setTimeout(() => this.flush(), COALESCE_MS);
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const [stream, data] of this.pendingOut) if (data) this.emitOutput(stream, data);
    this.pendingOut.clear();
  }

  override input(data: string): void {
    if (!this.proc) throw new SessionError('not_running', 'The process has exited');
    this.proc.write(data);
  }

  override resize(cols: number, rows: number): void {
    this.proc?.resize(cols, rows);
  }

  signal(kind: 'interrupt' | 'terminate'): void {
    const proc = this.proc;
    if (!proc) return;
    if (kind === 'interrupt') {
      if (proc.isPty) proc.write('\x03');
      else proc.kill('SIGINT');
      return;
    }
    this.killedByUser = true;
    proc.kill('SIGTERM');
    const t = setTimeout(() => this.proc?.kill('SIGKILL'), TERMINATE_GRACE_MS);
    t.unref();
  }

  dispose(): void {
    this.killedByUser = true;
    this.proc?.kill('SIGKILL');
  }
}
